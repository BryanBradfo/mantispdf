//! Stage 3 — Math OCR (ADR 02, Path C).
//!
//! pix2tex (LaTeX-OCR) exported to ONNX and run in-process via `ort`
//! (ONNX Runtime). Three graphs are chained, mirroring the reference
//! `rapid_latex_ocr` pipeline:
//!
//!   crop image
//!     └─ preprocess (grayscale, invert, bbox-crop, pad to /32, normalize)
//!     └─ image_resizer.onnx : iterative width search for the model's aspect
//!     └─ encoder.onnx        : image  -> context memory
//!     └─ decoder.onnx (loop) : greedy autoregressive decode -> token ids
//!     └─ tokenizer + post_process -> LaTeX string
//!
//! `temperature = 1e-5` in the reference collapses its top-k/softmax/multinomial
//! sampler to deterministic argmax, so the decode loop here is plain greedy.
//!
//! Everything runs locally in the Tauri backend — no Python, no cloud. The
//! `MathOcr` trait is the seam from ADR 02: swapping models means a new `impl`,
//! nothing else changes.

use anyhow::{anyhow, Context, Result};
use image::{DynamicImage, GrayImage, Luma};
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;
use std::path::Path;
use tokenizers::Tokenizer;

// pix2tex config.yaml (RapidLaTeXOCR).
const MAX_W: u32 = 672;
const MAX_H: u32 = 192;
const MIN_W: u32 = 32;
const MIN_H: u32 = 32;
const DIVABLE: u32 = 32;
const BOS: i64 = 1;
const EOS: i64 = 2;
const MAX_SEQ_LEN: usize = 512;
// Grayscale normalization (single channel, replicated).
const MEAN: f32 = 0.7931;
const STD: f32 = 0.1738;

/// ADR 02 Stage-3 seam: one isolated math crop in, LaTeX out.
pub trait MathOcr {
    fn recognize(&mut self, image: &DynamicImage) -> Result<String>;
}

pub struct Pix2TexOnnx {
    image_resizer: Session,
    encoder: Session,
    decoder: Session,
    tokenizer: Tokenizer,
}

impl Pix2TexOnnx {
    /// Load the three ONNX graphs + tokenizer from a weights directory
    /// (expects image_resizer.onnx, encoder.onnx, decoder.onnx, tokenizer.json).
    pub fn from_dir(dir: impl AsRef<Path>) -> Result<Self> {
        let dir = dir.as_ref();
        let session = |name: &str| -> Result<Session> {
            Session::builder()?
                .with_optimization_level(GraphOptimizationLevel::Level3)?
                .commit_from_file(dir.join(name))
                .with_context(|| format!("load {name}"))
        };
        let tokenizer = Tokenizer::from_file(dir.join("tokenizer.json"))
            .map_err(|e| anyhow!("load tokenizer: {e}"))?;
        Ok(Self {
            image_resizer: session("image_resizer.onnx")?,
            encoder: session("encoder.onnx")?,
            decoder: session("decoder.onnx")?,
            tokenizer,
        })
    }

    /// Run encoder.onnx on a [1,1,H,W] f32 tensor, return (context, shape).
    fn encode(&mut self, img: &PreprocImage) -> Result<(Vec<f32>, Vec<i64>)> {
        let input = Tensor::from_array((
            [1usize, 1, img.h as usize, img.w as usize],
            img.data.clone(),
        ))?;
        let outputs = self.encoder.run(ort::inputs!["input" => input])?;
        let (shape, data) = outputs["output"].try_extract_tensor::<f32>()?;
        Ok((data.to_vec(), shape.to_vec()))
    }

    /// Greedy autoregressive decode against the encoder context.
    fn decode(&mut self, ctx_data: &[f32], ctx_shape: &[i64]) -> Result<Vec<u32>> {
        let mut out: Vec<i64> = vec![BOS];
        for _ in 0..MAX_SEQ_LEN {
            let start = out.len().saturating_sub(MAX_SEQ_LEN);
            let window = &out[start..];
            let len = window.len();

            let x = Tensor::from_array(([1usize, len], window.to_vec()))?;
            let mask = Tensor::from_array(([1usize, len], vec![true; len]))?;
            let ctx = Tensor::from_array((
                ctx_shape.iter().map(|&d| d as usize).collect::<Vec<_>>(),
                ctx_data.to_vec(),
            ))?;

            let outputs = self.decoder.run(ort::inputs![
                "x" => x,
                "mask" => mask,
                "context" => ctx,
            ])?;
            let (shape, logits) = outputs["output"].try_extract_tensor::<f32>()?;
            // shape = [1, seq, vocab]; take the last position's logits.
            let vocab = shape[2] as usize;
            let seq = shape[1] as usize;
            let last = &logits[(seq - 1) * vocab..seq * vocab];

            let next = argmax(last) as i64;
            out.push(next);
            if next == EOS {
                break;
            }
        }
        // Drop the leading BOS; cast to u32 for the tokenizer.
        Ok(out[1..].iter().map(|&t| t as u32).collect())
    }

