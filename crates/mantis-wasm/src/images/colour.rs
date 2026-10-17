//! Pure conversions from PDF image samples to RGBA8.
//!
//! Every function takes untrusted sizes: a `Layout` is only built from
//! validated dimensions, and converters return `None` instead of reading
//! past the sample data.

/// Most pixels one extracted image may have.
pub(crate) const MAX_PIXELS: u64 = 100_000_000;

/// Device colour space a sample (or a palette entry) is expressed in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Base {
    Gray,
    Rgb,
    Cmyk,
}

impl Base {
    pub(crate) fn components(self) -> usize {
        match self {
            Base::Gray => 1,
            Base::Rgb => 3,
            Base::Cmyk => 4,
        }
    }

    /// The base for an ICC profile with `n` components.
    pub(crate) fn from_components(n: i64) -> Option<Base> {
        match n {
            1 => Some(Base::Gray),
            3 => Some(Base::Rgb),
            4 => Some(Base::Cmyk),
            _ => None,
        }
    }

    /// RGB of one sample whose components are already scaled to 0..=255.
    fn rgb(self, c: &[u8]) -> [u8; 3] {
        match self {
            Base::Gray => [c[0], c[0], c[0]],
            Base::Rgb => [c[0], c[1], c[2]],
            Base::Cmyk => {
                let k = 255 - u32::from(c[3]);
                let ch = |v: u8| (((255 - u32::from(v)) * k + 127) / 255) as u8;
                [ch(c[0]), ch(c[1]), ch(c[2])]
            }
        }
    }
}

/// Colour space of an image's samples.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Space {
    Device(Base),
    /// Palette of `hival + 1` entries of `base` components each; missing
    /// entries of a short lookup table are black.
    Indexed { base: Base, hival: u8, lookup: Vec<u8> },
}

impl Space {
    pub(crate) fn components(&self) -> usize {
        match self {
            Space::Device(base) => base.components(),
            Space::Indexed { .. } => 1,
        }
    }
}

/// Why image dimensions were refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Invalid {
    Corrupt,
    TooLarge,
}

/// Validated geometry of an image's sample data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Layout {
    pub width: usize,
    pub height: usize,
    pub bpc: u8,
    pub components: usize,
    /// Bytes per row (rows start on a byte boundary).
    pub row_bytes: usize,
}

impl Layout {
    /// Width and height >= 1, BitsPerComponent 1/2/4/8/16, 1..=4
    /// components, at most `MAX_PIXELS` pixels, and sizes (samples and
    /// RGBA output) that fit in `usize`.
    pub(crate) fn new(width: i64, height: i64, bpc: i64, components: usize) -> Result<Layout, Invalid> {
        if width < 1 || height < 1 || !matches!(bpc, 1 | 2 | 4 | 8 | 16) || !(1..=4).contains(&components) {
            return Err(Invalid::Corrupt);
        }
        let (w, h) = (width as u64, height as u64);
        let pixels = w.checked_mul(h).ok_or(Invalid::TooLarge)?;
        if pixels > MAX_PIXELS {
            return Err(Invalid::TooLarge);
        }
        // w <= MAX_PIXELS here, so none of this overflows u64.
        let row_bytes = (w * bpc as u64 * components as u64).div_ceil(8);
        let data = row_bytes * h;
        if usize::try_from(data).is_err() || usize::try_from(pixels * 4).is_err() {
            return Err(Invalid::TooLarge);
        }
        Ok(Layout {
            width: w as usize,
            height: h as usize,
            bpc: bpc as u8,
            components,
            row_bytes: row_bytes as usize,
        })
    }

    pub(crate) fn pixels(&self) -> usize {
        self.width * self.height
    }

    /// Bytes of sample data the image needs.
    pub(crate) fn data_len(&self) -> usize {
        self.row_bytes * self.height
    }
}

/// Bits a sample contributes after reduction: 16-bit samples keep their
/// high byte.
fn effective_bits(bpc: u8) -> u8 {
    bpc.min(8)
}

