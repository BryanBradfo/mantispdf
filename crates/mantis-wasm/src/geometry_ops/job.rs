//! Validation of geometry jobs coming from JS. The Reflect layer (`binding`)
//! only copies raw values into the `Raw*` structs; every range and type check
//! lives in the `validate_*` functions so it is unit-testable without a JS
//! runtime.

use super::crop::{CropJob, MAX_PER_PAGE};
use super::nup::{NupJob, Order, PER_SHEET, Sheet};
use super::resize::{MAX_MARGIN, MAX_SHEET, MIN_SHEET, Orientation, ResizeJob, ResizeMode};
use super::{bounded, invalid};
use crate::stamp::engine::PageSelection;

pub(crate) enum RawPages {
    All,
    List(Vec<f64>),
}

pub(crate) struct RawCrop {
    pub pages: RawPages,
    pub rect: Option<[f64; 4]>,
    pub per_page: Vec<(f64, [f64; 4])>,
    pub permanent: bool,
}

pub(crate) struct RawResize {
    pub pages: RawPages,
    pub size: [f64; 2],
    pub orientation: String,
    pub mode: String,
    pub margin: f64,
}

pub(crate) enum RawSheet {
    Same,
    Size([f64; 2]),
}

pub(crate) struct RawNup {
    pub per_sheet: f64,
    pub sheet: RawSheet,
    pub orientation: String,
    pub order: String,
    pub margin: f64,
    pub gap: f64,
    pub border: bool,
}

fn page_number(v: f64, field: &str) -> Result<u32, String> {
    if v.is_finite() && v.fract() == 0.0 && v >= 1.0 && v <= f64::from(u32::MAX) {
        Ok(v as u32)
    } else {
        Err(invalid(field))
    }
}

fn pages(raw: RawPages) -> Result<PageSelection, String> {
    match raw {
        RawPages::All => Ok(PageSelection::All),
        RawPages::List(list) => {
            let mut out = Vec::with_capacity(list.len());
            for (i, p) in list.into_iter().enumerate() {
                out.push(page_number(p, &format!("pages[{i}]"))?);
            }
            Ok(PageSelection::List(out))
        }
    }
}

fn orientation(s: &str) -> Result<Orientation, String> {
    match s {
        "auto" => Ok(Orientation::Auto),
        "portrait" => Ok(Orientation::Portrait),
        "landscape" => Ok(Orientation::Landscape),
        _ => Err(invalid("orientation")),
    }
}

fn sheet_side(v: f64, field: &str) -> Result<f64, String> {
    if v.is_finite() && (MIN_SHEET..=MAX_SHEET).contains(&v) { Ok(v) } else { Err(invalid(field)) }
}

fn spacing(v: f64, field: &str) -> Result<f64, String> {
    if v.is_finite() && (0.0..=MAX_MARGIN).contains(&v) { Ok(v) } else { Err(invalid(field)) }
}

pub(crate) fn validate_crop(raw: RawCrop) -> Result<CropJob, String> {
    let pages = pages(raw.pages)?;
    if raw.rect.is_some_and(|r| !bounded(&r)) {
        return Err(invalid("rect"));
    }
    if raw.per_page.len() > MAX_PER_PAGE {
        return Err(invalid("perPage"));
    }
    let mut per_page = Vec::with_capacity(raw.per_page.len());
    for (i, (page, rect)) in raw.per_page.into_iter().enumerate() {
        let page = page_number(page, &format!("perPage[{i}].page"))?;
        if !bounded(&rect) {
            return Err(invalid(&format!("perPage[{i}].rect")));
        }
        per_page.push((page, rect));
    }
    Ok(CropJob { pages, rect: raw.rect, per_page, permanent: raw.permanent })
}

pub(crate) fn validate_resize(raw: RawResize) -> Result<ResizeJob, String> {
    let pages = pages(raw.pages)?;
    let size = [sheet_side(raw.size[0], "size")?, sheet_side(raw.size[1], "size")?];
    let orientation = orientation(&raw.orientation)?;
    let mode = match raw.mode.as_str() {
        "fit" => ResizeMode::Fit,
        "extend" => ResizeMode::Extend,
        _ => return Err(invalid("mode")),
    };
    let margin = spacing(raw.margin, "margin")?;
    Ok(ResizeJob { pages, size, orientation, mode, margin })
}

