//! Flatten a form: every visible widget's normal appearance (the state its
//! /AS names) becomes page content, then widgets, fields, /AcroForm and
//! /XFA are removed, with the document scripts that drove the fields.
//! Other annotations stay.

use super::MAX_DEPTH;
use super::tree::read_form;
use crate::annotations::widget_placement;
use crate::page_content::fmt_num;
use crate::rebuild::{deref, name_of};
use crate::stamp::page_writer::DocWriter;
use lopdf::{Document, Object, ObjectId};
use std::collections::HashSet;

/// What one page draws and keeps.
struct PagePlan {
    page: ObjectId,
    /// Appearance XObject and `cm` per visible widget, in /Annots order.
    draws: Vec<(ObjectId, [f64; 6])>,
    /// /Annots without widgets.
    kept: Vec<Object>,
    /// Widget annotations taken out of /Annots (indirect ones).
    removed: Vec<ObjectId>,
}

/// None when the page has no /Annots array.
fn plan_page(doc: &Document, page: ObjectId) -> Option<PagePlan> {
    let dict = doc.get_dictionary(page).ok()?;
    let entries = dict.get(b"Annots").ok().and_then(|a| deref(doc, a))?.as_array().ok()?;
    let mut plan = PagePlan { page, draws: Vec::new(), kept: Vec::new(), removed: Vec::new() };
    for entry in entries {
        let widget = deref(doc, entry)
            .and_then(|a| a.as_dict().ok())
            .filter(|a| name_of(a, b"Subtype") == Some(b"Widget"));
        let Some(annot) = widget else {
            plan.kept.push(entry.clone());
            continue;
        };
        if let Ok(id) = entry.as_reference() {
            plan.removed.push(id);
        }
        if let Some((Object::Reference(appearance), cm)) = widget_placement(doc, annot) {
            plan.draws.push((*appearance, cm));
        }
    }
    Some(plan)
}

/// The catalog, every page and every page tree node above them: never
/// deleted, whatever a malformed field tree points at.
fn document_structure(doc: &Document, pages: &[ObjectId]) -> HashSet<ObjectId> {
    let mut keep: HashSet<ObjectId> = doc.trailer.get(b"Root").ok().and_then(|r| r.as_reference().ok()).into_iter().collect();
    for &page in pages {
        let mut current = page;
        for _ in 0..=MAX_DEPTH {
            if !keep.insert(current) {
                break;
            }
            match doc.get_dictionary(current).ok().and_then(|d| d.get(b"Parent").ok()) {
                Some(Object::Reference(parent)) => current = *parent,
                _ => break,
            }
        }
    }
    keep
}

/// Terminal fields and their widgets. Their ancestors are left to
/// `prune_objects`: once /AcroForm and the kids are gone nothing refers to
/// them.
fn form_objects(doc: &Document) -> Result<HashSet<ObjectId>, String> {
    let tree = read_form(doc)?;
    let mut objects = HashSet::new();
    for field in &tree.refs {
        objects.insert(field.obj);
        objects.extend(field.widgets.iter().map(|w| w.obj));
    }
    Ok(objects)
}

/// An action, or a chain of them (/Next: one action or an array), that runs
/// JavaScript somewhere. Bounded and cycle-safe.
fn runs_javascript(doc: &Document, action: &Object, seen: &mut HashSet<ObjectId>, depth: usize) -> bool {
    if depth > MAX_DEPTH {
        return false;
    }
    if let Object::Reference(id) = action
        && !seen.insert(*id)
    {
        return false;
    }
    match deref(doc, action) {
        Some(Object::Dictionary(d)) => {
            name_of(d, b"S") == Some(b"JavaScript")
                || d.get(b"Next").is_ok_and(|next| runs_javascript(doc, next, seen, depth + 1))
        }
        Some(Object::Array(items)) => items.iter().any(|a| runs_javascript(doc, a, seen, depth + 1)),
        _ => false,
    }
}