    /// Detokenize like rapid_latex_ocr: concatenate raw tokens (no inter-token
    /// spaces), turn the byte-level space marker `Ġ` into a real space, strip
    /// the special tokens, run pix2tex `post_process`, then clean up the
    /// bounding-box artifacts (stray citations/punctuation/leading subscript).
    fn detokenize(&self, ids: &[u32]) -> String {
        let mut s = String::new();
        for &id in ids {
            if let Some(tok) = self.tokenizer.id_to_token(id) {
                s.push_str(&tok);
            }
        }
        s = s
            .replace('Ġ', " ")
            .replace("[EOS]", "")
            .replace("[BOS]", "")
            .replace("[PAD]", "");
        clean_artifacts(&post_process(s.trim()))
    }
}

impl MathOcr for Pix2TexOnnx {
    fn recognize(&mut self, image: &DynamicImage) -> Result<String> {
        let preproc = self.preprocess(image)?;
        let (ctx_data, ctx_shape) = self.encode(&preproc)?;
        let ids = self.decode(&ctx_data, &ctx_shape)?;
        Ok(self.detokenize(&ids))
    }
}

/// A preprocessed, model-ready tensor: single-channel f32, shape [1,1,h,w].
struct PreprocImage {
    w: u32,
    h: u32,
    data: Vec<f32>,
}

impl Pix2TexOnnx {
    /// Full preprocessing + the iterative image_resizer width search.
    fn preprocess(&mut self, image: &DynamicImage) -> Result<PreprocImage> {
        // Initial: bbox-crop + pad, fit to max/min dims.
        let gray0 = image.to_luma8();
        let padded = pad(&gray0);
        let input_image = minmax_size(&padded);

        let mut r: f32 = 1.0;
        let mut w = input_image.width();
        let mut h = input_image.height();
        let mut final_img = to_model_tensor(&input_image); // fallback if loop never sets it

        for _ in 0..10 {
            h = (h as f32 * r) as u32;
            let (tensor, pad_w) = self.pre_process_once(&input_image, r, w, h);
            final_img = tensor;

            let resizer_logits = {
                let input = Tensor::from_array((
                    [1usize, 1, final_img.h as usize, final_img.w as usize],
                    final_img.data.clone(),
                ))?;
                let outputs = self.image_resizer.run(ort::inputs!["input" => input])?;
                let (_shape, data) = outputs["output"].try_extract_tensor::<f32>()?;
                data.to_vec()
            };

            let argmax_idx = argmax(&resizer_logits) as u32;
            w = (argmax_idx + 1) * 32;
            if w == pad_w {
                break;
            }
            r = w as f32 / pad_w as f32;
        }
        Ok(final_img)
    }

    /// One resizer iteration: resize the source to (w,h), pad, normalize.
    /// Returns the model tensor and the padded width (the loop's stop signal).
    fn pre_process_once(
        &self,
        input_image: &GrayImage,
        r: f32,
        w: u32,
        h: u32,
    ) -> (PreprocImage, u32) {
        let filter = if r > 1.0 {
            // BILINEAR upscale ~ Triangle; LANCZOS downscale ~ Lanczos3.
            image::imageops::FilterType::Triangle
        } else {
            image::imageops::FilterType::Lanczos3
        };
        let resized = image::imageops::resize(input_image, w.max(1), h.max(1), filter);
        let padded = pad(&minmax_size(&resized));
        let pad_w = padded.width();
        (to_model_tensor(&padded), pad_w)
    }
}

