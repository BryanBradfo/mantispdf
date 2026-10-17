//! Pure path operators for shapes, in visible space. The engine wraps each
//! body in `q <visible-to-user matrix> cm /<gs> gs ... Q`.

use super::Paint;
use crate::page_content::fmt_num;

/// Bezier control-point ratio of a quarter ellipse.
pub(crate) const KAPPA: f64 = 0.5522847498;

fn rgb(c: [f64; 3]) -> String {
    c.map(fmt_num).join(" ")
}

fn pt(p: [f64; 2]) -> String {
    format!("{} {}", fmt_num(p[0]), fmt_num(p[1]))
}

/// Paint setup and the painting operator for a closed path, or None when
/// nothing is painted (no fill, and no stroke colour or a zero width).
fn paint(stroke: Paint, width: f64, fill: Paint) -> Option<(String, &'static str)> {
    let stroke = match stroke {
        Paint::Rgb(c) if width > 0.0 => Some(c),
        _ => None,
    };
    match (stroke, fill) {
        (None, Paint::None) => None,
        (None, Paint::Rgb(f)) => Some((format!("{} rg ", rgb(f)), "f")),
        (Some(s), Paint::None) => Some((format!("{} RG {} w ", rgb(s), fmt_num(width)), "S")),
        (Some(s), Paint::Rgb(f)) => Some((format!("{} rg {} RG {} w ", rgb(f), rgb(s), fmt_num(width)), "B")),
    }
}

/// `re` with stroke (`S`), fill (`f`) or both (`B`); None when invisible.
pub(crate) fn rect_ops(rect: [f64; 4], stroke: Paint, width: f64, fill: Paint) -> Option<String> {
    let (setup, op) = paint(stroke, width, fill)?;
    let [x, y, w, h] = rect.map(fmt_num);
    Some(format!("{setup}{x} {y} {w} {h} re {op}"))
}

/// The four Bezier arcs of the ellipse inscribed in `rect`, starting at the
/// rightmost point, counter-clockwise: `(start, [c1, c2, end] x 4)`.
pub(crate) fn ellipse_path(rect: [f64; 4]) -> ([f64; 2], [[[f64; 2]; 3]; 4]) {
    let [x, y, w, h] = rect;
    let (rx, ry) = (w / 2.0, h / 2.0);
    let (cx, cy) = (x + rx, y + ry);
    let (kx, ky) = (KAPPA * rx, KAPPA * ry);
    (
        [cx + rx, cy],
        [
            [[cx + rx, cy + ky], [cx + kx, cy + ry], [cx, cy + ry]],
            [[cx - kx, cy + ry], [cx - rx, cy + ky], [cx - rx, cy]],
            [[cx - rx, cy - ky], [cx - kx, cy - ry], [cx, cy - ry]],
            [[cx + kx, cy - ry], [cx + rx, cy - ky], [cx + rx, cy]],
        ],
    )
}

pub(crate) fn ellipse_ops(rect: [f64; 4], stroke: Paint, width: f64, fill: Paint) -> Option<String> {
    let (setup, op) = paint(stroke, width, fill)?;
    let (start, arcs) = ellipse_path(rect);
    let mut out = format!("{setup}{} m ", pt(start));
    for [c1, c2, end] in arcs {
        out.push_str(&format!("{} {} {} c ", pt(c1), pt(c2), pt(end)));
    }
    out.push_str("h ");
    out.push_str(op);
    Some(out)
}

/// Arrowhead length for a stroke `width`.
pub(crate) fn head_length(width: f64) -> f64 {
    3.0 * width + 6.0
}

/// Filled triangle of an arrowhead whose tip is `tip`, pointing along the
/// unit vector `u`: tip, tip - L u + H n, tip - L u - H n with
/// L = `head_length(width)`, H = L tan 25 degrees, n = u rotated +90 degrees.
pub(crate) fn arrow_head(tip: [f64; 2], u: [f64; 2], width: f64) -> [[f64; 2]; 3] {
    let l = head_length(width);
    let h = l * 25f64.to_radians().tan();
    let n = [-u[1], u[0]];
    let base = [tip[0] - l * u[0], tip[1] - l * u[1]];
    [tip, [base[0] + h * n[0], base[1] + h * n[1]], [base[0] - h * n[0], base[1] - h * n[1]]]
}

