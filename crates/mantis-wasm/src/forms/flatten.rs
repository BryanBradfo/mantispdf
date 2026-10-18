//! Flatten a form: every visible widget's normal appearance (the state its
//! /AS names) becomes page content, then widgets, fields, /AcroForm and
//! /XFA are removed. Other annotations stay.

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
    /// /Annots without widgets; None when the page has no /Annots array.
    kept: Option<Vec<Object>>,
}

fn is_widget(doc: &Document, entry: &Object) -> bool {
    deref(doc, entry)
        .and_then(|a| a.as_dict().ok())
        .is_some_and(|a| name_of(a, b"Subtype") == Some(b"Widget"))
}

fn plan_page(doc: &Document, page: ObjectId) -> Option<PagePlan> {
    let dict = doc.get_dictionary(page).ok()?;
    let entries = dict.get(b"Annots").ok().and_then(|a| deref(doc, a))?.as_array().ok()?;
    let mut draws = Vec::new();
    let mut kept = Vec::new();
    for entry in entries {
        if !is_widget(doc, entry) {
            kept.push(entry.clone());
            continue;
        }
        let Some(annot) = deref(doc, entry).and_then(|a| a.as_dict().ok()) else {
            continue;
        };
        if let Some((Object::Reference(appearance), cm)) = widget_placement(doc, annot) {
            draws.push((*appearance, cm));
        }
    }
    Some(PagePlan { page, draws, kept: Some(kept) })
}

/// Every object of the field tree: terminal fields, their widgets and their
/// ancestors (bounded /Parent chains).
fn form_objects(doc: &Document) -> Result<HashSet<ObjectId>, String> {
    let tree = read_form(doc)?;
    let mut objects = HashSet::new();
    for field in &tree.refs {
        objects.extend(field.widgets.iter().map(|w| w.obj));
        let mut current = field.obj;
        for _ in 0..=MAX_DEPTH {
            if !objects.insert(current) {
                break;
            }
            match doc.get_dictionary(current).ok().and_then(|d| d.get(b"Parent").ok()) {
                Some(Object::Reference(parent)) => current = *parent,
                _ => break,
            }
        }
    }
    Ok(objects)
}

/// Flatten every widget of `doc` (filled or not) into its page.
pub(crate) fn flatten_document(doc: &mut Document) -> Result<(), String> {
    let form = form_objects(doc)?;
    let pages: Vec<ObjectId> = doc.get_pages().into_values().collect();
    let plans: Vec<PagePlan> = pages.iter().filter_map(|&p| plan_page(doc, p)).collect();

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
        if let (Some(kept), Ok(dict)) = (plan.kept, doc.get_dictionary_mut(plan.page)) {
            if kept.is_empty() {
                dict.remove(b"Annots");
            } else {
                dict.set("Annots", kept);
            }
        }
    }

    // The form itself: catalog entries, then every field and widget object
    // (a reference left elsewhere, say a structure element, becomes null on
    // save), so no field /AA action survives.
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
    }
    for id in form {
        doc.objects.remove(&id);
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
}