pub(crate) fn validate_nup(raw: RawNup) -> Result<NupJob, String> {
    let n = raw.per_sheet;
    let per_sheet = PER_SHEET
        .iter()
        .copied()
        .find(|&p| f64::from(p) == n)
        .ok_or_else(|| invalid("perSheet"))?;
    let sheet = match raw.sheet {
        RawSheet::Same => Sheet::SameAsFirst,
        RawSheet::Size([w, h]) => Sheet::Size([sheet_side(w, "sheet")?, sheet_side(h, "sheet")?]),
    };
    let order = match raw.order.as_str() {
        "rows" => Order::Rows,
        "columns" => Order::Columns,
        _ => return Err(invalid("order")),
    };
    Ok(NupJob {
        per_sheet,
        sheet,
        orientation: orientation(&raw.orientation)?,
        order,
        margin: spacing(raw.margin, "margin")?,
        gap: spacing(raw.gap, "gap")?,
        border: raw.border,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn crop() -> RawCrop {
        RawCrop { pages: RawPages::All, rect: Some([10.0, 10.0, 100.0, 100.0]), per_page: vec![], permanent: false }
    }

    fn resize() -> RawResize {
        RawResize {
            pages: RawPages::All,
            size: [595.28, 841.89],
            orientation: "auto".into(),
            mode: "fit".into(),
            margin: 0.0,
        }
    }

    fn nup() -> RawNup {
        RawNup {
            per_sheet: 4.0,
            sheet: RawSheet::Size([595.28, 841.89]),
            orientation: "auto".into(),
            order: "rows".into(),
            margin: 28.0,
            gap: 14.0,
            border: false,
        }
    }

    fn err<T>(r: Result<T, String>) -> String {
        r.err().expect("expected an error")
    }

    #[test]
    fn valid_jobs_pass() {
        let c = validate_crop(crop()).unwrap();
        assert_eq!(c.pages, PageSelection::All);
        assert_eq!(c.rect, Some([10.0, 10.0, 100.0, 100.0]));
        assert!(validate_resize(resize()).is_ok());
        assert!(validate_nup(nup()).is_ok());
    }

    #[test]
    fn crop_pages_are_checked() {
        for bad in [0.0, -1.0, 1.5, f64::NAN, f64::INFINITY, 5e9] {
            let mut j = crop();
            j.pages = RawPages::List(vec![1.0, bad]);
            assert_eq!(err(validate_crop(j)), "Invalid geometry settings: pages[1]");
        }
        let mut j = crop();
        j.pages = RawPages::List(vec![3.0, 1.0]);
        assert_eq!(validate_crop(j).unwrap().pages, PageSelection::List(vec![3, 1]));
    }

    #[test]
    fn crop_rect_bounds() {
        for bad in [f64::NAN, f64::INFINITY, 1e6 + 1.0, -1e6 - 1.0] {
            let mut j = crop();
            j.rect = Some([0.0, 0.0, bad, 10.0]);
            assert_eq!(err(validate_crop(j)), "Invalid geometry settings: rect");
        }
        let mut j = crop();
        j.rect = Some([-1e6, -1e6, 1e6, 1e6]);
        assert!(validate_crop(j).is_ok());
        let mut j = crop();
        j.rect = None;
        assert!(validate_crop(j).is_ok());
    }

    #[test]
    fn crop_per_page_checks() {
        let mut j = crop();
        j.per_page = vec![(2.0, [0.0, 0.0, 10.0, 10.0]), (0.0, [0.0, 0.0, 10.0, 10.0])];
        assert_eq!(err(validate_crop(j)), "Invalid geometry settings: perPage[1].page");
        let mut j = crop();
        j.per_page = vec![(2.0, [f64::NAN, 0.0, 10.0, 10.0])];
        assert_eq!(err(validate_crop(j)), "Invalid geometry settings: perPage[0].rect");
        let mut j = crop();
        j.per_page = vec![(1.0, [0.0, 0.0, 1.0, 1.0]); MAX_PER_PAGE];
        assert_eq!(validate_crop(j).unwrap().per_page.len(), MAX_PER_PAGE);
        let mut j = crop();
        j.per_page = vec![(1.0, [0.0, 0.0, 1.0, 1.0]); MAX_PER_PAGE + 1];
        assert_eq!(err(validate_crop(j)), "Invalid geometry settings: perPage");
    }

    #[test]
    fn resize_size_bounds() {
        for bad in [35.9, 14_400.1, f64::NAN, f64::INFINITY, -600.0] {
            let mut j = resize();
            j.size = [bad, 800.0];
            assert_eq!(err(validate_resize(j)), "Invalid geometry settings: size");
            let mut j = resize();
            j.size = [600.0, bad];
            assert_eq!(err(validate_resize(j)), "Invalid geometry settings: size");
        }
        let mut j = resize();
        j.size = [36.0, 14_400.0];
        assert!(validate_resize(j).is_ok());
    }

    #[test]
    fn resize_enums_and_margin() {
        let mut j = resize();
        j.orientation = "sideways".into();
        assert_eq!(err(validate_resize(j)), "Invalid geometry settings: orientation");
        let mut j = resize();
        j.mode = "stretch".into();
        assert_eq!(err(validate_resize(j)), "Invalid geometry settings: mode");
        for bad in [-0.1, MAX_MARGIN + 0.1, f64::NAN, f64::INFINITY] {
            let mut j = resize();
            j.margin = bad;
            assert_eq!(err(validate_resize(j)), "Invalid geometry settings: margin");
        }
        for (s, o) in [("auto", Orientation::Auto), ("portrait", Orientation::Portrait), ("landscape", Orientation::Landscape)] {
            let mut j = resize();
            j.orientation = s.into();
            assert_eq!(validate_resize(j).unwrap().orientation, o);
        }
        let mut j = resize();
        j.mode = "extend".into();
        j.margin = MAX_MARGIN;
        let ok = validate_resize(j).unwrap();
        assert_eq!(ok.mode, ResizeMode::Extend);
        assert_eq!(ok.margin, MAX_MARGIN);
    }

    #[test]
    fn nup_per_sheet_set() {
        for n in [2.0, 4.0, 6.0, 8.0, 9.0, 16.0] {
            let mut j = nup();
            j.per_sheet = n;
            assert_eq!(validate_nup(j).unwrap().per_sheet as f64, n);
        }
        for bad in [0.0, 1.0, 3.0, 4.5, 10.0, 256.0 + 4.0, f64::NAN, -4.0] {
            let mut j = nup();
            j.per_sheet = bad;
            assert_eq!(err(validate_nup(j)), "Invalid geometry settings: perSheet");
        }
    }

    #[test]
    fn nup_sheet_order_spacing() {
        let mut j = nup();
        j.sheet = RawSheet::Same;
        assert_eq!(validate_nup(j).unwrap().sheet, Sheet::SameAsFirst);
        let mut j = nup();
        j.sheet = RawSheet::Size([30.0, 800.0]);
        assert_eq!(err(validate_nup(j)), "Invalid geometry settings: sheet");
        let mut j = nup();
        j.sheet = RawSheet::Size([600.0, f64::NAN]);
        assert_eq!(err(validate_nup(j)), "Invalid geometry settings: sheet");
        let mut j = nup();
        j.order = "diagonal".into();
        assert_eq!(err(validate_nup(j)), "Invalid geometry settings: order");
        let mut j = nup();
        j.order = "columns".into();
        assert_eq!(validate_nup(j).unwrap().order, Order::Columns);
        let mut j = nup();
        j.gap = -1.0;
        assert_eq!(err(validate_nup(j)), "Invalid geometry settings: gap");
        let mut j = nup();
        j.margin = MAX_MARGIN + 1.0;
        assert_eq!(err(validate_nup(j)), "Invalid geometry settings: margin");
        let mut j = nup();
        j.orientation = "x".into();
        assert_eq!(err(validate_nup(j)), "Invalid geometry settings: orientation");
        let mut j = nup();
        j.border = true;
        assert!(validate_nup(j).unwrap().border);
    }
}
