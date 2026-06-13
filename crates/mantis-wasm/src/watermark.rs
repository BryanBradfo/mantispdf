use crate::pdf_util::get_inherited_attr;
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use std::f64::consts::PI;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn add_watermark(
    pdf_bytes: &[u8],
    text: &str,
    font_size: u32,
    opacity: f32,
    angle_deg: i32,
    r: f32,
    g: f32,
    b: f32,
) -> Result<Vec<u8>, JsValue> {
    add_watermark_impl(pdf_bytes, text, font_size, opacity, angle_deg, r, g, b)
        .map_err(|e| JsValue::from_str(&e))
}

#[allow(clippy::too_many_arguments)]
fn add_watermark_impl(
    pdf_bytes: &[u8],
    text: &str,
    font_size: u32,
    opacity: f32,
    angle_deg: i32,
    r: f32,
    g: f32,
    b: f32,
) -> Result<Vec<u8>, String> {
    let mut doc = Document::load_mem(pdf_bytes).map_err(|e| e.to_string())?;

    let page_ids: Vec<ObjectId> = doc.get_pages().values().copied().collect();

    for page_id in page_ids {
        let (width, height) = page_size(&doc, page_id);
        let cx = width / 2.0;
        let cy = height / 2.0;

        let page_rot = page_rotation(&doc, page_id);
        let draw_angle_rad = ((angle_deg + page_rot) as f64) * PI / 180.0;
        let cos_a = draw_angle_rad.cos();
        let sin_a = draw_angle_rad.sin();

        // Shift text origin backwards along the text direction so the string
        // straddles the page centre, then lift slightly above the baseline.
        let half_width = (text.chars().count() as f64) * (font_size as f64) * 0.55 / 2.0;
        let tx = cx - half_width * cos_a + (-sin_a) * (font_size as f64) * 0.2;
        let ty = cy - half_width * sin_a + cos_a * (font_size as f64) * 0.2;

        let content = wm_content(text, font_size, cos_a, sin_a, tx, ty, r, g, b);
        let stream_id = doc.add_object(Object::Stream(Stream::new(Dictionary::new(), content)));

        let font_id = doc.add_object(helvetica_font());
        let gs_id = doc.add_object(opacity_gs(opacity));

        push_content_stream(&mut doc, page_id, stream_id);
        patch_resources(&mut doc, page_id, font_id, gs_id);
    }

    let mut buf = Vec::new();
    doc.save_to(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

fn page_rotation(doc: &Document, page_id: ObjectId) -> i32 {
    // /Rotate is inheritable from an intermediate /Pages node.
    match get_inherited_attr(doc, page_id, b"Rotate") {
        Some(Object::Integer(r)) => ((r % 360 + 360) % 360) as i32,
        _ => 0,
    }
}

fn obj_num(o: &Object) -> f64 {
    match o {
        Object::Integer(i) => *i as f64,
        Object::Real(f) => *f as f64,
        _ => 0.0,
    }
}

fn page_size(doc: &Document, page_id: ObjectId) -> (f64, f64) {
    // /MediaBox is inheritable from an intermediate /Pages node; resolve it
    // rather than reading the leaf only (else inherited pages get the default).
    let Some(Object::Array(a)) = get_inherited_attr(doc, page_id, b"MediaBox") else {
        return (612.0, 792.0);
    };
    if a.len() < 4 {
        return (612.0, 792.0);
    }
    (
        (obj_num(&a[2]) - obj_num(&a[0])).max(1.0),
        (obj_num(&a[3]) - obj_num(&a[1])).max(1.0),
    )
}

fn wm_content(
    text: &str,
    font_size: u32,
    cos_a: f64,
    sin_a: f64,
    tx: f64,
    ty: f64,
    r: f32,
    g: f32,
    b: f32,
) -> Vec<u8> {
    let escaped = text
        .replace('\\', "\\\\")
        .replace('(', "\\(")
        .replace(')', "\\)");
    format!(
        "q\n/WMgs gs\n{r:.4} {g:.4} {b:.4} rg\nBT\n/WMfont {fs} Tf\n{ma:.6} {mb:.6} {mc:.6} {md:.6} {me:.2} {mf:.2} Tm\n({esc}) Tj\nET\nQ\n",
        r = r, g = g, b = b,
        fs = font_size,
        ma = cos_a,
        mb = sin_a,
        mc = -sin_a,
        md = cos_a,
        me = tx,
        mf = ty,
        esc = escaped,
    )
    .into_bytes()
}

fn helvetica_font() -> Object {
    let mut d = Dictionary::new();
    d.set("Type", Object::Name(b"Font".to_vec()));
    d.set("Subtype", Object::Name(b"Type1".to_vec()));
    d.set("BaseFont", Object::Name(b"Helvetica".to_vec()));
    Object::Dictionary(d)
}

fn opacity_gs(opacity: f32) -> Object {
    let mut d = Dictionary::new();
    d.set("Type", Object::Name(b"ExtGState".to_vec()));
    d.set("ca", Object::Real(opacity));
    d.set("CA", Object::Real(opacity));
    Object::Dictionary(d)
}

/// Append a new content stream reference to the page's /Contents entry.
fn push_content_stream(doc: &mut Document, page_id: ObjectId, stream_id: ObjectId) {
    let current = match doc.objects.get(&page_id) {
        Some(Object::Dictionary(d)) => d.get(b"Contents").ok().cloned(),
        _ => return,
    };
    let new_contents = match current {
        None => Object::Array(vec![Object::Reference(stream_id)]),
        Some(Object::Reference(id)) => {
            Object::Array(vec![Object::Reference(id), Object::Reference(stream_id)])
        }
        Some(Object::Array(mut arr)) => {
            arr.push(Object::Reference(stream_id));
            Object::Array(arr)
        }
        Some(other) => Object::Array(vec![other, Object::Reference(stream_id)]),
    };
    if let Some(Object::Dictionary(d)) = doc.objects.get_mut(&page_id) {
        d.set("Contents", new_contents);
    }
}

/// Add /WMfont and /WMgs to the page's Resources, handling inline and referenced dicts.
fn patch_resources(doc: &mut Document, page_id: ObjectId, font_id: ObjectId, gs_id: ObjectId) {
    let res_ref = match doc.objects.get(&page_id) {
        Some(Object::Dictionary(d)) => match d.get(b"Resources") {
            Ok(Object::Reference(id)) => Some(*id),
            _ => None,
        },
        _ => None,
    };

    if let Some(res_id) = res_ref {
        // Resources is an indirect object — clone, update, reinsert
        let mut res = match doc.objects.get(&res_id) {
            Some(Object::Dictionary(d)) => d.clone(),
            _ => Dictionary::new(),
        };
        inject_wm_res(&mut res, font_id, gs_id);
        doc.objects.insert(res_id, Object::Dictionary(res));
    } else {
        // Resources is inline on the leaf, inherited from /Pages, or absent.
        // Seed from the inherited Resources (if any) so the page's existing
        // fonts/xobjects survive being written inline — otherwise a fresh empty
        // dict would shadow the inherited one and the original content loses its
        // resources. Then inject ours and write it inline on the leaf.
        let has_inline = matches!(
            doc.objects.get(&page_id),
            Some(Object::Dictionary(d)) if matches!(d.get(b"Resources"), Ok(Object::Dictionary(_)))
        );
        let mut res = if has_inline {
            match doc.objects.get(&page_id) {
                Some(Object::Dictionary(d)) => match d.get(b"Resources") {
                    Ok(Object::Dictionary(r)) => r.clone(),
                    _ => Dictionary::new(),
                },
                _ => return,
            }
        } else {
            match get_inherited_attr(doc, page_id, b"Resources") {
                Some(Object::Dictionary(r)) => r,
                Some(Object::Reference(rid)) => {
                    doc.get_dictionary(rid).ok().cloned().unwrap_or_else(Dictionary::new)
                }
                _ => Dictionary::new(),
            }
        };
        inject_wm_res(&mut res, font_id, gs_id);
        if let Some(Object::Dictionary(d)) = doc.objects.get_mut(&page_id) {
            d.set("Resources", Object::Dictionary(res));
        }
    }
}

fn inject_wm_res(res: &mut Dictionary, font_id: ObjectId, gs_id: ObjectId) {
    let mut font_dict = match res.get(b"Font") {
        Ok(Object::Dictionary(d)) => d.clone(),
        _ => Dictionary::new(),
    };
    font_dict.set("WMfont", Object::Reference(font_id));
    res.set("Font", Object::Dictionary(font_dict));

    let mut gs_dict = match res.get(b"ExtGState") {
        Ok(Object::Dictionary(d)) => d.clone(),
        _ => Dictionary::new(),
    };
    gs_dict.set("WMgs", Object::Reference(gs_id));
    res.set("ExtGState", Object::Dictionary(gs_dict));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdf_util::make_inherited_test_pdf_sized;

    #[test]
    fn test_page_size_resolves_inherited_mediabox() {
        // Pages inherit MediaBox from /Pages; page_size must resolve it, not
        // fall back to the 612x792 default.
        let pdf = make_inherited_test_pdf_sized(1, 842, 1190);
        let doc = Document::load_mem(&pdf).unwrap();
        let pid = *doc.get_pages().get(&1).unwrap();
        let (w, h) = page_size(&doc, pid);
        assert_eq!((w, h), (842.0, 1190.0));
    }

    #[test]
    fn test_watermark_preserves_inherited_resources() {
        // The fixture's pages inherit /Resources (with font /F1) from /Pages.
        // After watermarking, each page must carry an inline /Resources whose
        // /Font dict contains BOTH the original /F1 and the watermark /WMfont.
        let pdf = make_inherited_test_pdf_sized(2, 612, 792);
        let out = add_watermark_impl(&pdf, "CONFIDENTIAL", 48, 0.3, 45, 0.5, 0.5, 0.5)
            .expect("watermark should succeed on an inheritance-based PDF");
        let doc = Document::load_mem(&out).unwrap();
        assert_eq!(doc.get_pages().len(), 2);
        for (_, page_id) in doc.get_pages() {
            let page = doc.get_dictionary(page_id).unwrap();
            let res = page
                .get(b"Resources")
                .expect("watermarked page must carry an inline Resources dict");
            let res = match res {
                Object::Dictionary(d) => d.clone(),
                Object::Reference(id) => doc.get_dictionary(*id).unwrap().clone(),
                _ => panic!("Resources must be a dict or reference"),
            };
            let fonts = res
                .get(b"Font")
                .and_then(Object::as_dict)
                .expect("Resources must have a /Font dict");
            assert!(
                fonts.get(b"WMfont").is_ok(),
                "watermark font /WMfont must be registered"
            );
            assert!(
                fonts.get(b"F1").is_ok(),
                "inherited original font /F1 must be preserved, not shadowed"
            );
        }
    }
}
