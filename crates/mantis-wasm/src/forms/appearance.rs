//! Appearance stream content for filled fields: text (single line, comb,
//! multiline), list boxes and check marks, in the widget's own form space
//! (`[0 0 width height]`, rotation applied by the XObject /Matrix).

use super::tree::{DaColor, DefaultAppearance};
use crate::edit_ops::text::wrap_lines;
use crate::page_content::fmt_num;
use crate::stamp::fonts::{StdFont, text_width, winansi_byte};
use crate::stamp::page_writer::escape_literal;

/// Inner padding of a text box, in points.
pub(crate) const PADDING: f64 = 2.0;
/// Inner padding of a comb field.
pub(crate) const COMB_PADDING: f64 = 1.0;
/// Line spacing as a multiple of the font size.
pub(crate) const LEADING: f64 = 1.15;
/// Smallest automatic font size.
pub(crate) const MIN_AUTO_SIZE: f64 = 4.0;
/// Largest automatic font size of a multiline field or list box.
pub(crate) const MAX_AUTO_SIZE: f64 = 12.0;
/// Background of a selected list option.
const SELECTED_RGB: &str = "0.6 0.75 0.95";

/// The widget box an appearance fills, with its /MK colours (components:
/// 1 gray, 3 RGB, 4 CMYK; anything else draws nothing).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Frame {
    pub width: f64,
    pub height: f64,
    pub background: Option<Vec<f64>>,
    pub border: Option<Vec<f64>>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Layout {
    Single,
    /// One character per cell, `n` cells.
    Comb(u32),
    Multiline,
}

/// Resource name under which an appearance refers to `font`.
pub(crate) fn font_resource(font: StdFont) -> &'static str {
    match font {
        StdFont::Helvetica => "Helv",
        StdFont::HelveticaBold => "HeBo",
        StdFont::TimesRoman => "TiRo",
        StdFont::Courier => "Cour",
    }
}

pub(crate) fn color_op(components: &[f64], stroke: bool) -> Option<String> {
    let op = match (components.len(), stroke) {
        (1, false) => "g",
        (1, true) => "G",
        (3, false) => "rg",
        (3, true) => "RG",
        (4, false) => "k",
        (4, true) => "K",
        _ => return None,
    };
    let nums: Vec<String> = components.iter().map(|&c| fmt_num(c)).collect();
    Some(format!("{} {op}", nums.join(" ")))
}

pub(crate) fn da_components(color: DaColor) -> Vec<f64> {
    match color {
        DaColor::Gray(g) => vec![g],
        DaColor::Rgb(c) => c.to_vec(),
        DaColor::Cmyk(c) => c.to_vec(),
    }
}

/// Background fill and 1 pt border, drawn before the field content.
pub(crate) fn frame_content(frame: &Frame) -> Vec<u8> {
    let (w, h) = (frame.width, frame.height);
    let mut out = String::new();
    if let Some(op) = frame.background.as_deref().and_then(|c| color_op(c, false)) {
        out.push_str(&format!("{op}\n0 0 {} {} re f\n", fmt_num(w), fmt_num(h)));
    }
    if let Some(op) = frame.border.as_deref().and_then(|c| color_op(c, true)) {
        out.push_str(&format!("{op}\n1 w\n0.5 0.5 {} {} re S\n", fmt_num(w - 1.0), fmt_num(h - 1.0)));
    }
    out.into_bytes()
}

fn winansi(text: &str) -> Vec<u8> {
    text.chars().filter_map(winansi_byte).collect()
}

/// Content strings are built as text whose chars are all U+0000..=U+00FF
/// (`literal` maps each WinAnsi byte to the char of the same value); this
/// narrows them back to bytes.
fn latin1_byte(c: char) -> u8 {
    u8::try_from(u32::from(c)).unwrap_or(b'?')
}

fn literal(bytes: &[u8]) -> String {
    let mut out = Vec::with_capacity(bytes.len() + 2);
    out.push(b'(');
    escape_literal(bytes, &mut out);
    out.push(b')');
    out.into_iter().map(char::from).collect()
}

/// Baseline that centres a line of `font` at `size` vertically in `height`.
fn centred_baseline(font: StdFont, size: f64, height: f64) -> f64 {
    let (asc, desc) = (font.ascent() * size / 1000.0, font.descent() * size / 1000.0);
    (height - (asc - desc)) / 2.0 - desc
}