/// A straight line, its shaft shortened by 0.8 L at each arrow end so the
/// butt cap does not poke through the head; heads filled with the colour.
pub(crate) fn line_ops(
    from: [f64; 2],
    to: [f64; 2],
    color: [f64; 3],
    width: f64,
    arrow_start: bool,
    arrow_end: bool,
) -> String {
    let (dx, dy) = (to[0] - from[0], to[1] - from[1]);
    let len = dx.hypot(dy);
    let mut out = format!("{} RG {} w ", rgb(color), fmt_num(width));
    if len == 0.0 {
        out.push_str(&format!("{} m {} l S", pt(from), pt(to)));
        return out;
    }
    let u = [dx / len, dy / len];
    let cut = 0.8 * head_length(width);
    let (cut_start, cut_end) = (if arrow_start { cut } else { 0.0 }, if arrow_end { cut } else { 0.0 });
    let mut parts: Vec<String> = Vec::new();
    if cut_start + cut_end < len {
        let a = [from[0] + cut_start * u[0], from[1] + cut_start * u[1]];
        let b = [to[0] - cut_end * u[0], to[1] - cut_end * u[1]];
        parts.push(format!("{} m {} l S", pt(a), pt(b)));
    }
    let mut head = |tip: [f64; 2], dir: [f64; 2]| {
        let [p, a, b] = arrow_head(tip, dir, width);
        parts.push(format!("{} rg {} m {} l {} l h f", rgb(color), pt(p), pt(a), pt(b)));
    };
    if arrow_start {
        head(from, [-u[0], -u[1]]);
    }
    if arrow_end {
        head(to, u);
    }
    out.push_str(&parts.join(" "));
    out
}

/// A polyline with round caps and joins (one point draws a dot).
pub(crate) fn freehand_ops(points: &[[f64; 2]], color: [f64; 3], width: f64) -> String {
    let mut out = format!("{} RG {} w 1 J 1 j ", rgb(color), fmt_num(width));
    let Some((first, rest)) = points.split_first() else {
        return String::new();
    };
    out.push_str(&format!("{} m", pt(*first)));
    if rest.is_empty() {
        out.push_str(&format!(" {} l", pt(*first)));
    }
    for p in rest {
        out.push_str(&format!(" {} l", pt(*p)));
    }
    out.push_str(" S");
    out
}

/// Filled rectangle (highlight body; the multiply blend is in the gs).
pub(crate) fn fill_rect_ops(rect: [f64; 4], color: [f64; 3]) -> String {
    let [x, y, w, h] = rect.map(fmt_num);
    format!("{} rg {x} {y} {w} {h} re f", rgb(color))
}

