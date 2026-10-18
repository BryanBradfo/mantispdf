//! Text removal: show operators rewritten so removed glyphs disappear and
//! every kept glyph stays exactly where it was.
//!
//! The distance removed text covered is never written per glyph: it is
//! carried, across removed shows and the operators between them that do not
//! position text, to the next kept glyph and written there as ONE TJ
//! number (in that show's font size and scaling). A positioning operator
//! (`Td`, `TD`, `Tm`, `T*`, `'`, `"`, `BT`) or the end of the content drops
//! it: nothing depends on it then.

use super::Unsupported;
use super::interp::Glyph;
use lopdf::Object;
use lopdf::content::Operation;
use std::collections::BTreeMap;

/// Largest TJ adjustment written (thousandths of text space).
const MAX_ADJUSTMENT: f64 = 1e15;

/// What `rewrite_text` changed.
#[derive(Debug, Default)]
pub(crate) struct TextEdits {
    /// Replacement operators per original op index.
    pub(crate) replaced: BTreeMap<usize, Vec<Operation>>,
    /// Glyphs no longer drawn.
    pub(crate) removed: usize,
}

/// True for operators that set the text position afresh.
fn repositions(op: &str) -> bool {
    matches!(op, "Td" | "TD" | "Tm" | "T*" | "'" | "\"" | "BT")
}

/// Rewrite the show operators of `ops` so the glyphs flagged `true` in
/// `glyphs` (every glyph event, in content order) disappear.
pub(crate) fn rewrite_text(ops: &[Operation], glyphs: &[(&Glyph, bool)]) -> Result<TextEdits, Unsupported> {
    if glyphs.iter().any(|(g, removed)| *removed && g.render_mode >= 4) {
        // Clipping text (Tr 4-7) shapes what is drawn after it: removing a
        // glyph would change the clip, keeping it keeps its outline.
        return Err(Unsupported::new("clipping text under a redaction area"));
    }
    let mut by_op: BTreeMap<usize, Vec<(&Glyph, bool)>> = BTreeMap::new();
    for &(g, removed) in glyphs {
        by_op.entry(g.op_index).or_default().push((g, removed));
    }
    let mut edits = TextEdits::default();
    // Text-space distance of removed text not yet written.
    let mut carry = 0.0;
    for (index, op) in ops.iter().enumerate() {
        if repositions(&op.operator) {
            carry = 0.0;
        }
        let Some(shown) = by_op.get(&index) else {
            continue;
        };
        let removing = shown.iter().any(|(_, removed)| *removed);
        if !removing && carry == 0.0 {
            continue;
        }
        let rewrite = rewrite_show(op, shown, carry)?;
        if rewrite.dropped_whole {
            let moves = shown.iter().any(|(g, _)| g.advance() != 0.0);
            if moves && later_text_depends(ops, index) {
                return Err(Unsupported::new("zero-size text under a redaction area moves later text"));
            }
            edits.removed += shown.len();
        } else {
            edits.removed += shown.iter().filter(|(_, removed)| *removed).count();
        }
        carry = rewrite.carry;
        edits.replaced.insert(index, rewrite.ops);
    }
    Ok(edits)
}

/// One element of a rewritten TJ array.
enum Item {
    Text(Vec<u8>, lopdf::StringFormat),
    Number(f64),
}

struct ShowRewrite {
    ops: Vec<Operation>,
    /// Distance left to write before the next kept glyph.
    carry: f64,
    /// The show went entirely (font size or scaling 0).
    dropped_whole: bool,
}