/// Per-component lookup from a raw sample to its decoded byte: a colour
/// component maps to 0..=255 through the /Decode range (default [0 1]); an
/// index maps through it (default [0 2^bpc-1]) and is clamped to `hival`.
fn decode_luts(bpc: u8, components: usize, decode: Option<&[f64]>, hival: Option<u8>) -> Vec<[u8; 256]> {
    let max_raw = ((1u32 << bpc) - 1) as f64;
    let levels = 1usize << effective_bits(bpc);
    let max_level = (levels - 1) as f64;
    let decode = decode.filter(|d| d.len() == 2 * components && d.iter().all(|v| v.is_finite()));
    (0..components)
        .map(|c| {
            let (dmin, dmax) = match (decode, hival) {
                (Some(d), _) => (d[2 * c], d[2 * c + 1]),
                (None, Some(_)) => (0.0, max_raw),
                (None, None) => (0.0, 1.0),
            };
            let mut lut = [0u8; 256];
            for (v, out) in lut.iter_mut().enumerate().take(levels) {
                let x = dmin + v as f64 * (dmax - dmin) / max_level;
                *out = match hival {
                    Some(h) => x.round().clamp(0.0, f64::from(h)) as u8,
                    None => (x * 255.0).round().clamp(0.0, 255.0) as u8,
                };
            }
            lut
        })
        .collect()
}

/// Raw sample `s` of a row (16-bit samples: the high byte).
#[inline]
fn sample(row: &[u8], s: usize, bpc: u8) -> u8 {
    match bpc {
        8 => row[s],
        16 => row[2 * s],
        _ => {
            let bit = s * bpc as usize;
            let shift = 8 - bpc as usize - (bit % 8);
            (row[bit / 8] >> shift) & ((1u8 << bpc) - 1)
        }
    }
}

/// Calls `f(pixel, decoded components)` for every pixel in order, or
/// returns false when the data is shorter than the layout needs.
fn for_each_pixel(data: &[u8], layout: &Layout, luts: &[[u8; 256]], mut f: impl FnMut(usize, &[u8])) -> bool {
    if data.len() < layout.data_len() || luts.len() != layout.components {
        return false;
    }
    let n = layout.components;
    let mut px = [0u8; 4];
    for (y, row) in data.chunks_exact(layout.row_bytes).take(layout.height).enumerate() {
        for x in 0..layout.width {
            for c in 0..n {
                px[c] = luts[c][sample(row, x * n + c, layout.bpc) as usize];
            }
            f(y * layout.width + x, &px[..n]);
        }
    }
    true
}

/// Opaque RGBA8 of an image in `space`. None when the layout does not
/// match the space or the data is short.
pub(crate) fn to_rgba(data: &[u8], layout: &Layout, space: &Space, decode: Option<&[f64]>) -> Option<Vec<u8>> {
    if layout.components != space.components() {
        return None;
    }
    let mut out = vec![0u8; layout.pixels().checked_mul(4)?];
    let ok = match space {
        Space::Device(base) => {
            let luts = decode_luts(layout.bpc, layout.components, decode, None);
            for_each_pixel(data, layout, &luts, |i, c| {
                let [r, g, b] = base.rgb(c);
                out[4 * i..4 * i + 4].copy_from_slice(&[r, g, b, 255]);
            })
        }
        Space::Indexed { base, hival, lookup } => {
            if layout.bpc > 8 {
                return None;
            }
            let n = base.components();
            let mut palette = [[0u8, 0, 0, 255]; 256];
            let mut entry = [0u8; 4];
            for (i, rgba) in palette.iter_mut().enumerate().take(*hival as usize + 1) {
                for (c, slot) in entry.iter_mut().enumerate().take(n) {
                    *slot = lookup.get(i * n + c).copied().unwrap_or(0);
                }
                let [r, g, b] = base.rgb(&entry[..n]);
                *rgba = [r, g, b, 255];
            }
            let luts = decode_luts(layout.bpc, 1, decode, Some(*hival));
            for_each_pixel(data, layout, &luts, |i, c| {
                out[4 * i..4 * i + 4].copy_from_slice(&palette[c[0] as usize]);
            })
        }
    };
    ok.then_some(out)
}

/// Alpha of a 1-bit stencil: 255 where the stencil paints. With the
/// default /Decode [0 1] a 0 sample paints; [1 0] inverts it.
pub(crate) fn stencil_alpha(data: &[u8], layout: &Layout, decode: Option<&[f64]>) -> Option<Vec<u8>> {
    if layout.bpc != 1 || layout.components != 1 {
        return None;
    }
    let inverted = decode.is_some_and(|d| d.len() == 2 && d[0] > d[1]);
    let paint = if inverted { 1 } else { 0 };
    let luts = [{
        let mut lut = [0u8; 256];
        lut[0] = if paint == 0 { 255 } else { 0 };
        lut[1] = if paint == 1 { 255 } else { 0 };
        lut
    }];
    let mut out = vec![0u8; layout.pixels()];
    for_each_pixel(data, layout, &luts, |i, c| out[i] = c[0]).then_some(out)
}

