//! Text removal: show operators rewritten so removed glyphs disappear and
//! every kept glyph stays exactly where it was.

use super::Unsupported;
use super::interp::Glyph;
use lopdf::Object;
use lopdf::content::Operation;
use std::ops::Range;

/// Largest TJ adjustment written (thousandths of text space).
const MAX_ADJUSTMENT: f64 = 1e15;

/// One element of a rewritten TJ array.
enum Item {
    Text(Vec<u8>, lopdf::StringFormat),
    Number(f64),
}

/// Replacement for the show operator `op` (`Tj`, `TJ`, `'` or `"`) without
/// the `removed` glyphs (all from `op`). Each maximal run of removed glyphs,
/// together with the TJ numbers next to it, becomes ONE number: the total
/// distance, never per-glyph widths. Numbers after the last kept glyph are
/// written only when `later_text_depends` (a later show continues from this
/// position). The line move and spacing of `'` and `"` are kept as `T*`,
/// `Tw` and `Tc`. The flag is true when the whole show had to go (font size
/// or scaling 0: no number can stand in for a glyph).
pub(crate) fn rewrite_show(
    op: &Operation,
    removed: &[&Glyph],
    later_text_depends: bool,
) -> Result<(Vec<Operation>, bool), Unsupported> {
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
    if removed.iter().any(|g| g.tj_adjustment().is_none()) {
        return Ok((out, true));
    }
    let mut items: Vec<Item> = Vec::new();
    let push_number = |items: &mut Vec<Item>, n: f64| match items.last_mut() {
        Some(Item::Number(total)) => *total += n,
        _ => items.push(Item::Number(n)),
    };
    for (k, element) in elements.into_iter().enumerate() {
        let (bytes, format) = match element {
            Object::String(bytes, format) => (bytes, format),
            Object::Integer(i) => {
                push_number(&mut items, i as f64);
                continue;
            }
            Object::Real(r) => {
                push_number(&mut items, f64::from(r));
                continue;
            }
            _ => return Err(malformed()),
        };
        let mut cuts: Vec<(Range<usize>, f64)> = removed
            .iter()
            .filter(|g| g.elem_index == k)
            .map(|g| (g.byte_range.clone(), g.tj_adjustment().unwrap_or(0.0)))
            .collect();
        cuts.sort_by_key(|(r, _)| r.start);
        let mut pos = 0;
        for (range, adjustment) in cuts {
            if range.start < pos || range.end > bytes.len() {
                return Err(malformed());
            }
            if range.start > pos {
                items.push(Item::Text(bytes[pos..range.start].to_vec(), format));
            }
            push_number(&mut items, adjustment);
            pos = range.end;
        }
        if pos < bytes.len() {
            items.push(Item::Text(bytes[pos..].to_vec(), format));
        }
    }
    if !later_text_depends {
        while matches!(items.last(), Some(Item::Number(_))) {
            items.pop();
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
    Ok((out, false))
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
            "Td" | "TD" | "Tm" | "T*" | "'" | "\"" | "BT" => return false,
            _ => {}
        }
    }
    false
}