/// `op` (`Tj`, `TJ`, `'` or `"`) without its removed glyphs, starting with
/// `carry` (text space) still to move before its first kept glyph.
fn rewrite_show(op: &Operation, shown: &[(&Glyph, bool)], carry: f64) -> Result<ShowRewrite, Unsupported> {
    let malformed = || Unsupported(format!("cannot rewrite {}", op.operator));
    let mut out = Vec::new();
    let elements: Vec<Object> = match (op.operator.as_str(), op.operands.as_slice()) {
        ("TJ", [Object::Array(items)]) => items.clone(),
        ("Tj", [s]) => vec![s.clone()],
        ("'", [s]) => {
            out.push(Operation::new("T*", vec![]));
            vec![s.clone()]
        }
        ("\"", [aw, ac, s]) => {
            out.push(Operation::new("Tw", vec![aw.clone()]));
            out.push(Operation::new("Tc", vec![ac.clone()]));
            out.push(Operation::new("T*", vec![]));
            vec![s.clone()]
        }
        _ => return Err(malformed()),
    };
    let (first, _) = shown.first().ok_or_else(malformed)?;
    let scale = first.font_size * first.h_scale;
    if scale == 0.0 && !shown.iter().any(|(_, removed)| *removed) {
        return Err(Unsupported::new("removed text distance cannot carry to a zero-size show"));
    }
    if scale == 0.0 {
        // No number moves at this size: the (invisible) show goes whole and
        // its advance joins the carry.
        let carry = carry + shown.iter().map(|(g, _)| g.advance()).sum::<f64>();
        return Ok(ShowRewrite { ops: out, carry, dropped_whole: true });
    }
    // Text space distance to TJ number in this show.
    let to_number = |distance: f64| -distance * 1000.0 / scale;
    let mut items: Vec<Item> = Vec::new();
    let mut pending = carry;
    for (k, element) in elements.into_iter().enumerate() {
        let (bytes, format) = match element {
            Object::String(bytes, format) => (bytes, format),
            Object::Integer(i) => {
                pending += -(i as f64) / 1000.0 * scale;
                continue;
            }
            Object::Real(r) => {
                pending += -f64::from(r) / 1000.0 * scale;
                continue;
            }
            _ => return Err(malformed()),
        };
        let mut in_element: Vec<&(&Glyph, bool)> = shown.iter().filter(|(g, _)| g.elem_index == k).collect();
        in_element.sort_by_key(|(g, _)| g.byte_range.start);
        let mut kept: Vec<u8> = Vec::new();
        let mut pos = 0;
        for (g, removed) in in_element {
            let range = g.byte_range.clone();
            if range.start < pos || range.end > bytes.len() {
                return Err(malformed());
            }
            if *removed {
                if !kept.is_empty() {
                    items.push(Item::Text(std::mem::take(&mut kept), format));
                }
                pending += g.advance();
            } else {
                if pending != 0.0 {
                    if !kept.is_empty() {
                        items.push(Item::Text(std::mem::take(&mut kept), format));
                    }
                    items.push(Item::Number(to_number(pending)));
                    pending = 0.0;
                }
                kept.extend_from_slice(&bytes[range.clone()]);
            }
            pos = range.end;
        }
        if !kept.is_empty() {
            items.push(Item::Text(kept, format));
        }
    }
    let mut array = Vec::with_capacity(items.len());
    for item in items {
        match item {
            Item::Text(bytes, format) => array.push(Object::String(bytes, format)),
            Item::Number(n) => array.extend(number(n)?),
        }
    }
    if !array.is_empty() {
        out.push(Operation::new("TJ", vec![Object::Array(array)]));
    }
    Ok(ShowRewrite { ops: out, carry: pending, dropped_whole: false })
}

/// TJ number `n`: an integer when it is one, else a real; nothing for 0.
fn number(n: f64) -> Result<Option<Object>, Unsupported> {
    if !n.is_finite() || n.abs() > MAX_ADJUSTMENT {
        return Err(Unsupported::new("text spacing out of range"));
    }
    Ok(match n {
        0.0 => None,
        n if n.fract() == 0.0 => Some(Object::Integer(n as i64)),
        n => Some(Object::Real(n as f32)),
    })
}

/// True when a show operator after `index` continues from the text position
/// `ops[index]` leaves (no `Td`, `TD`, `Tm`, `T*`, `'`, `"` or `BT` in
/// between; `ET` keeps the position).
pub(crate) fn later_text_depends(ops: &[Operation], index: usize) -> bool {
    for op in ops.iter().skip(index + 1) {
        match op.operator.as_str() {
            "Tj" | "TJ" => return true,
            o if repositions(o) => return false,
            _ => {}
        }
    }
    false
}
