//! Marked content around removed content: /ActualText, /Alt and /E can
//! repeat what was removed, so they go from every enclosing sequence.

use super::Unsupported;
use super::interp::{Event, page_resources_dict};
use crate::rebuild::{deref, name_of};
use lopdf::{Dictionary, Document, Object};
use lopdf::content::Operation;
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// Property list keys that can repeat the content they describe.
const REPLACEMENT_TEXT_KEYS: [&[u8]; 3] = [b"ActualText", b"Alt", b"E"];

/// What `strip_replacement_text` changed.
#[derive(Debug, Default)]
pub(crate) struct Stripped {
    /// Rewritten `BDC` operators (inline property lists), by op index.
    pub(crate) replaced: BTreeMap<usize, Vec<Operation>>,
    /// /Properties names whose sequences enclose removed content: the page
    /// needs private copies of them without those keys.
    pub(crate) named_properties: BTreeSet<Vec<u8>>,
}

/// Strip the replacement text of the sequences `touched` (op indices of the
/// innermost `BDC`/`BMC` around removed content) and of all their ancestors,
/// as `events` (`Event::Marked`) nest them.
pub(crate) fn strip_replacement_text(ops: &[Operation], events: &[Event], touched: Vec<usize>) -> Stripped {
    let parents: HashMap<usize, Option<usize>> = events
        .iter()
        .filter_map(|e| match e {
            Event::Marked(m) => Some((m.op_index, m.parent)),
            _ => None,
        })
        .collect();
    let mut sequences = BTreeSet::new();
    for mut current in touched {
        while sequences.insert(current) {
            match parents.get(&current) {
                Some(Some(parent)) => current = *parent,
                _ => break,
            }
        }
    }
    let mut out = Stripped::default();
    for index in sequences {
        match ops.get(index).map(|op| (op.operator.as_str(), op.operands.as_slice())) {
            Some(("BDC", [tag, Object::Dictionary(props)])) => {
                if REPLACEMENT_TEXT_KEYS.iter().any(|k| props.has(k)) {
                    let mut props = props.clone();
                    for key in REPLACEMENT_TEXT_KEYS {
                        props.remove(key);
                    }
                    out.replaced.insert(index, vec![Operation::new("BDC", vec![tag.clone(), Object::Dictionary(props)])]);
                }
            }
            Some(("BDC", [_, Object::Name(name)])) => {
                out.named_properties.insert(name.clone());
            }
            _ => {}
        }
    }
    out
}

/// Give `resources` private copies of the /Properties entries `names`
/// without /ActualText, /Alt and /E. Originals are never changed.
/// Optional-content groups (and membership dictionaries) keep their
/// identity, so one that carries such a key is Unsupported instead.
pub(crate) fn strip_named_properties(doc: &mut Document, resources: &mut Dictionary, names: &BTreeSet<Vec<u8>>) -> Result<(), Unsupported> {
    if names.is_empty() {
        return Ok(());
    }
    let mut properties = page_resources_dict(doc, resources, b"Properties");
    let mut changed = false;
    for name in names {
        let Some(Object::Dictionary(dict)) = properties.get(name).ok().and_then(|o| deref(doc, o)) else {
            continue;
        };
        if !REPLACEMENT_TEXT_KEYS.iter().any(|k| dict.has(k)) {
            continue;
        }
        if matches!(name_of(dict, b"Type"), Some(b"OCG" | b"OCMD")) {
            return Err(Unsupported::new("optional content with replacement text around redacted content"));
        }
        let mut copy = dict.clone();
        for key in REPLACEMENT_TEXT_KEYS {
            copy.remove(key);
        }
        let id = doc.add_object(copy);
        properties.set(name.clone(), id);
        changed = true;
    }
    if changed {
        resources.set("Properties", properties);
    }
    Ok(())
}