/// Automatic size of a single line: three quarters of the height, smaller
/// when the text would not fit the width (not below 4 pt unless the height
/// itself is smaller).
fn auto_single(font: StdFont, bytes: &[u8], avail_width: f64, height: f64) -> f64 {
    let by_height = height * 0.75;
    let unit = text_width(font, bytes, 1.0);
    let by_width = if unit > 0.0 { avail_width / unit } else { f64::INFINITY };
    by_height.min(by_width).max(MIN_AUTO_SIZE.min(by_height))
}

fn multiline_fits(font: StdFont, size: f64, lines: usize, height: f64) -> bool {
    let needed = 2.0 * PADDING + (font.ascent() - font.descent()) * size / 1000.0
        + lines.saturating_sub(1) as f64 * size * LEADING;
    needed <= height
}

fn aligned_x(align: u8, width: f64, line_width: f64, padding: f64) -> f64 {
    match align {
        1 => (width - line_width) / 2.0,
        2 => width - padding - line_width,
        _ => padding,
    }
}

/// Content of a text field (or combo box) showing `text`. Characters the
/// standard fonts cannot show are dropped (callers validate first).
pub(crate) fn text_appearance(frame: &Frame, da: &DefaultAppearance, align: u8, layout: Layout, text: &str) -> Vec<u8> {
    let (w, h) = (frame.width, frame.height);
    let font = da.font;
    let mut body = String::new();
    let size;
    match layout {
        Layout::Single => {
            let bytes = winansi(text);
            size = if da.size > 0.0 { da.size } else { auto_single(font, &bytes, w - 2.0 * PADDING, h) };
            if !bytes.is_empty() {
                let x = aligned_x(align, w, text_width(font, &bytes, size), PADDING);
                let y = centred_baseline(font, size, h);
                body.push_str(&format!("{} {} Td\n{} Tj\n", fmt_num(x), fmt_num(y), literal(&bytes)));
            }
        }
        Layout::Comb(cells) => {
            let cells = cells.max(1);
            let cell = w / f64::from(cells);
            let bytes: Vec<u8> = winansi(text).into_iter().take(cells as usize).collect();
            size = if da.size > 0.0 {
                da.size
            } else {
                let widest = bytes.iter().map(|&b| text_width(font, &[b], 1.0)).fold(0.0, f64::max);
                let by_width = if widest > 0.0 { (cell - 2.0 * COMB_PADDING) / widest } else { f64::INFINITY };
                (h * 0.75).min(by_width).max(MIN_AUTO_SIZE.min(h * 0.75))
            };
            let y = centred_baseline(font, size, h);
            for (i, &b) in bytes.iter().enumerate() {
                let x = i as f64 * cell + (cell - text_width(font, &[b], size)) / 2.0;
                body.push_str(&format!("1 0 0 1 {} {} Tm\n{} Tj\n", fmt_num(x), fmt_num(y), literal(&[b])));
            }
        }
        Layout::Multiline => {
            let avail = w - 2.0 * PADDING;
            let (s, lines) = if da.size > 0.0 {
                (da.size, wrap_lines(text, font, da.size, avail))
            } else {
                let mut chosen = None;
                let mut s = MAX_AUTO_SIZE;
                while s >= MIN_AUTO_SIZE {
                    let lines = wrap_lines(text, font, s, avail);
                    if multiline_fits(font, s, lines.len(), h) {
                        chosen = Some((s, lines));
                        break;
                    }
                    s -= 1.0;
                }
                chosen.unwrap_or_else(|| (MIN_AUTO_SIZE, wrap_lines(text, font, MIN_AUTO_SIZE, avail)))
            };
            size = s;
            let first = h - PADDING - font.ascent() * size / 1000.0;
            for (i, line) in lines.iter().enumerate() {
                let bytes = winansi(line);
                if bytes.is_empty() {
                    continue;
                }
                let x = aligned_x(align, w, text_width(font, &bytes, size), PADDING);
                let y = first - i as f64 * size * LEADING;
                body.push_str(&format!("1 0 0 1 {} {} Tm\n{} Tj\n", fmt_num(x), fmt_num(y), literal(&bytes)));
            }
        }
    }
    let mut out = frame_content(frame);
    let color = color_op(&da_components(da.color), false).unwrap_or_else(|| "0 g".into());
    out.extend(
        format!(
            "/Tx BMC\nq\n1 1 {} {} re W n\nBT\n/{} {} Tf\n{color}\n{body}ET\nQ\nEMC\n",
            fmt_num(w - 2.0),
            fmt_num(h - 2.0),
            font_resource(font),
            fmt_num(size),
        )
        .chars()
        .map(latin1_byte),
    );
    out
}