/// pix2tex `pad`: invert so text is dark-on-light, crop to the text bounding
/// box, then pad each side up to the next multiple of 32 on a white canvas.
fn pad(img: &GrayImage) -> GrayImage {
    let (w, h) = img.dimensions();
    let n = (w * h) as usize;
    if n == 0 {
        return GrayImage::from_pixel(MIN_W, MIN_H, Luma([255]));
    }

    // Min-max stretch to 0..255.
    let mut data: Vec<f32> = img.pixels().map(|p| p.0[0] as f32).collect();
    let (mut lo, mut hi) = (f32::INFINITY, f32::NEG_INFINITY);
    for &v in &data {
        lo = lo.min(v);
        hi = hi.max(v);
    }
    if hi > lo {
        for v in &mut data {
            *v = (*v - lo) / (hi - lo) * 255.0;
        }
    }

    let mean = data.iter().sum::<f32>() / n as f32;
    // text mask + ensure `data` ends up light-background / dark-text.
    let mut mask = vec![false; n];
    if mean > 128.0 {
        for i in 0..n {
            mask[i] = data[i] < 128.0;
        }
    } else {
        for i in 0..n {
            mask[i] = data[i] > 128.0;
            data[i] = 255.0 - data[i];
        }
    }

    // Bounding box of text pixels.
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (w, h, 0u32, 0u32);
    let mut any = false;
    for y in 0..h {
        for x in 0..w {
            if mask[(y * w + x) as usize] {
                any = true;
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x);
                max_y = max_y.max(y);
            }
        }
    }
    if !any {
        min_x = 0;
        min_y = 0;
        max_x = w - 1;
        max_y = h - 1;
    }
    let bw = max_x - min_x + 1;
    let bh = max_y - min_y + 1;

    let pw = bw.div_ceil(DIVABLE) * DIVABLE;
    let ph = bh.div_ceil(DIVABLE) * DIVABLE;

    let mut out = GrayImage::from_pixel(pw, ph, Luma([255]));
    for y in 0..bh {
        for x in 0..bw {
            let v = data[((min_y + y) * w + (min_x + x)) as usize];
            out.put_pixel(x, y, Luma([v.round().clamp(0.0, 255.0) as u8]));
        }
    }
    out
}

/// pix2tex `minmax_size`: scale down to fit MAX dims, pad up to MIN dims.
fn minmax_size(img: &GrayImage) -> GrayImage {
    let (mut w, mut h) = img.dimensions();
    let mut cur = img.clone();

    let ratios = [w as f32 / MAX_W as f32, h as f32 / MAX_H as f32];
    let max_ratio = ratios[0].max(ratios[1]);
    if max_ratio > 1.0 {
        w = ((w as f32 / max_ratio) as u32).max(1);
        h = ((h as f32 / max_ratio) as u32).max(1);
        cur = image::imageops::resize(&cur, w, h, image::imageops::FilterType::Triangle);
    }

    let pw = w.max(MIN_W);
    let ph = h.max(MIN_H);
    if pw != w || ph != h {
        let mut padded = GrayImage::from_pixel(pw, ph, Luma([255]));
        image::imageops::overlay(&mut padded, &cur, 0, 0);
        cur = padded;
    }
    cur
}

/// Grayscale -> normalized [1,1,H,W] f32 tensor (mean/std on 0..255 scale).
fn to_model_tensor(img: &GrayImage) -> PreprocImage {
    let (w, h) = img.dimensions();
    let mean = MEAN * 255.0;
    let inv_std = 1.0 / (STD * 255.0);
    let data: Vec<f32> = img
        .pixels()
        .map(|p| (p.0[0] as f32 - mean) * inv_std)
        .collect();
    PreprocImage { w, h, data }
}

fn argmax(v: &[f32]) -> usize {
    let mut best = 0usize;
    let mut best_val = f32::NEG_INFINITY;
    for (i, &x) in v.iter().enumerate() {
        if x > best_val {
            best_val = x;
            best = i;
        }
    }
    best
}

