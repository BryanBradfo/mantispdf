//! Text removal: show operators rewritten so removed glyphs disappear and
//! every kept glyph stays exactly where it was.

use super::Unsupported;
use super::interp::Glyph;
use lopdf::Object;
use lopdf::content::Operation;
use std::ops::Range;

/// Largest TJ adjustment written (thousandths of text space); past it the
/// integer part would not round-trip.
const MAX_ADJUSTMENT: f64 = 1e15;

/// Replacement for the show operator `op` (`Tj`, `TJ`, `'` or `"`) without
/// the `removed` glyphs (all from `op`). Each run of removed glyphs becomes a
/// TJ number moving the text position exactly as the glyphs did; the line
/// move and spacing of `'` and `"` are kept as `T*`, `Tw` and `Tc`. The flag
/// is true when the whole show had to go (font size or scaling 0).
pub(crate) fn rewrite_show(op: &Operation, removed: &[&Glyph]) -> Result<(Vec<Operation>, bool), Unsupported> {
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
    // Font size or scaling 0: no number can stand in for a glyph; such
    // glyphs do not move the text position anyway, so the show goes.
    if removed.iter().any(|g| g.tj_adjustment().is_none()) {
        return Ok((out, true));
    }
    let mut items = Vec::new();
    for (k, element) in elements.into_iter().enumerate() {
        let Object::String(bytes, format) = element else {
            items.push(element);
            continue;
        };
        let mut cuts: Vec<(Range<usize>, f64)> = removed
            .iter()
            .filter(|g| g.elem_index == k)
            .map(|g| (g.byte_range.clone(), g.tj_adjustment().unwrap_or(0.0)))
            .collect();
        cuts.sort_by_key(|(r, _)| r.start);
        let mut pos = 0;
        let mut pending = 0.0;
        for (range, adjustment) in cuts {
            if range.start < pos || range.end > bytes.len() {
                return Err(malformed());
            }
            if range.start > pos {
                push_adjustment(&mut items, pending)?;
                pending = 0.0;
                items.push(Object::String(bytes[pos..range.start].to_vec(), format));
            }
            pending += adjustment;
            pos = range.end;
        }
        push_adjustment(&mut items, pending)?;
        if pos < bytes.len() {
            items.push(Object::String(bytes[pos..].to_vec(), format));
        }
    }
    if !items.is_empty() {
        out.push(Operation::new("TJ", vec![Object::Array(items)]));
    }
    Ok((out, false))
}

/// Append TJ number `n` as an integer plus a small real, so it survives
/// lopdf's single-precision reals without moving the text measurably.
fn push_adjustment(items: &mut Vec<Object>, n: f64) -> Result<(), Unsupported> {
    if n == 0.0 {
        return Ok(());
    }
    if !n.is_finite() || n.abs() > MAX_ADJUSTMENT {
        return Err(Unsupported::new("text spacing out of range"));
    }
    let whole = n.trunc();
    if whole != 0.0 {
        items.push(Object::Integer(whole as i64));
    }
    let fraction = (n - whole) as f32;
    if fraction != 0.0 {
        items.push(Object::Real(fraction));
    }
    Ok(())
}