/// Content of a list box: as many options as fit from the top (scrolled so
/// the first selected one shows), selected ones on a light blue background.
pub(crate) fn list_appearance(frame: &Frame, da: &DefaultAppearance, displays: &[String], selected: &[usize]) -> Vec<u8> {
    let (w, h) = (frame.width, frame.height);
    let font = da.font;
    let size = if da.size > 0.0 { da.size } else { MAX_AUTO_SIZE };
    let row = size * LEADING;
    let visible = (((h - 2.0 * PADDING) / row).floor() as usize).max(1);
    let start = match selected.iter().min() {
        Some(&first) if first >= visible => first + 1 - visible,
        _ => 0,
    };
    let (asc, desc) = (font.ascent() * size / 1000.0, font.descent() * size / 1000.0);
    let mut highlights = String::new();
    let mut body = String::new();
    for (row_index, i) in (start..displays.len()).take(visible).enumerate() {
        let top = h - PADDING - row_index as f64 * row;
        if selected.contains(&i) {
            highlights.push_str(&format!(
                "{SELECTED_RGB} rg\n1 {} {} {} re f\n",
                fmt_num(top - row),
                fmt_num(w - 2.0),
                fmt_num(row)
            ));
        }
        let bytes = winansi(&displays[i]);
        if bytes.is_empty() {
            continue;
        }
        let y = top - row + (row - (asc - desc)) / 2.0 - desc;
        body.push_str(&format!("1 0 0 1 {} {} Tm\n{} Tj\n", fmt_num(PADDING), fmt_num(y), literal(&bytes)));
    }
    let color = color_op(&da_components(da.color), false).unwrap_or_else(|| "0 g".into());
    let mut out = frame_content(frame);
    out.extend(
        format!(
            "/Tx BMC\nq\n1 1 {} {} re W n\n{highlights}BT\n/{} {} Tf\n{color}\n{body}ET\nQ\nEMC\n",
            fmt_num(w - 2.0),
            fmt_num(h - 2.0),
            font_resource(font),
            fmt_num(size),
        )
        .chars()
        .map(latin1_byte),
    );
    out
}

/// "On" appearance of a checkbox that has none: a check mark stroked in the
/// /DA colour, centred in the widget.
pub(crate) fn check_appearance(frame: &Frame, da: &DefaultAppearance) -> Vec<u8> {
    let (w, h) = (frame.width, frame.height);
    let s = w.min(h);
    let (ox, oy) = ((w - s) / 2.0, (h - s) / 2.0);
    let p = |fx: f64, fy: f64| format!("{} {}", fmt_num(ox + fx * s), fmt_num(oy + fy * s));
    let color = color_op(&da_components(da.color), true).unwrap_or_else(|| "0 G".into());
    let mut out = frame_content(frame);
    out.extend_from_slice(
        format!(
            "q\n{color}\n{} w\n1 J\n1 j\n{} m\n{} l\n{} l\nS\nQ\n",
            fmt_num(s * 0.1),
            p(0.2, 0.5),
            p(0.4, 0.25),
            p(0.8, 0.75)
        )
        .as_bytes(),
    );
    out
}

/// Bezier control distance for a quarter circle of radius 1.
const KAPPA: f64 = 0.5523;

