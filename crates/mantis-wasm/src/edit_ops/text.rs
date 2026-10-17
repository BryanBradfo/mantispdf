//! Text boxes: wrapping by AFM widths (shared spec with the JS preview,
//! `src/lib/editor/wrapVectors.json`) and line placement inside the box.

use super::Align;
use crate::stamp::fonts::{StdFont, encode_winansi, text_width, winansi_byte};

/// Wraps `text` into lines no wider than `max_width` points.
///
/// - `\r\n` and `\r` are line breaks like `\n`; each paragraph wraps on its own.
/// - Words are separated by runs of spaces or tabs; a line joins its words
///   with one space; leading and trailing blanks are dropped.
/// - Greedy: a word goes on the current line when the joined line still fits
///   (`width <= max_width`), else it starts a new line.
/// - A word wider than `max_width` is broken by characters (at least one
///   character per line).
/// - An empty (or blank) paragraph is one empty line.
/// - Widths are `text_width` of the WinAnsi bytes (characters outside WinAnsi
///   count as zero; callers validate the text first).
pub fn wrap_lines(text: &str, font: StdFont, size: f64, max_width: f64) -> Vec<String> {
    // Widths in integer AFM units: `units * size / 1000` is exactly what
    // `text_width` returns for the same bytes.
    let units = |c: char| winansi_byte(c).map_or(0, |b| text_width(font, &[b], 1000.0) as u64);
    let fits = |u: u64| u as f64 * size / 1000.0 <= max_width;
    let space = units(' ');
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut lines = Vec::new();
    for paragraph in normalized.split('\n') {
        let mut current = String::new();
        let mut current_units = 0u64;
        let mut produced = false;
        for word in paragraph.split([' ', '\t']).filter(|w| !w.is_empty()) {
            let word_units: u64 = word.chars().map(units).sum();
            if !current.is_empty() {
                if fits(current_units + space + word_units) {
                    current.push(' ');
                    current.push_str(word);
                    current_units += space + word_units;
                    continue;
                }
                lines.push(std::mem::take(&mut current));
                current_units = 0;
                produced = true;
            }
            if fits(word_units) {
                current.push_str(word);
                current_units = word_units;
                continue;
            }
            // Hard break: as many characters per line as fit, at least one.
            for c in word.chars() {
                let u = units(c);
                if !current.is_empty() && !fits(current_units + u) {
                    lines.push(std::mem::take(&mut current));
                    current_units = 0;
                    produced = true;
                }
                current.push(c);
                current_units += u;
            }
        }
        if !current.is_empty() || !produced {
            lines.push(current);
        }
    }
    lines
}

/// One line placed in visible space: baseline origin and WinAnsi bytes.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PlacedLine {
    pub x: f64,
    pub y: f64,
    pub bytes: Vec<u8>,
}