/// RGBA of an /ImageMask: black where it paints, transparent elsewhere.
pub(crate) fn stencil_rgba(data: &[u8], layout: &Layout, decode: Option<&[f64]>) -> Option<Vec<u8>> {
    let alpha = stencil_alpha(data, layout, decode)?;
    let mut out = vec![0u8; alpha.len().checked_mul(4)?];
    for (px, a) in out.chunks_exact_mut(4).zip(alpha) {
        px[3] = a;
    }
    Some(out)
}

/// Alpha from a DeviceGray soft mask (any bit depth, optional /Decode).
pub(crate) fn gray_alpha(data: &[u8], layout: &Layout, decode: Option<&[f64]>) -> Option<Vec<u8>> {
    if layout.components != 1 {
        return None;
    }
    let luts = decode_luts(layout.bpc, 1, decode, None);
    let mut out = vec![0u8; layout.pixels()];
    for_each_pixel(data, layout, &luts, |i, c| out[i] = c[0]).then_some(out)
}

/// Replace the alpha channel of `rgba` with `alpha` (one byte per pixel).
pub(crate) fn apply_alpha(rgba: &mut [u8], alpha: &[u8]) {
    for (px, a) in rgba.chunks_exact_mut(4).zip(alpha) {
        px[3] = *a;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout(w: i64, h: i64, bpc: i64, n: usize) -> Layout {
        Layout::new(w, h, bpc, n).unwrap()
    }

    #[test]
    fn layout_rejects_bad_dimensions() {
        assert_eq!(Layout::new(0, 1, 8, 3), Err(Invalid::Corrupt));
        assert_eq!(Layout::new(1, -5, 8, 3), Err(Invalid::Corrupt));
        assert_eq!(Layout::new(4, 4, 3, 1), Err(Invalid::Corrupt));
        assert_eq!(Layout::new(4, 4, 8, 5), Err(Invalid::Corrupt));
        assert_eq!(Layout::new(100_000, 100_000, 8, 3), Err(Invalid::TooLarge));
        assert_eq!(Layout::new(i64::MAX, i64::MAX, 8, 3), Err(Invalid::TooLarge));
        assert_eq!(Layout::new(10_000, 10_000, 8, 1).map(|l| l.pixels()), Ok(100_000_000));
    }

    #[test]
    fn layout_rows_are_byte_aligned() {
        let l = layout(3, 2, 1, 1);
        assert_eq!((l.row_bytes, l.data_len()), (1, 2));
        let l = layout(5, 1, 16, 3);
        assert_eq!(l.row_bytes, 30);
    }

    #[test]
    fn rgb_8bit_2x2() {
        let data = [255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30];
        let out = to_rgba(&data, &layout(2, 2, 8, 3), &Space::Device(Base::Rgb), None).unwrap();
        assert_eq!(out, vec![255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 10, 20, 30, 255]);
    }

    #[test]
    fn gray_1bit_with_inverted_decode() {
        // Width 3: each row is one byte, padding bits ignored.
        let data = [0b1010_0000, 0b0101_1111];
        let l = layout(3, 2, 1, 1);
        let plain = to_rgba(&data, &l, &Space::Device(Base::Gray), None).unwrap();
        let gray: Vec<u8> = plain.chunks(4).map(|p| p[0]).collect();
        assert_eq!(gray, vec![255, 0, 255, 0, 255, 0]);
        let inv = to_rgba(&data, &l, &Space::Device(Base::Gray), Some(&[1.0, 0.0])).unwrap();
        let gray: Vec<u8> = inv.chunks(4).map(|p| p[0]).collect();
        assert_eq!(gray, vec![0, 255, 0, 255, 0, 255]);
    }

    #[test]
    fn gray_2_and_4_bit_scale_to_full_range() {
        let out = to_rgba(&[0b00_01_10_11], &layout(4, 1, 2, 1), &Space::Device(Base::Gray), None).unwrap();
        let gray: Vec<u8> = out.chunks(4).map(|p| p[0]).collect();
        assert_eq!(gray, vec![0, 85, 170, 255]);
        let out = to_rgba(&[0x0F, 0x80], &layout(4, 1, 4, 1), &Space::Device(Base::Gray), None).unwrap();
        let gray: Vec<u8> = out.chunks(4).map(|p| p[0]).collect();
        assert_eq!(gray, vec![0, 255, 136, 0]);
    }

    #[test]
    fn indexed_rgb_hival_1() {
        let space = Space::Indexed { base: Base::Rgb, hival: 1, lookup: vec![255, 0, 0, 0, 0, 255] };
        let out = to_rgba(&[0, 1, 1, 0], &layout(2, 2, 8, 1), &space, None).unwrap();
        assert_eq!(out, vec![255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255, 255, 0, 0, 255]);
        // An index past hival clamps; a short lookup gives black.
        let space = Space::Indexed { base: Base::Rgb, hival: 2, lookup: vec![1, 2, 3] };
        let out = to_rgba(&[9, 1], &layout(2, 1, 8, 1), &space, None).unwrap();
        assert_eq!(out, vec![0, 0, 0, 255, 0, 0, 0, 255]);
    }

    #[test]
    fn indexed_1bit_cmyk_base() {
        let space = Space::Indexed { base: Base::Cmyk, hival: 1, lookup: vec![0, 0, 0, 0, 0, 0, 0, 255] };
        let out = to_rgba(&[0b0100_0000], &layout(2, 1, 1, 1), &space, None).unwrap();
        assert_eq!(out, vec![255, 255, 255, 255, 0, 0, 0, 255]);
    }

    #[test]
    fn cmyk_pixel_conversion() {
        let data = [0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 255, 0, 128, 255, 51];
        let out = to_rgba(&data, &layout(4, 1, 8, 4), &Space::Device(Base::Cmyk), None).unwrap();
        // r = 255 (1-c)(1-k): (0,128,255,51) -> k' = 204 -> (204, 102, 0).
        assert_eq!(out, vec![255, 255, 255, 255, 0, 255, 255, 255, 0, 0, 0, 255, 204, 102, 0, 255]);
    }

    #[test]
    fn sixteen_bit_keeps_high_byte() {
        let data = [0x12, 0x34, 0xAB, 0xCD, 0xFF, 0xFF];
        let out = to_rgba(&data, &layout(1, 1, 16, 3), &Space::Device(Base::Rgb), None).unwrap();
        assert_eq!(out, vec![0x12, 0xAB, 0xFF, 255]);
    }

    #[test]
    fn decode_maps_each_component_linearly() {
        let out = to_rgba(&[0, 255, 255], &layout(1, 1, 8, 3), &Space::Device(Base::Rgb), Some(&[1.0, 0.0, 0.0, 0.5, 0.0, 1.0])).unwrap();
        assert_eq!(out, vec![255, 128, 255, 255]);
        // A malformed decode array falls back to the default.
        let out = to_rgba(&[7, 8, 9], &layout(1, 1, 8, 3), &Space::Device(Base::Rgb), Some(&[1.0, 0.0])).unwrap();
        assert_eq!(out, vec![7, 8, 9, 255]);
    }

    #[test]
    fn short_data_and_mismatched_space_are_refused() {
        assert!(to_rgba(&[1, 2, 3], &layout(2, 1, 8, 3), &Space::Device(Base::Rgb), None).is_none());
        assert!(to_rgba(&[1, 2, 3], &layout(1, 1, 8, 3), &Space::Device(Base::Gray), None).is_none());
        assert!(gray_alpha(&[], &layout(1, 1, 8, 1), None).is_none());
        assert!(stencil_alpha(&[], &layout(1, 1, 1, 1), None).is_none());
    }

    #[test]
    fn image_mask_paints_zero_black_by_default() {
        let l = layout(2, 1, 1, 1);
        let out = stencil_rgba(&[0b0100_0000], &l, None).unwrap();
        assert_eq!(out, vec![0, 0, 0, 255, 0, 0, 0, 0]);
        let out = stencil_rgba(&[0b0100_0000], &l, Some(&[1.0, 0.0])).unwrap();
        assert_eq!(out, vec![0, 0, 0, 0, 0, 0, 0, 255]);
    }

    #[test]
    fn soft_mask_alpha_applies() {
        let l = layout(2, 1, 8, 1);
        let alpha = gray_alpha(&[0, 200], &l, None).unwrap();
        assert_eq!(alpha, vec![0, 200]);
        let mut rgba = to_rgba(&[1, 2, 3, 4, 5, 6], &layout(2, 1, 8, 3), &Space::Device(Base::Rgb), None).unwrap();
        apply_alpha(&mut rgba, &alpha);
        assert_eq!(rgba, vec![1, 2, 3, 0, 4, 5, 6, 200]);
    }
}