/// Document scripts aimed at the fields that no longer exist: a JavaScript
/// /OpenAction (or a chain holding one), /Names /JavaScript, catalog and
/// page /AA. Everything else stays.
fn remove_document_scripts(doc: &mut Document, root: ObjectId, pages: &[ObjectId]) {
    let Ok(catalog) = doc.get_dictionary(root) else {
        return;
    };
    let open_js = catalog.get(b"OpenAction").is_ok_and(|a| runs_javascript(doc, a, &mut HashSet::new(), 0));
    let names_ref = catalog.get(b"Names").ok().and_then(|n| n.as_reference().ok());
    if let Ok(catalog) = doc.get_dictionary_mut(root) {
        if open_js {
            catalog.remove(b"OpenAction");
        }
        catalog.remove(b"AA");
        if let Ok(Object::Dictionary(names)) = catalog.get_mut(b"Names") {
            names.remove(b"JavaScript");
        }
    }
    if let Some(id) = names_ref
        && let Ok(names) = doc.get_dictionary_mut(id)
    {
        names.remove(b"JavaScript");
    }
    for &page in pages {
        if let Ok(dict) = doc.get_dictionary_mut(page) {
            dict.remove(b"AA");
        }
    }
}

/// Flatten every widget of `doc` (filled or not) into its page.
pub(crate) fn flatten_document(doc: &mut Document) -> Result<(), String> {
    let mut doomed = form_objects(doc)?;
    let pages: Vec<ObjectId> = doc.get_pages().into_values().collect();
    let structure = document_structure(doc, &pages);
    let plans: Vec<PagePlan> = pages.iter().filter_map(|&p| plan_page(doc, p)).collect();
    // Widgets on pages but outside /Fields go too (with their /AA).
    doomed.extend(plans.iter().flat_map(|p| p.removed.iter().copied()));

    let mut writer = DocWriter::new();
    for plan in plans {
        if !plan.draws.is_empty() {
            let mut page = writer.page(doc, plan.page)?;
            for (appearance, cm) in &plan.draws {
                let name = page.xobject_with_prefix(*appearance, "Fw");
                let cm = cm.map(fmt_num).join(" ");
                page.ops.extend_from_slice(format!("q {cm} cm /").as_bytes());
                page.ops.extend_from_slice(&name);
                page.ops.extend_from_slice(b" Do Q\n");
            }
            page.finish(doc, &mut writer)?;
        }
        if let Ok(dict) = doc.get_dictionary_mut(plan.page) {
            if plan.kept.is_empty() {
                dict.remove(b"Annots");
            } else {
                dict.set("Annots", plan.kept);
            }
        }
    }

    // The form itself: catalog entries, then every terminal field and every
    // widget object (a reference left elsewhere, say a structure element,
    // becomes null on save), so no field /AA action survives. The catalog
    // and the page tree are never deleted.
    if let Some(root) = doc.trailer.get(b"Root").ok().and_then(|r| r.as_reference().ok()) {
        let form_ref = doc
            .get_dictionary(root)
            .ok()
            .and_then(|c| c.get(b"AcroForm").ok())
            .and_then(|f| f.as_reference().ok());
        if let Some(id) = form_ref {
            doc.objects.remove(&id);
        }
        if let Ok(catalog) = doc.get_dictionary_mut(root) {
            catalog.remove(b"AcroForm");
            catalog.remove(b"NeedsRendering");
        }
        remove_document_scripts(doc, root, &pages);
    }
    for id in doomed.difference(&structure) {
        doc.objects.remove(id);
    }
    doc.prune_objects();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forms::fill::fill_form;
    use crate::forms::tree::tests::{base, finish, rect, states, widget, with};
    use crate::forms::{Value, list_form};
    use crate::pdf_util::{load_pdf, save_pdf};
    use lopdf::{Dictionary, Stream, dictionary};

    fn ap_stream(doc: &mut Document, bbox: [i64; 4], matrix: Option<Vec<Object>>, body: &[u8]) -> ObjectId {
        let mut d = dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => rect(bbox) };
        if let Some(m) = matrix {
            d.set("Matrix", m);
        }
        doc.add_object(Stream::new(d, body.to_vec()))
    }

    fn page_dict(doc: &Document, page: ObjectId) -> &Dictionary {
        doc.get_dictionary(page).unwrap()
    }

    /// The drawing stream (last content item) and the page XObject names.
    fn drawing(doc: &Document, page: ObjectId) -> (String, Dictionary) {
        let contents = page_dict(doc, page).get(b"Contents").unwrap().as_array().unwrap();
        let last = contents.last().unwrap().as_reference().unwrap();
        let s = doc.get_object(last).unwrap().as_stream().unwrap();
        let text = String::from_utf8_lossy(&s.decompressed_content().unwrap_or_else(|_| s.content.clone())).into_owned();
        let res = page_dict(doc, page).get(b"Resources").unwrap().as_dict().unwrap();
        (text, res.get(b"XObject").unwrap().as_dict().unwrap().clone())
    }

    fn xobject(names: &Dictionary, name: &str) -> ObjectId {
        names.get(name.as_bytes()).unwrap().as_reference().unwrap()
    }

    fn text_widget(doc: &mut Document, page: ObjectId, name: &str, r: [i64; 4], ap: ObjectId, extra: Vec<(&str, Object)>) -> ObjectId {
        let mut entries = vec![
            ("FT", "Tx".into()),
            ("T", Object::string_literal(name)),
            ("AP", dictionary! { "N" => ap }.into()),
        ];
        entries.extend(extra);
        doc.add_object(with(widget(page, r), entries))
    }

    #[test]
    fn widgets_drawn_at_their_rects_and_form_removed() {
        let (mut doc, page) = base(0);
        let content = doc.add_object(Stream::new(dictionary! {}, b"0 0 m 10 10 l S".to_vec()));
        doc.get_dictionary_mut(page).unwrap().set("Contents", content);
        let plain = ap_stream(&mut doc, [0, 0, 200, 20], None, b"(a) Tj");
        // BBox offset: [10 10 60 30] onto [100 100 150 120].
        let offset = ap_stream(&mut doc, [10, 10, 60, 30], None, b"(b) Tj");
        // Matrix quarter turn: BBox [0 0 20 10] becomes x -10..0, y 0..20.
        let turned = ap_stream(&mut doc, [0, 0, 20, 10], Some(vec![0.into(), 1.into(), (-1).into(), 0.into(), 0.into(), 0.into()]), b"(c) Tj");
        let a = text_widget(&mut doc, page, "a", [100, 700, 300, 720], plain, vec![("AA", dictionary! { "K" => dictionary! { "S" => "JavaScript" } }.into())]);
        let b = text_widget(&mut doc, page, "b", [100, 100, 150, 120], offset, vec![]);
        let c = text_widget(&mut doc, page, "c", [0, 0, 10, 20], turned, vec![]);
        let hidden_ap = ap_stream(&mut doc, [0, 0, 10, 10], None, b"(h) Tj");
        let hidden = text_widget(&mut doc, page, "h", [0, 0, 10, 10], hidden_ap, vec![("F", 2.into())]);
        let link = doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Link", "Rect" => rect([0, 0, 5, 5]),
            "A" => dictionary! { "S" => "URI", "URI" => Object::string_literal("https://example.com") },
        });
        let comment = doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Text", "Rect" => rect([5, 5, 10, 10]), "Contents" => Object::string_literal("note"),
        });
        finish(&mut doc, page, &[a, b, c, hidden], &[link, a, b, comment, c, hidden], vec![("XFA", Object::Array(vec![]))]);
        flatten_document(&mut doc).unwrap();

        let root = doc.trailer.get(b"Root").unwrap().as_reference().unwrap();
        assert!(!doc.get_dictionary(root).unwrap().has(b"AcroForm"));
        let annots = page_dict(&doc, page).get(b"Annots").unwrap().as_array().unwrap();
        assert_eq!(annots, &vec![Object::Reference(link), Object::Reference(comment)]);
        let (ops, names) = drawing(&doc, page);
        assert_eq!(
            ops,
            "\nQ\nq 1 0 0 1 100 700 cm /Fw1 Do Q\nq 1 0 0 1 90 90 cm /Fw2 Do Q\nq 1 0 0 1 10 0 cm /Fw3 Do Q\n"
        );
        assert_eq!((xobject(&names, "Fw1"), xobject(&names, "Fw2"), xobject(&names, "Fw3")), (plain, offset, turned));
        assert!(!names.has(b"Fw4"));
        // The original content is wrapped in q ... Q.
        let contents = page_dict(&doc, page).get(b"Contents").unwrap().as_array().unwrap();
        assert_eq!(contents.len(), 3);
        assert_eq!(contents[1], Object::Reference(content));
        // Fields, widgets (with their /AA) and the hidden widget's appearance are gone.
        for id in [a, b, c, hidden, hidden_ap] {
            assert!(doc.get_object(id).is_err(), "{id:?}");
        }
        assert!(doc.objects.values().all(|o| match o {
            Object::Dictionary(d) => !d.has(b"AA") && !d.has(b"FT"),
            _ => true,
        }));
    }

    #[test]
    fn rotated_page_uses_user_space_rect() {
        let (mut doc, page) = base(90);
        let ap = ap_stream(&mut doc, [0, 0, 50, 20], None, b"");
        let w = text_widget(&mut doc, page, "r", [100, 200, 150, 220], ap, vec![]);
        finish(&mut doc, page, &[w], &[w], vec![]);
        flatten_document(&mut doc).unwrap();
        let (ops, _) = drawing(&doc, page);
        assert_eq!(ops, "q 1 0 0 1 100 200 cm /Fw1 Do Q\n");
        assert!(!page_dict(&doc, page).has(b"Annots"));
        assert_eq!(page_dict(&doc, page).get(b"Rotate").unwrap(), &Object::Integer(90));
    }

    #[test]
    fn off_checkbox_drawn_with_its_off_appearance() {
        let (mut doc, page) = base(0);
        let ap = states(&mut doc, &["On", "Off"]);
        let off = ap.as_dict().unwrap().get(b"N").unwrap().as_dict().unwrap().get(b"Off").unwrap().as_reference().unwrap();
        if let Ok(Object::Stream(s)) = doc.get_object_mut(off) {
            s.dict.set("BBox", rect([0, 0, 10, 10]));
        }
        let cb = doc.add_object(with(widget(page, [0, 0, 10, 10]), vec![
            ("FT", "Btn".into()), ("T", Object::string_literal("cb")), ("AP", ap), ("AS", "Off".into()),
        ]));
        finish(&mut doc, page, &[cb], &[cb], vec![]);
        flatten_document(&mut doc).unwrap();
        let (ops, names) = drawing(&doc, page);
        assert_eq!(ops, "q 1 0 0 1 0 0 cm /Fw1 Do Q\n");
        assert_eq!(xobject(&names, "Fw1"), off);
    }

    #[test]
    fn fill_then_flatten_draws_the_new_appearances() {
        let (mut doc, page) = base(0);
        let t = doc.add_object(with(widget(page, [100, 700, 300, 720]), vec![
            ("FT", "Tx".into()), ("T", Object::string_literal("t")), ("DA", Object::string_literal("/Helv 12 Tf 0 g")),
        ]));
        let cb = doc.add_object(with(widget(page, [0, 0, 20, 20]), vec![
            ("FT", "Btn".into()), ("T", Object::string_literal("cb")),
        ]));
        let link = doc.add_object(dictionary! { "Type" => "Annot", "Subtype" => "Link", "Rect" => rect([0, 0, 5, 5]) });
        finish(&mut doc, page, &[t, cb], &[t, cb, link], vec![]);
        let pdf = save_pdf(&mut doc).unwrap();
        let out = fill_form(&pdf, &[(0, Value::Text("Hello".into())), (1, Value::Names(vec!["Yes".into()]))], true).unwrap();
        assert!(list_form(&out).unwrap().fields.is_empty());
        let out = load_pdf(&out).unwrap();
        let page = *out.get_pages().get(&1).unwrap();
        let (ops, names) = drawing(&out, page);
        assert_eq!(ops, "q 1 0 0 1 100 700 cm /Fw1 Do Q\nq 1 0 0 1 0 0 cm /Fw2 Do Q\n");
        let text = out.get_object(xobject(&names, "Fw1")).unwrap().as_stream().unwrap();
        assert!(String::from_utf8_lossy(&text.content).contains("(Hello) Tj"));
        let check = out.get_object(xobject(&names, "Fw2")).unwrap().as_stream().unwrap();
        assert!(String::from_utf8_lossy(&check.content).contains(" l\nS\n"));
        assert_eq!(page_dict(&out, page).get(b"Annots").unwrap().as_array().unwrap().len(), 1);
        let root = out.trailer.get(b"Root").unwrap().as_reference().unwrap();
        assert!(!out.get_dictionary(root).unwrap().has(b"AcroForm"));
    }

    #[test]
    fn page_without_widgets_is_untouched() {
        let (mut doc, page) = base(0);
        let other = doc.add_object(dictionary! { "Type" => "Annot", "Subtype" => "Text", "Rect" => rect([0, 0, 5, 5]) });
        finish(&mut doc, page, &[], &[other], vec![]);
        let before = page_dict(&doc, page).clone();
        flatten_document(&mut doc).unwrap();
        assert_eq!(page_dict(&doc, page), &before);
    }

    #[test]
    fn parent_pointing_at_the_page_tree_never_deletes_pages() {
        let (mut doc, page) = base(0);
        let pages_id = page_dict(&doc, page).get(b"Parent").unwrap().as_reference().unwrap();
        let ap = ap_stream(&mut doc, [0, 0, 50, 20], None, b"(a) Tj");
        // Field "a" (its /Parent wrongly the page tree root) with one widget kid.
        let field = doc.new_object_id();
        let w = doc.add_object(with(widget(page, [100, 200, 150, 220]), vec![
            ("Parent", field.into()), ("AP", dictionary! { "N" => ap }.into()),
        ]));
        doc.objects.insert(field, Object::Dictionary(dictionary! {
            "FT" => "Tx", "T" => Object::string_literal("a"), "Kids" => vec![w.into()], "Parent" => pages_id,
        }));
        finish(&mut doc, page, &[field], &[w], vec![]);
        flatten_document(&mut doc).unwrap();
        assert_eq!(doc.get_pages().len(), 1);
        assert!(doc.get_object(pages_id).is_ok());
        let (ops, _) = drawing(&doc, page);
        assert_eq!(ops, "q 1 0 0 1 100 200 cm /Fw1 Do Q\n");
        assert!(doc.get_object(w).is_err() && doc.get_object(field).is_err());
        let saved = save_pdf(&mut doc).unwrap();
        assert_eq!(load_pdf(&saved).unwrap().get_pages().len(), 1);
    }

    #[test]
    fn orphan_widget_with_actions_is_deleted_even_if_referenced() {
        let (mut doc, page) = base(0);
        let ap = ap_stream(&mut doc, [0, 0, 10, 10], None, b"");
        let orphan = doc.add_object(with(widget(page, [0, 0, 10, 10]), vec![
            ("AP", dictionary! { "N" => ap }.into()),
            ("AA", dictionary! { "U" => dictionary! { "S" => "JavaScript", "JS" => Object::string_literal("app.alert(1)") } }.into()),
        ]));
        finish(&mut doc, page, &[], &[orphan], vec![]);
        // A structure element still points at it.
        let root = doc.trailer.get(b"Root").unwrap().as_reference().unwrap();
        let tree_root = doc.add_object(dictionary! {
            "Type" => "StructTreeRoot",
            "K" => dictionary! { "Type" => "StructElem", "S" => "Form", "K" => dictionary! { "Type" => "OBJR", "Obj" => orphan } },
        });
        doc.get_dictionary_mut(root).unwrap().set("StructTreeRoot", tree_root);
        flatten_document(&mut doc).unwrap();
        assert!(doc.get_object(orphan).is_err());
        assert_eq!(drawing(&doc, page).0, "q 1 0 0 1 0 0 cm /Fw1 Do Q\n");
        let saved = save_pdf(&mut doc).unwrap();
        let out = load_pdf(&saved).unwrap();
        assert!(out.objects.values().all(|o| match o {
            Object::Dictionary(d) => !d.has(b"AA") && d.get(b"Subtype").ok() != Some(&Object::Name(b"Widget".to_vec())),
            _ => true,
        }));
    }

    fn js(code: &str) -> Object {
        Object::Dictionary(dictionary! { "S" => "JavaScript", "JS" => Object::string_literal(code) })
    }

    /// A one-field form whose catalog and page carry scripts; `open` is the /OpenAction.
    fn scripted(open: Object) -> (Document, ObjectId, ObjectId) {
        let (mut doc, page) = base(0);
        let ap = ap_stream(&mut doc, [0, 0, 10, 10], None, b"");
        let w = text_widget(&mut doc, page, "a", [0, 0, 10, 10], ap, vec![]);
        finish(&mut doc, page, &[w], &[w], vec![]);
        let names = doc.add_object(dictionary! {
            "JavaScript" => dictionary! { "Names" => vec![Object::string_literal("x"), js("this.getField('a')")] },
            "Dests" => dictionary! {},
        });
        let root = doc.trailer.get(b"Root").unwrap().as_reference().unwrap();
        let catalog = doc.get_dictionary_mut(root).unwrap();
        catalog.set("OpenAction", open);
        catalog.set("Names", names);
        catalog.set("AA", dictionary! { "WC" => js("1") });
        catalog.set("PageMode", "UseOutlines");
        doc.get_dictionary_mut(page).unwrap().set("AA", dictionary! { "O" => js("2") });
        (doc, root, page)
    }

    #[test]
    fn flatten_removes_document_scripts_only() {
        // Chain: GoTo then JavaScript through /Next.
        let chain = Object::Dictionary(dictionary! {
            "S" => "GoTo", "D" => vec![Object::Integer(0), "Fit".into()], "Next" => vec![js("app.alert(1)")],
        });
        let (mut doc, root, page) = scripted(chain);
        let names = doc.get_dictionary(root).unwrap().get(b"Names").unwrap().as_reference().unwrap();
        let mut unflattened = doc.clone();
        flatten_document(&mut doc).unwrap();
        let catalog = doc.get_dictionary(root).unwrap();
        assert!(!catalog.has(b"OpenAction") && !catalog.has(b"AA"));
        assert_eq!(catalog.get(b"PageMode").unwrap(), &Object::Name(b"UseOutlines".to_vec()));
        let names = doc.get_dictionary(names).unwrap();
        assert!(!names.has(b"JavaScript") && names.has(b"Dests"));
        assert!(!page_dict(&doc, page).has(b"AA"));

        // A plain destination /OpenAction stays.
        let (mut doc, root, _) = scripted(Object::Array(vec![Object::Integer(0), "Fit".into()]));
        flatten_document(&mut doc).unwrap();
        assert!(doc.get_dictionary(root).unwrap().has(b"OpenAction"));

        // Filling without flattening keeps them all.
        crate::forms::fill::fill_document(&mut unflattened, &[]).unwrap();
        let catalog = unflattened.get_dictionary(root).unwrap();
        assert!(catalog.has(b"OpenAction") && catalog.has(b"AA"));
        assert!(page_dict(&unflattened, page).has(b"AA"));
    }

    #[test]
    fn script_chains_are_bounded() {
        let (mut doc, _) = base(0);
        let a = doc.new_object_id();
        doc.objects.insert(a, Object::Dictionary(dictionary! { "S" => "GoTo", "Next" => a }));
        assert!(!runs_javascript(&doc, &Object::Reference(a), &mut HashSet::new(), 0));
        let mut deep = js("x");
        for _ in 0..40 {
            deep = Object::Dictionary(dictionary! { "S" => "GoTo", "Next" => deep });
        }
        assert!(!runs_javascript(&doc, &deep, &mut HashSet::new(), 0));
        assert!(runs_javascript(&doc, &Object::Array(vec![Object::Null, js("y")]), &mut HashSet::new(), 0));
    }

    #[test]
    fn rotated_widget_flattened_in_place() {
        let (mut doc, page) = base(0);
        let w = doc.add_object(with(widget(page, [100, 600, 120, 700]), vec![
            ("FT", "Tx".into()), ("T", Object::string_literal("r")), ("DA", Object::string_literal("/Helv 10 Tf 0 g")),
            ("MK", dictionary! { "R" => 90 }.into()),
        ]));
        finish(&mut doc, page, &[w], &[w], vec![]);
        crate::forms::fill::fill_document(&mut doc, &[(0, Value::Text("Up".into()))]).unwrap();
        flatten_document(&mut doc).unwrap();
        let (ops, names) = drawing(&doc, page);
        // The appearance's /Matrix turns its 100 x 20 box onto the 20 x 100 rect.
        assert_eq!(ops, "q 1 0 0 1 100 600 cm /Fw1 Do Q\n");
        let ap = doc.get_object(xobject(&names, "Fw1")).unwrap().as_stream().unwrap();
        let m: Vec<f32> = ap.dict.get(b"Matrix").unwrap().as_array().unwrap().iter().map(|v| v.as_float().unwrap()).collect();
        assert_eq!(m, vec![0.0, 1.0, -1.0, 0.0, 20.0, 0.0]);
        assert!(String::from_utf8_lossy(&ap.content).contains("(Up) Tj"));
    }
}