/// Lines of a text box laid out inside `rect` (`[x, y, w, h]`, visible
/// space). The first baseline sits `ascent * size / 1000` below the top,
/// each next one `line_height * size` lower. A line whose descender would go
/// below the box bottom is dropped, except the first line, which is always
/// kept so text never vanishes silently. Empty lines are not returned.
/// Errors on characters the standard fonts cannot show.
pub(crate) fn layout_text(
    rect: [f64; 4],
    text: &str,
    font: StdFont,
    size: f64,
    align: Align,
    line_height: f64,
) -> Result<Vec<PlacedLine>, String> {
    // Validate the whole text first so the error lists every bad character.
    encode_winansi(&text.replace(['\r', '\n', '\t'], " "))?;
    let [x, y, w, h] = rect;
    let top = y + h;
    let first = top - font.ascent() * size / 1000.0;
    let descent = font.descent() * size / 1000.0;
    let mut out = Vec::new();
    for (i, line) in wrap_lines(text, font, size, w).into_iter().enumerate() {
        let baseline = first - i as f64 * line_height * size;
        if i > 0 && baseline + descent < y {
            break;
        }
        if line.is_empty() {
            continue;
        }
        let bytes = encode_winansi(&line)?;
        let lw = text_width(font, &bytes, size);
        let lx = match align {
            Align::Left => x,
            Align::Center => x + (w - lw) / 2.0,
            Align::Right => x + w - lw,
        };
        out.push(PlacedLine { x: lx, y: baseline, bytes });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn font_of(name: &str) -> StdFont {
        match name {
            "Helvetica" => StdFont::Helvetica,
            "Helvetica-Bold" => StdFont::HelveticaBold,
            "Times-Roman" => StdFont::TimesRoman,
            "Courier" => StdFont::Courier,
            other => panic!("unknown font {other}"),
        }
    }

    #[test]
    fn spec_examples() {
        let hello = text_width(StdFont::Helvetica, b"Hello world", 10.0);
        assert_eq!(wrap_lines("Hello world foo", StdFont::Helvetica, 10.0, hello), ["Hello world", "foo"]);
        assert_eq!(wrap_lines("\n\n", StdFont::Helvetica, 10.0, 100.0), ["", "", ""]);
        assert_eq!(wrap_lines("Hello world   ", StdFont::Helvetica, 10.0, 1000.0), ["Hello world"]);
        assert_eq!(wrap_lines("abcdefghij", StdFont::Courier, 10.0, 25.0), ["abcd", "efgh", "ij"]);
    }

    #[test]
    fn shared_vectors_match() {
        let vectors = json::parse(include_str!("../../../../src/lib/editor/wrapVectors.json"));
        let json::Value::Array(cases) = vectors else { panic!("vectors must be an array") };
        assert!(cases.len() >= 10);
        for case in &cases {
            let text = case.get("text").as_str();
            let font = font_of(case.get("font").as_str());
            let size = case.get("size").as_num();
            let max = case.get("maxWidth").as_num();
            let json::Value::Array(lines) = case.get("lines") else { panic!("lines") };
            let want: Vec<&str> = lines.iter().map(|l| l.as_str()).collect();
            assert_eq!(wrap_lines(text, font, size, max), want, "case {text:?} {max}");
        }
    }

    #[test]
    fn clipped_by_height() {
        // Helvetica 10, line height 1.2: baselines 542.82, 530.82, 518.82,
        // 506.82 (descender 504.75 >= 500), 494.82 (492.75 < 500: dropped).
        let lines = layout_text([100.0, 500.0, 200.0, 50.0], "a\nb\nc\nd\ne\nf", StdFont::Helvetica, 10.0, Align::Left, 1.2)
            .unwrap();
        let ys: Vec<f64> = lines.iter().map(|l| (l.y * 1e6).round() / 1e6).collect();
        assert_eq!(ys, [542.82, 530.82, 518.82, 506.82]);
        assert!(lines.iter().all(|l| l.x == 100.0));
        let texts: Vec<&[u8]> = lines.iter().map(|l| l.bytes.as_slice()).collect();
        assert_eq!(texts, [b"a", b"b", b"c", b"d"]);
    }

    #[test]
    fn first_line_kept_in_a_short_box() {
        let lines = layout_text([0.0, 0.0, 200.0, 2.0], "a\nb", StdFont::Helvetica, 10.0, Align::Left, 1.2).unwrap();
        assert_eq!(lines.len(), 1);
    }

    #[test]
    fn empty_lines_are_skipped_but_advance() {
        let lines = layout_text([0.0, 0.0, 200.0, 100.0], "a\n\nb", StdFont::Courier, 10.0, Align::Left, 1.0).unwrap();
        assert_eq!(lines.len(), 2);
        assert!((lines[0].y - lines[1].y - 20.0).abs() < 1e-9);
    }

    #[test]
    fn align_center_and_right() {
        // Courier 10: "ab" is 12 pt, "abcd" 24 pt, box 100 wide at x = 50.
        let c = layout_text([50.0, 0.0, 100.0, 100.0], "ab\nabcd", StdFont::Courier, 10.0, Align::Center, 1.2).unwrap();
        assert_eq!(c.iter().map(|l| l.x).collect::<Vec<_>>(), [94.0, 88.0]);
        let r = layout_text([50.0, 0.0, 100.0, 100.0], "ab\nabcd", StdFont::Courier, 10.0, Align::Right, 1.2).unwrap();
        assert_eq!(r.iter().map(|l| l.x).collect::<Vec<_>>(), [138.0, 126.0]);
    }

    #[test]
    fn winansi_rejected_with_existing_message() {
        let err = layout_text([0.0, 0.0, 100.0, 100.0], "ok 日本", StdFont::Helvetica, 10.0, Align::Left, 1.2).unwrap_err();
        assert_eq!(err, "Characters not supported by the standard PDF fonts: 日本");
    }

    #[test]
    fn non_ascii_encoded_as_winansi() {
        let lines = layout_text([0.0, 0.0, 300.0, 100.0], "café €", StdFont::Helvetica, 10.0, Align::Left, 1.2).unwrap();
        assert_eq!(lines[0].bytes, vec![b'c', b'a', b'f', 0xE9, b' ', 0x80]);
    }

    /// Minimal JSON reader for the shared test vectors (no serde in the crate).
    mod json {
        #[derive(Debug, Clone)]
        pub enum Value {
            Null,
            Bool(bool),
            Num(f64),
            Str(String),
            Array(Vec<Value>),
            Object(Vec<(String, Value)>),
        }

        impl Value {
            pub fn get(&self, key: &str) -> &Value {
                match self {
                    Value::Object(fields) => &fields.iter().find(|(k, _)| k == key).expect(key).1,
                    _ => panic!("not an object"),
                }
            }
            pub fn as_str(&self) -> &str {
                match self {
                    Value::Str(s) => s,
                    _ => panic!("not a string: {self:?}"),
                }
            }
            pub fn as_num(&self) -> f64 {
                match self {
                    Value::Num(n) => *n,
                    _ => panic!("not a number: {self:?}"),
                }
            }
        }

        pub fn parse(src: &str) -> Value {
            let chars: Vec<char> = src.chars().collect();
            let mut i = 0;
            let v = value(&chars, &mut i);
            skip_ws(&chars, &mut i);
            assert_eq!(i, chars.len(), "trailing data");
            v
        }

        fn skip_ws(c: &[char], i: &mut usize) {
            while *i < c.len() && c[*i].is_whitespace() {
                *i += 1;
            }
        }

        fn value(c: &[char], i: &mut usize) -> Value {
            skip_ws(c, i);
            match c[*i] {
                '[' => {
                    *i += 1;
                    let mut items = Vec::new();
                    loop {
                        skip_ws(c, i);
                        if c[*i] == ']' {
                            *i += 1;
                            return Value::Array(items);
                        }
                        items.push(value(c, i));
                        skip_ws(c, i);
                        if c[*i] == ',' {
                            *i += 1;
                        }
                    }
                }
                '{' => {
                    *i += 1;
                    let mut fields = Vec::new();
                    loop {
                        skip_ws(c, i);
                        if c[*i] == '}' {
                            *i += 1;
                            return Value::Object(fields);
                        }
                        let Value::Str(k) = value(c, i) else { panic!("key") };
                        skip_ws(c, i);
                        assert_eq!(c[*i], ':');
                        *i += 1;
                        fields.push((k, value(c, i)));
                        skip_ws(c, i);
                        if c[*i] == ',' {
                            *i += 1;
                        }
                    }
                }
                '"' => {
                    *i += 1;
                    let mut s = String::new();
                    while c[*i] != '"' {
                        if c[*i] == '\\' {
                            *i += 1;
                            match c[*i] {
                                'n' => s.push('\n'),
                                'r' => s.push('\r'),
                                't' => s.push('\t'),
                                'u' => {
                                    let hex: String = c[*i + 1..*i + 5].iter().collect();
                                    s.push(char::from_u32(u32::from_str_radix(&hex, 16).unwrap()).unwrap());
                                    *i += 4;
                                }
                                other => s.push(other),
                            }
                        } else {
                            s.push(c[*i]);
                        }
                        *i += 1;
                    }
                    *i += 1;
                    Value::Str(s)
                }
                't' => {
                    *i += 4;
                    Value::Bool(true)
                }
                'f' => {
                    *i += 5;
                    Value::Bool(false)
                }
                'n' => {
                    *i += 4;
                    Value::Null
                }
                _ => {
                    let start = *i;
                    while *i < c.len() && matches!(c[*i], '-' | '+' | '.' | 'e' | 'E' | '0'..='9') {
                        *i += 1;
                    }
                    Value::Num(c[start..*i].iter().collect::<String>().parse().unwrap())
                }
            }
        }
    }
}