/// pix2tex `post_process`: collapse the stray spaces the byte-level detokenizer
/// leaves between LaTeX tokens. Ported from rapid_latex_ocr.main.post_process.
fn post_process(s: &str) -> String {
    use regex::Regex;
    let text_reg = Regex::new(r"(\\(operatorname|mathrm|text|mathbf)\s?\*?\{.*?\})").unwrap();
    let letter = "[a-zA-Z]";
    let noletter = r"[\W_^\d]";

    // Collapse spaces inside \operatorname{...}/\mathrm{...}/etc.
    let mut names: Vec<String> = text_reg
        .find_iter(s)
        .map(|m| m.as_str().replace(' ', ""))
        .collect();
    names.reverse();
    let s = text_reg.replace_all(s, |_: &regex::Captures| names.pop().unwrap_or_default());

    let re1 = Regex::new(&format!(r"(?P<a>{noletter})\s+?(?P<b>{noletter})")).unwrap();
    let re2 = Regex::new(&format!(r"(?P<a>{noletter})\s+?(?P<b>{letter})")).unwrap();
    let re3 = Regex::new(&format!(r"(?P<a>{letter})\s+?(?P<b>{noletter})")).unwrap();

    let mut news = s.into_owned();
    loop {
        let s = news.clone();
        // The Python guard is `(?!\\ )` (don't touch an escaped space); the
        // simple replacements below suffice for the model's output.
        news = re1.replace_all(&news, "$a$b").into_owned();
        news = re2.replace_all(&news, "$a$b").into_owned();
        news = re3.replace_all(&news, "$a$b").into_owned();
        if news == s {
            break;
        }
    }
    news
}

/// Strip bounding-box artifacts the OCR picks up when a crop includes adjacent
/// text: a trailing numeric citation (`[24]`), trailing punctuation read as math
/// (`_{.}`, `_.`, `.`, `,`), and a stray leading subscript underscore. These are
/// crop-edge noise, not part of the equation. Conservative on purpose — only a
/// single-integer trailing `[n]` is treated as a citation, so genuine intervals
/// like `[0,1]` are left intact.
fn clean_artifacts(s: &str) -> String {
    use regex::Regex;
    let cite = Regex::new(r"\s*\[\s*\d+\s*\]\s*$").unwrap();
    let trailing_punct = Regex::new(r"(?:_\{\.\}|_\.|[.,])\s*$").unwrap();
    let leading_underscore = Regex::new(r"^_+").unwrap();

    let mut t = s.trim().to_string();
    // A crop edge can leave both a citation and a period; strip until stable.
    loop {
        let before = t.clone();
        t = cite.replace(&t, "").trim().to_string();
        t = trailing_punct.replace(&t, "").trim().to_string();
        if t == before {
            break;
        }
    }
    leading_underscore.replace(&t, "").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_bounding_box_artifacts() {
        // trailing citation + stray leading subscript underscore
        assert_eq!(
            clean_artifacts(r"_{\alpha}(\theta)=\theta_{E}{\frac{\theta}{|\theta|}}[24]"),
            r"{\alpha}(\theta)=\theta_{E}{\frac{\theta}{|\theta|}}"
        );
        // trailing period read as a subscript
        assert_eq!(
            clean_artifacts(r"\beta=\theta-\theta_{E}{\frac{\theta}{\left|\theta\right|}}_{.}"),
            r"\beta=\theta-\theta_{E}{\frac{\theta}{\left|\theta\right|}}"
        );
        // idempotent on already-clean output
        assert_eq!(
            clean_artifacts(r"\beta=\theta-\theta_{E}\frac{\theta}{|\theta|}"),
            r"\beta=\theta-\theta_{E}\frac{\theta}{|\theta|}"
        );
        // leaves a genuine trailing interval intact
        assert_eq!(clean_artifacts(r"x\in[0,1]"), r"x\in[0,1]");
    }

    /// Validates the Rust ONNX port against the Python `rapid_latex_ocr` golden.
    /// Ignored by default: needs the gitignored weights and the spike's saved
    /// crop. Run with:
    ///   cargo test --release -- --ignored golden_beta --nocapture
    #[test]
    #[ignore]
    fn golden_beta() {
        let weights = concat!(env!("CARGO_MANIFEST_DIR"), "/weights");
        let crop = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../spikes/math-ocr-spike/out/neurips_beta_crop.png"
        );
        let mut engine = Pix2TexOnnx::from_dir(weights).expect("load engine");
        let img = image::open(crop).expect("load crop image");
        let latex = engine.recognize(&img).expect("recognize");
        println!("Rust output : {latex}");
        println!("Python golden: \\beta=\\theta-\\theta_{{E}}\\frac{{\\theta}}{{|\\theta|}}");
        assert_eq!(latex, r"\beta=\theta-\theta_{E}\frac{\theta}{|\theta|}");
    }
}
