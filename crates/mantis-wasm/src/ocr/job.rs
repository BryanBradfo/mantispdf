//! Pure side of the OCR binding: the job's count limits (checked by
//! `binding` on the JS lengths before anything is copied, and again by
//! `add_text_layer`) and the conversion of raw pages, whose page number is
//! still the f64 JS handed over, into `OcrPage`s.

use super::{MAX_JOB_WORDS, MAX_PAGES, MAX_WORDS, OcrPage, OcrWord, invalid};

/// One page as read from JS.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RawPage {
    pub page: f64,
    pub words: Vec<OcrWord>,
}

/// At most `MAX_PAGES` page entries, `MAX_WORDS` words each and
/// `MAX_JOB_WORDS` in all; `words` gives each entry's word count.
pub(crate) fn check_counts(pages: usize, words: impl IntoIterator<Item = usize>) -> Result<(), String> {
    if pages > MAX_PAGES {
        return Err(invalid("pages"));
    }
    let mut total = 0usize;
    for n in words {
        total = total.saturating_add(n);
        if n > MAX_WORDS || total > MAX_JOB_WORDS {
            return Err(invalid("words"));
        }
    }
    Ok(())
}

/// A whole page number in `1..=u32::MAX`.
fn page_number(v: f64, i: usize) -> Result<u32, String> {
    if v.is_finite() && v.fract() == 0.0 && (1.0..=f64::from(u32::MAX)).contains(&v) {
        Ok(v as u32)
    } else {
        Err(invalid(&format!("pages[{i}].page")))
    }
}

pub(crate) fn to_pages(raw: Vec<RawPage>) -> Result<Vec<OcrPage>, String> {
    raw.into_iter().enumerate().map(|(i, p)| Ok(OcrPage { page: page_number(p.page, i)?, words: p.words })).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(page: f64) -> RawPage {
        RawPage { page, words: Vec::new() }
    }

    #[test]
    fn counts_within_limits_pass() {
        assert_eq!(check_counts(MAX_PAGES, [MAX_WORDS; 10]), Ok(()));
        assert_eq!(check_counts(0, []), Ok(()));
    }

    #[test]
    fn counts_past_limits_fail() {
        assert_eq!(check_counts(MAX_PAGES + 1, []), Err(invalid("pages")));
        assert_eq!(check_counts(1, [MAX_WORDS + 1]), Err(invalid("words")));
        let mut many = vec![MAX_WORDS; MAX_JOB_WORDS / MAX_WORDS];
        many.push(1);
        assert_eq!(check_counts(many.len(), many), Err(invalid("words")));
        assert_eq!(check_counts(2, [usize::MAX, usize::MAX]), Err(invalid("words")));
    }

    #[test]
    fn page_numbers_are_whole_and_positive() {
        let pages = to_pages(vec![raw(1.0), raw(7.0)]).unwrap();
        assert_eq!(pages.iter().map(|p| p.page).collect::<Vec<_>>(), [1, 7]);
        for bad in [0.0, -1.0, 1.5, f64::NAN, f64::INFINITY, 5e9] {
            assert_eq!(to_pages(vec![raw(1.0), raw(bad)]), Err(invalid("pages[1].page")), "{bad}");
        }
    }
}