/// "On" appearance of a radio button that has none: a dot filled in the
/// /DA colour, centred, its diameter half the smaller widget side.
pub(crate) fn radio_appearance(frame: &Frame, da: &DefaultAppearance) -> Vec<u8> {
    let (cx, cy) = (frame.width / 2.0, frame.height / 2.0);
    let r = frame.width.min(frame.height) / 4.0;
    let k = r * KAPPA;
    let p = |x: f64, y: f64| format!("{} {}", fmt_num(x), fmt_num(y));
    let color = color_op(&da_components(da.color), false).unwrap_or_else(|| "0 g".into());
    format!(
        "q\n{color}\n{} m\n{} {} {} c\n{} {} {} c\n{} {} {} c\n{} {} {} c\nf\nQ\n",
        p(cx + r, cy),
        p(cx + r, cy + k), p(cx + k, cy + r), p(cx, cy + r),
        p(cx - k, cy + r), p(cx - r, cy + k), p(cx - r, cy),
        p(cx - r, cy - k), p(cx - k, cy - r), p(cx, cy - r),
        p(cx + k, cy - r), p(cx + r, cy - k), p(cx + r, cy),
    )
    .into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(width: f64, height: f64) -> Frame {
        Frame { width, height, background: None, border: None }
    }

    fn helv(size: f64) -> DefaultAppearance {
        DefaultAppearance { font: StdFont::Helvetica, size, color: DaColor::Gray(0.0) }
    }

    fn s(bytes: Vec<u8>) -> String {
        String::from_utf8(bytes).unwrap()
    }

    // "Hi" in Helvetica 12: (722 + 222) * 12 / 1000 = 11.328 wide.
    // Baseline in a 20 pt box: (20 - 925 * 0.012) / 2 + 207 * 0.012 = 6.934.
    fn single(x: &str) -> String {
        format!("/Tx BMC\nq\n1 1 198 18 re W n\nBT\n/Helv 12 Tf\n0 g\n{x} 6.934 Td\n(Hi) Tj\nET\nQ\nEMC\n")
    }

    #[test]
    fn single_line_left_center_right() {
        let f = frame(200.0, 20.0);
        assert_eq!(s(text_appearance(&f, &helv(12.0), 0, Layout::Single, "Hi")), single("2"));
        assert_eq!(s(text_appearance(&f, &helv(12.0), 1, Layout::Single, "Hi")), single("94.336"));
        assert_eq!(s(text_appearance(&f, &helv(12.0), 2, Layout::Single, "Hi")), single("186.672"));
    }

    #[test]
    fn comb_max_len_5_abc() {
        // Cells of 20 pt; A and B are 8.004 wide at 12 pt, C 8.664.
        let got = s(text_appearance(&frame(100.0, 20.0), &helv(12.0), 0, Layout::Comb(5), "ABC"));
        assert_eq!(got, "/Tx BMC\nq\n1 1 98 18 re W n\nBT\n/Helv 12 Tf\n0 g\n\
            1 0 0 1 5.998 6.934 Tm\n(A) Tj\n\
            1 0 0 1 25.998 6.934 Tm\n(B) Tj\n\
            1 0 0 1 45.668 6.934 Tm\n(C) Tj\n\
            ET\nQ\nEMC\n");
    }

    #[test]
    fn multiline_wraps_three_lines_top_down() {
        // 56 pt of line width at 10 pt: "alpha beta" (46.7), "gamma", "delta".
        // First baseline 60 - 2 - 7.18 = 50.82, then 11.5 pt lower each.
        let got = s(text_appearance(&frame(60.0, 60.0), &helv(10.0), 0, Layout::Multiline, "alpha beta gamma delta"));
        assert_eq!(got, "/Tx BMC\nq\n1 1 58 58 re W n\nBT\n/Helv 10 Tf\n0 g\n\
            1 0 0 1 2 50.82 Tm\n(alpha beta) Tj\n\
            1 0 0 1 2 39.32 Tm\n(gamma) Tj\n\
            1 0 0 1 2 27.82 Tm\n(delta) Tj\n\
            ET\nQ\nEMC\n");
    }

    #[test]
    fn auto_size_single_line_height_20_is_15() {
        let got = s(text_appearance(&frame(200.0, 20.0), &helv(0.0), 0, Layout::Single, "Hi"));
        assert!(got.contains("/Helv 15 Tf\n"), "{got}");
        // A long text shrinks to fit the width: 196 / (width of the text at 1 pt).
        let long = "W".repeat(30); // 944 units each: 28.32 per pt
        let got = s(text_appearance(&frame(200.0, 20.0), &helv(0.0), 0, Layout::Single, &long));
        assert!(got.contains("/Helv 6.920904 Tf\n"), "{got}");
    }

    #[test]
    fn auto_size_multiline_picks_largest_that_fits() {
        // 12 pt: one line needs 4 + 11.1 = 15.1; two lines need 28.9.
        let got = s(text_appearance(&frame(200.0, 20.0), &helv(0.0), 0, Layout::Multiline, "a\nb"));
        // 2 lines at size s need 4 + 0.925 s + 1.15 s <= 20 -> s <= 7.71: 7 pt.
        assert!(got.contains("/Helv 7 Tf\n"), "{got}");
    }

    #[test]
    fn mk_background_and_border_drawn_first() {
        let f = Frame { width: 50.0, height: 20.0, background: Some(vec![1.0, 1.0, 0.0]), border: Some(vec![0.0]) };
        let got = s(text_appearance(&f, &helv(12.0), 0, Layout::Single, ""));
        assert_eq!(got, "1 1 0 rg\n0 0 50 20 re f\n0 G\n1 w\n0.5 0.5 49 19 re S\n\
            /Tx BMC\nq\n1 1 48 18 re W n\nBT\n/Helv 12 Tf\n0 g\nET\nQ\nEMC\n");
        let cmyk = Frame { background: Some(vec![0.0, 0.0, 0.0, 0.1]), border: Some(vec![]), ..f };
        assert!(s(frame_content(&cmyk)).starts_with("0 0 0 0.1 k\n"));
        assert!(!s(frame_content(&cmyk)).contains(" S\n"));
    }

    #[test]
    fn da_colour_and_font_used() {
        let da = DefaultAppearance { font: StdFont::Courier, size: 9.0, color: DaColor::Rgb([1.0, 0.0, 0.0]) };
        let got = s(text_appearance(&frame(100.0, 20.0), &da, 0, Layout::Single, "x"));
        assert!(got.contains("/Cour 9 Tf\n1 0 0 rg\n"), "{got}");
    }

    #[test]
    fn literal_escapes_and_keeps_winansi_bytes() {
        let got = text_appearance(&frame(200.0, 20.0), &helv(12.0), 0, Layout::Single, "(é€)\\");
        let needle = b"(\\(\xE9\x80\\)\\\\) Tj";
        assert!(got.windows(needle.len()).any(|w| w == needle), "{:?}", String::from_utf8_lossy(&got));
    }

    #[test]
    fn list_highlights_selected_rows() {
        // 12 pt rows of 13.8; 60 pt box shows 4 rows; selection 1 and 3.
        let displays: Vec<String> = ["a", "b", "c", "d", "e"].map(String::from).to_vec();
        let got = s(list_appearance(&frame(80.0, 60.0), &helv(0.0), &displays, &[1, 3]));
        assert_eq!(got.matches(" re f\n").count(), 2);
        assert!(got.contains("0.6 0.75 0.95 rg\n1 30.4 78 13.8 re f\n"), "{got}");
        assert_eq!(got.matches(" Tj\n").count(), 4);
        assert!(!got.contains("(e) Tj"));
        // A selection below the visible rows scrolls the list.
        let got = s(list_appearance(&frame(80.0, 60.0), &helv(0.0), &displays, &[4]));
        assert!(got.contains("(e) Tj") && !got.contains("(a) Tj"), "{got}");
    }

    #[test]
    fn check_mark_path() {
        let got = s(check_appearance(&frame(20.0, 10.0), &helv(0.0)));
        assert_eq!(got, "q\n0 G\n1 w\n1 J\n1 j\n7 5 m\n9 2.5 l\n13 7.5 l\nS\nQ\n");
    }

    #[test]
    fn radio_dot_path() {
        // 20 x 10: radius 2.5 around (10, 5); control offset 2.5 * 0.5523.
        let got = s(radio_appearance(&frame(20.0, 10.0), &helv(0.0)));
        assert_eq!(got, "q\n0 g\n12.5 5 m\n\
            12.5 6.38075 11.38075 7.5 10 7.5 c\n\
            8.61925 7.5 7.5 6.38075 7.5 5 c\n\
            7.5 3.61925 8.61925 2.5 10 2.5 c\n\
            11.38075 2.5 12.5 3.61925 12.5 5 c\n\
            f\nQ\n");
    }
}