/// Image placement matrix: the unit square onto `rect`, the image turned
/// clockwise by `rotation` (0, 90, 180, 270) inside it.
pub(crate) fn image_matrix(rect: [f64; 4], rotation: u16) -> [f64; 6] {
    let [x, y, w, h] = rect;
    match rotation {
        90 => [0.0, -h, w, 0.0, x, y + h],
        180 => [-w, 0.0, 0.0, -h, x + w, y + h],
        270 => [0.0, h, -w, 0.0, x + w, y],
        _ => [w, 0.0, 0.0, h, x, y],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RED: [f64; 3] = [1.0, 0.0, 0.0];
    const BLUE: [f64; 3] = [0.0, 0.0, 1.0];

    fn close(a: [f64; 2], b: [f64; 2]) -> bool {
        (a[0] - b[0]).abs() < 1e-6 && (a[1] - b[1]).abs() < 1e-6
    }

    #[test]
    fn rect_stroke_fill_both_none() {
        let r = [10.0, 20.0, 100.0, 50.0];
        assert_eq!(rect_ops(r, Paint::Rgb(RED), 2.0, Paint::None).unwrap(), "1 0 0 RG 2 w 10 20 100 50 re S");
        assert_eq!(rect_ops(r, Paint::None, 2.0, Paint::Rgb(BLUE)).unwrap(), "0 0 1 rg 10 20 100 50 re f");
        assert_eq!(
            rect_ops(r, Paint::Rgb(RED), 1.5, Paint::Rgb(BLUE)).unwrap(),
            "0 0 1 rg 1 0 0 RG 1.5 w 10 20 100 50 re B"
        );
        // A zero width means no stroke.
        assert_eq!(rect_ops(r, Paint::Rgb(RED), 0.0, Paint::Rgb(BLUE)).unwrap(), "0 0 1 rg 10 20 100 50 re f");
        assert_eq!(rect_ops(r, Paint::Rgb(RED), 0.0, Paint::None), None);
        assert_eq!(rect_ops(r, Paint::None, 3.0, Paint::None), None);
    }

    #[test]
    fn ellipse_control_points_100_by_50() {
        // Center (50, 25), rx 50, ry 25; k rx = 27.614237, k ry = 13.807119.
        let (start, arcs) = ellipse_path([0.0, 0.0, 100.0, 50.0]);
        assert!(close(start, [100.0, 25.0]));
        let want = [
            [[100.0, 38.807119245], [77.61423749, 50.0], [50.0, 50.0]],
            [[22.38576251, 50.0], [0.0, 38.807119245], [0.0, 25.0]],
            [[0.0, 11.192880755], [22.38576251, 0.0], [50.0, 0.0]],
            [[77.61423749, 0.0], [100.0, 11.192880755], [100.0, 25.0]],
        ];
        for (arc, w) in arcs.iter().zip(want) {
            for (p, q) in arc.iter().zip(w) {
                assert!(close(*p, q), "{p:?} vs {q:?}");
            }
        }
        let ops = ellipse_ops([0.0, 0.0, 100.0, 50.0], Paint::None, 1.0, Paint::Rgb(BLUE)).unwrap();
        assert_eq!(
            ops,
            "0 0 1 rg 100 25 m 100 38.807119 77.614237 50 50 50 c 22.385763 50 0 38.807119 0 25 c \
             0 11.192881 22.385763 0 50 0 c 77.614237 0 100 11.192881 100 25 c h f"
        );
        assert_eq!(ellipse_ops([0.0, 0.0, 100.0, 50.0], Paint::None, 1.0, Paint::None), None);
    }

    #[test]
    fn arrow_head_horizontal() {
        // width 2: L = 12, H = 12 tan 25 = 5.595692.
        let h = 12.0 * 25f64.to_radians().tan();
        let [a, b, c] = arrow_head([100.0, 0.0], [1.0, 0.0], 2.0);
        assert!(close(a, [100.0, 0.0]));
        assert!(close(b, [88.0, h]), "{b:?}");
        assert!(close(c, [88.0, -h]), "{c:?}");
        assert!((h - 5.595692).abs() < 1e-6);
    }

    #[test]
    fn arrow_head_45_degrees() {
        // width 1: L = 9, H = 9 tan 25; u = (s, s), n = (-s, s), s = 1/sqrt 2.
        let s = std::f64::consts::FRAC_1_SQRT_2;
        let (l, h) = (9.0, 9.0 * 25f64.to_radians().tan());
        let [a, b, c] = arrow_head([50.0, 50.0], [s, s], 1.0);
        assert!(close(a, [50.0, 50.0]));
        assert!(close(b, [50.0 - l * s - h * s, 50.0 - l * s + h * s]), "{b:?}");
        assert!(close(c, [50.0 - l * s + h * s, 50.0 - l * s - h * s]), "{c:?}");
        // Numerically.
        assert!(close(b, [40.668475, 46.603603]), "{b:?}");
        assert!(close(c, [46.603603, 40.668475]), "{c:?}");
    }

    #[test]
    fn line_plain_and_with_arrows() {
        assert_eq!(line_ops([0.0, 0.0], [100.0, 0.0], RED, 2.0, false, false), "1 0 0 RG 2 w 0 0 m 100 0 l S");
        // End arrow: shaft ends at 100 - 0.8 * 12 = 90.4.
        assert_eq!(
            line_ops([0.0, 0.0], [100.0, 0.0], RED, 2.0, false, true),
            "1 0 0 RG 2 w 0 0 m 90.4 0 l S 1 0 0 rg 100 0 m 88 5.595692 l 88 -5.595692 l h f"
        );
        // Both ends: the start head points back to `from`.
        assert_eq!(
            line_ops([0.0, 0.0], [100.0, 0.0], RED, 2.0, true, true),
            "1 0 0 RG 2 w 9.6 0 m 90.4 0 l S 1 0 0 rg 0 0 m 12 -5.595692 l 12 5.595692 l h f \
             1 0 0 rg 100 0 m 88 5.595692 l 88 -5.595692 l h f"
        );
    }

    #[test]
    fn short_or_degenerate_lines() {
        // Shorter than both shortenings: heads only, no shaft.
        let ops = line_ops([0.0, 0.0], [10.0, 0.0], RED, 2.0, true, true);
        assert!(!ops.contains(" S"), "{ops}");
        assert_eq!(ops.matches(" f").count(), 2);
        // Zero length: no direction, so no heads; the shaft is drawn.
        assert_eq!(line_ops([5.0, 5.0], [5.0, 5.0], RED, 2.0, true, true), "1 0 0 RG 2 w 5 5 m 5 5 l S");
    }

    #[test]
    fn freehand_polyline_round() {
        assert_eq!(
            freehand_ops(&[[1.0, 2.0], [3.0, 4.0], [5.0, 4.5]], RED, 3.0),
            "1 0 0 RG 3 w 1 J 1 j 1 2 m 3 4 l 5 4.5 l S"
        );
        assert_eq!(freehand_ops(&[[1.0, 2.0]], RED, 3.0), "1 0 0 RG 3 w 1 J 1 j 1 2 m 1 2 l S");
    }

    #[test]
    fn fill_rect() {
        assert_eq!(fill_rect_ops([1.0, 2.0, 3.0, 4.0], [1.0, 1.0, 0.0]), "1 1 0 rg 1 2 3 4 re f");
    }

    #[test]
    fn image_matrices_per_rotation() {
        let r = [10.0, 20.0, 100.0, 50.0];
        assert_eq!(image_matrix(r, 0), [100.0, 0.0, 0.0, 50.0, 10.0, 20.0]);
        assert_eq!(image_matrix(r, 90), [0.0, -50.0, 100.0, 0.0, 10.0, 70.0]);
        assert_eq!(image_matrix(r, 180), [-100.0, 0.0, 0.0, -50.0, 110.0, 70.0]);
        assert_eq!(image_matrix(r, 270), [0.0, 50.0, -100.0, 0.0, 110.0, 20.0]);
        // 90: the image's top-left corner (0, 1) lands on the box's top-right.
        let [a, b, c, d, e, f] = image_matrix(r, 90);
        assert_eq!((c + e, d + f), (110.0, 70.0));
        let _ = (a, b);
    }
}
