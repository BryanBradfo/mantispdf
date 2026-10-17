//! Helpers for rewriting a page's content and resources without touching
//! objects other pages may share: owned dictionary copies, the content list
//! as direct items, and the count of `q` the original content leaves open.

use crate::rebuild::{MAX_STREAM_DECODED, bounded_content, deref, unbalanced_saves};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use std::collections::HashMap;

/// An owned copy of a dictionary held directly or by reference (empty when
/// absent or not a dictionary). Callers only ever write such copies, so
/// an object shared with other pages or resource users is never mutated.
pub(crate) fn owned_dict(doc: &Document, obj: Option<&Object>) -> Dictionary {
    match obj.and_then(|o| deref(doc, o)) {
        Some(Object::Dictionary(d)) => d.clone(),
        _ => Dictionary::new(),
    }
}

/// The page's content items as a direct list. A reference to an array is
/// replaced by a copy of its items (never nested, never mutated).
pub(crate) fn original_contents(doc: &Document, contents: Option<&Object>) -> Vec<Object> {
    match contents {
        Some(Object::Reference(id)) => match doc.get_object(*id) {
            Ok(Object::Array(items)) => items.clone(),
            Ok(Object::Stream(_)) => vec![Object::Reference(*id)],
            _ => vec![],
        },
        Some(Object::Array(items)) => items.clone(),
        _ => vec![],
    }
}

/// Decoded content bytes all balance scans of one job may produce together
/// (same bound as a rebuild's content scans).
const MAX_JOB_DECODED: usize = 512 << 20;

/// Counts the `q` the original content of a page leaves open at its end.
/// Results are memoized per list of content stream ids (pages sharing their
/// content are decoded once) and all scans share one decode budget.
pub(crate) struct BalanceScanner {
    memo: HashMap<Vec<ObjectId>, usize>,
    /// Decoded bytes still allowed for this job.
    budget: usize,
    /// Streams decoded so far (observed by tests).
    pub(crate) decodes: usize,
}

impl BalanceScanner {
    pub(crate) fn new() -> Self {
        Self::with_budget(MAX_JOB_DECODED)
    }

    pub(crate) fn with_budget(budget: usize) -> Self {
        BalanceScanner { memo: HashMap::new(), budget, decodes: 0 }
    }

    /// Undecodable or oversized content, or content past the job's budget,
    /// counts as balanced.
    pub(crate) fn unbalanced(&mut self, doc: &Document, items: &[Object]) -> usize {
        let key: Option<Vec<ObjectId>> = items.iter().map(|o| o.as_reference().ok()).collect();
        if let Some(open) = key.as_ref().and_then(|k| self.memo.get(k)) {
            return *open;
        }
        let open = self.scan(doc, items);
        if let Some(k) = key {
            self.memo.insert(k, open);
        }
        open
    }

    fn scan(&mut self, doc: &Document, items: &[Object]) -> usize {
        let mut content = Vec::new();
        let mut charged = 0;
        let mut complete = true;
        for item in items {
            let Some(Object::Stream(stream)) = deref(doc, item) else {
                continue;
            };
            let cap = MAX_STREAM_DECODED
                .saturating_sub(content.len())
                .min(self.budget.saturating_sub(charged));
            self.decodes += 1;
            match bounded_content(stream, cap, &mut charged) {
                Some(bytes) => {
                    content.extend(bytes);
                    content.push(b'\n');
                }
                None => {
                    complete = false;
                    break;
                }
            }
        }
        self.budget = self.budget.saturating_sub(charged);
        if complete { unbalanced_saves(&content).unwrap_or(0) } else { 0 }
    }
}

/// An uncompressed stream with an empty dictionary.
pub(crate) fn plain_stream(content: Vec<u8>) -> Stream {
    Stream::new(Dictionary::new(), content).with_compression(false)
}

/// Content-stream number: rounded to 6 decimals, no exponent, no `-0`.
pub(crate) fn fmt_num(v: f64) -> String {
    let r = (v * 1e6).round() / 1e6;
    if r == 0.0 { "0".into() } else { format!("{r}") }
}
