# ADR 02 — Stage 3: Math OCR (crop → image → LaTeX)

- **Status:** Accepted
- **Date:** 2026-06-17
- **Deciders:** Bryan Chen (product), AI architecture review
- **Context tags:** privacy-first, local-only, B2B, Tauri desktop, Candle, headless-capable
- **Supersedes:** the Stage-3 sketch in [ADR 01](./01-extraction-engine.md) (refines it; does not change the three-stage decision)

## Context

ADR 01 fixed the three-stage pipeline and proved the decisive point: linear text
parsers (born-digital *or* OCR) destroy 2D math structure, so a dedicated
image→LaTeX model is **mandatory on every PDF**, not a scanned-page fallback.
Stage 1 (LiteParse) and the Stage-2 math-region heuristic now run for real; the
heuristic emits `MathRegion`s with a page index and a bounding box.

Stage 3 turns each tagged region into LaTeX. Three things must be decided before
writing the Rust:

1. **Where do we rasterize the crop** — in the browser (canvas) or in the Rust
   backend (PDFium)?
2. **What is the model boundary** so the OCR engine can be swapped without
   touching cropping or Markdown assembly?
3. **How are model weights distributed** under the local-first / B2B privacy
   constraint?

## Decision

### 1. Crop in the Rust backend with PDFium. The frontend passes only boxes.

The frontend's sole responsibility is to hand the backend a list of
`{ page, bbox }` (the Stage-2 output) alongside the PDF bytes it already sends to
`extract_document`. **All rasterization happens in Rust via PDFium.**

```
Stage 2 (heuristic)            Stage 3 (this ADR, native Rust)
  MathRegion { page, bbox } ──► ocr_math_regions(bytes, regions)
                                   │ PDFium render page @ ~300 DPI
                                   │ crop bbox → clean RGB tile
                                   │ MathOcr::recognize(tile) → LaTeX
                                   └─► [{ region_id, latex }]
```

**Why backend, not canvas (finalized):**

- **Pixel fidelity is non-negotiable for math OCR.** PDFium renders directly
  from the page content stream at any chosen DPI. Canvas cropping inherits
  `devicePixelRatio` guesswork, CSS scaling, and a re-encode (canvas → PNG →
  bytes) that softens the hairline glyphs (sub/superscripts, fraction bars,
  summation limits) the model most depends on.
- **One source of truth for rasterization.** PDFium already backs Stage 1
  (LiteParse). Rendering crops with the same engine keeps coordinate handling
  and font rendering consistent end-to-end.
- **Keeps a headless path open.** A future CLI (`mantis extract paper.pdf`) must
  run with no browser/DOM. Backend cropping means Stages 1–3 are pure Rust and
  the CLI is the same code path minus the React shell.

**Integration detail to get right — the coordinate transform.** PDF user space
has its origin at the **bottom-left** in points (1/72"), while a rendered raster
is **top-left** in pixels. The crop rectangle must convert the Stage-2 bbox into
device pixels and flip the y-axis:

```
scale   = dpi / 72
left_px = bbox.x * scale
top_px  = (page_height_pt - (bbox.y + bbox.height)) * scale   // if bbox.y is bottom-left
width_px, height_px = bbox.{width,height} * scale
```

LiteParse's bbox convention (top-left vs bottom-left, and whether values are
already in points) **must be verified against PDFium output** during
implementation — the spike below does this on the sample paper. Add a few pixels
of padding around each tile; math models are trained on slightly margined crops.

### 2. Model boundary: a `MathOcr` trait, TrOCR via Candle as the first impl (Path A)

Define the Stage-3 seam ADR 01 promised as a trait:

```rust
/// One isolated math crop in, LaTeX out. The pipeline depends on this, never on
/// a concrete model — so the OCR engine can be upgraded (weights, quantization,
/// CPU/GPU) without touching cropping or Markdown assembly.
pub trait MathOcr {
    fn recognize(&self, image: &image::DynamicImage) -> anyhow::Result<String>;
}
```

**Path A = a Candle-backed TrOCR-class encoder/decoder behind this trait.**
TrOCR (ViT/DeiT image encoder → autoregressive transformer decoder) is the
*pipeline-proving vehicle*: it is the OCR model `candle-transformers` ships today
(`candle-examples/examples/trocr`), so it lets us validate crop → tensor →
greedy-decode → string end-to-end with zero model-porting risk.

TrOCR is a *general* text-OCR model and will **not** produce good LaTeX for
nested math — and that is fine. The trait is exactly what lets the production
math model swap in later without disturbing the rest of the pipeline:

- **Production target:** a pix2tex / LaTeX-OCR-class model (MIT, arXiv-trained;
  ADR 01) loaded through the same `recognize` signature, or a TrOCR fine-tuned on
  `im2latex`. Whichever wins on formula accuracy and license drops in as a second
  `impl MathOcr`.
- The encoder/decoder *scaffold* (image preprocessing, `VarBuilder` weight
  loading, the greedy/beam decode loop, tokenizer detokenization) is essentially
  identical across these models, so Path A's spike code is ~90% reusable when the
  math model lands.

**Crates pulled into the spike (and later `src-tauri`):**

| Crate | Role |
|-------|------|
| `candle-core`, `candle-nn` | tensors + NN primitives (CPU by default) |
| `candle-transformers` | TrOCR + ViT model definitions |
| `tokenizers` | decoder vocab → text detokenization |
| `hf-hub` | download weights/config/tokenizer from the Hub |
| `pdfium-render` | render + crop the page (binds the PDFium native lib) |
| `image` | tile preprocessing (resize/normalize to the encoder input) |

**Tier boundary:** Stage 3 is **native Tauri (paid desktop) only**, gated by
`isTauri()` exactly as the math heuristic and LaTeX tab already are. The web/WASM
tier keeps Stages 1–2 and the "LaTeX coming in Stage 3" placeholder. Candle runs
in-process in the Rust backend — no Python, no cloud, no API key — which is the
whole reason the engine lives in Tauri rather than browser WASM.

### 3. Model weights: download-on-first-run, with an offline sideload escape hatch

Weights are too large to bundle comfortably (a TrOCR-base checkpoint is hundreds
of MB; the math model similar). Decision:

- **Download on first run** from the Hugging Face Hub via `hf-hub` into the OS
  app-data/cache dir (Tauri path API), then reuse the local copy forever.
- **Pin an immutable revision** (commit hash, not a moving tag) so every install
  resolves byte-identical weights — reproducibility and supply-chain hygiene.
- **safetensors only** — never PyTorch `.pickle`. safetensors cannot execute code
  on load; pickle can. This is a hard rule for a security-sensitive B2B tool.
- **Verify integrity** (the Hub's sha256/etag; `hf-hub` checks this) and show a
  one-time download-progress UI so a cold start is not a mysterious hang.

**Privacy reconciliation (states the obvious objection up front):** the
local-first / B2B constraint forbids sending *user documents* off the machine.
Downloading *model weights* is a one-time, **content-independent** fetch — no
page, no text, no metadata about the user's PDFs is transmitted. First-run
download therefore does **not** violate the privacy guarantee. After that fetch
the tool is fully offline.

- **Air-gapped / enterprise escape hatch:** support a sideload path (a settings
  field or `MANTIS_MODEL_DIR` env var) pointing at a pre-staged weights folder,
  so air-gapped customers install with zero network. The download path is the
  default; sideload is the override.

## Rejected alternatives

- **Frontend canvas cropping** (send PNG tiles to Rust). Rejected: re-encode
  softens glyphs, `devicePixelRatio`/CSS scaling makes resolution
  non-deterministic, and it couples Stage 3 to a DOM — killing the headless CLI
  path. The only thing it saved was a Rust render dependency, which is the wrong
  thing to optimize for a math-OCR product.
- **Bundle weights in the installer.** Rejected as the default: hundreds of MB of
  installer bloat for every user, re-downloaded on every app update. Kept only as
  the air-gapped sideload option.
- **Pickle/`.pth` weights loaded directly.** Rejected: arbitrary-code-execution
  surface on model load. Convert to safetensors.
- **Running the math model full-page instead of on crops.** Already rejected in
  ADR 01 (wastes compute re-OCR'ing prose the text layer provides losslessly);
  restated here because backend rendering makes full-page tempting.

## Spike (validates Path A before committing src-tauri changes)

A throwaway crate (`spikes/math-ocr-spike/`, git-ignored) proves the end-to-end
seam on `public/sample-paper.pdf`:

1. `pdfium-render` opens the sample PDF, renders a page at ~300 DPI.
2. Crop a hard-coded equation bbox (the Stage-2 heuristic's output region),
   verifying the PDF→raster coordinate transform.
3. Load TrOCR (config + safetensors + tokenizer) from the Hub via `hf-hub`.
4. `MathOcr::recognize(tile)` → run the encoder/decoder greedy decode → string.
5. Print the result. **Success = the pipeline runs crop → model → text without
   error**, not LaTeX quality (TrOCR is not a math model; quality is the
   production model's job).

The spike's caveat mirrors ADR 01's: the sample is HTML-generated Unicode math,
not Computer-Modern glyph soup. A real arXiv PDF should be run through the same
spike before the production math model is chosen.

## Consequences

- **New Tauri command** `ocr_math_regions(bytes, regions) -> [{ region_id, latex }]`,
  invoked after `extract_document` on the desktop tier; the frontend splices the
  returned LaTeX into the Markdown/LaTeX assembler and the LaTeX tab loses its
  placeholder.
- The Stage-2 heuristic **moves into Rust** (ADR 01 already anticipated this) so
  cropping and classification share one coordinate space; the TS signals port
  directly.
- `src-tauri` gains the Candle + PDFium dependency weight; first build is slow.
  Acceptable for a paid desktop product and isolated from the web bundle.
- Stage boundaries stay clean: swapping TrOCR → pix2tex-class model is a new
  `impl MathOcr`, nothing else changes.

## Appendix: Stage-3 model selection (spike findings, 2026-06-17)

The Path-A spike went past "does it run" and tested whether a LaTeX-fine-tuned
model could drop into the candle TrOCR harness with **no new model code**. Three
findings shaped the model choice.

### 1. The Swin/Donut trap — inspect the nested encoder, not the wrapper
HuggingFace labels most image→text models `VisionEncoderDecoderModel`, but that
wrapper hides incompatible architectures. candle's `trocr` requires
`encoder.model_type ∈ {vit, deit}` **and** `decoder.model_type = trocr`. Of the
strongest "im2latex" / "latex ocr" Hub hits, most were a different family:

| Model | encoder / decoder | Loads in candle `trocr`? |
|-------|-------------------|--------------------------|
| `DGurgurov/im2latex` (MIT, 16 likes) | **swin / gpt2** | No (Donut family) |
| `Matthijs0/im2latex_base` | **swin / gpt2** | No |
| `MixTex/ZhEn-Latex-OCR` (Apache, most popular) | **swin / roberta** | No |
| `fklska/trocr_latex` | **vit-384 / trocr** | **Yes** |
| `ManBib/trocr-large-printed-im2latex` | vit-384 / trocr | Yes (but see §2) |

Always read `config.json`'s nested `encoder`/`decoder`, never the
`architectures` string.

### 2. License is the hard filter (paid B2B)
- `Matthijs0/im2latex_base`: **AGPL-3.0** — copyleft, unusable in a paid product.
- `ManBib/trocr-large-printed-im2latex`: **license unspecified** — same risk,
  excluded even though it is architecturally compatible.
- Survivors with a permissive license **and** a ViT+TrOCR config:
  `fklska/trocr_latex` (**MIT**) and `Rodr16020/...`.

**Selected: `fklska/trocr_latex`** — MIT, ViT-384 + TrOCR decoder,
`image_mean/std = 0.5` (identical to candle's default TrOCR preprocessing), ships
its own `tokenizer.json` (LaTeX vocab). It produced LaTeX with **zero new model
code** — only the weights, `repo_id`, and tokenizer source changed. This is the
concrete proof of Path A: **no pix2tex architecture port to Rust is required.**

### 3. The font domain shift is real and measurable
Feeding the *same* equation (the PINN loss) two ways through the selected model:

| Input | Model output | Symbols read |
|-------|--------------|--------------|
| HTML/Unicode crop (`ℒ` = U+2112, web serif) | `sigma s(\theta)=\lim\limits...` | none correct |
| Computer-Modern render (matplotlib `mathtext.fontset='cm'`) | `f(\theta)=\leq data(\theta)+\lambda...` | `\theta`, `=`, `+`, `\lambda`, `data` correct |

The identical LaTeX reads correctly in Computer Modern and fails in Unicode.
This empirically confirms ADR 01's caveat: a born-digital **Unicode** sample
understates real performance, because im2latex-class models train on
Computer-Modern-typeset math. **The valid accuracy benchmark is a real
arXiv/Computer-Modern PDF, not the HTML demo sample.**

**Consequence:** the `MathOcr` trait accepts any ViT+TrOCR LaTeX model, so model
choice is now an accuracy/license evaluation (front-runner `fklska/trocr_latex`,
stronger MIT/Apache models next, pix2tex as the port-if-needed fallback) fully
decoupled from the pipeline.

## Update: real-paper test and pivot to pix2tex via ONNX (2026-06-18)

### NeurIPS test — pipeline passes, model fails
Ran the full pipeline on page 3 of a real NeurIPS ML4PS paper (genuine
Computer-Modern typesetting, the in-domain case §3 of the appendix called for).
The **pipeline passed end-to-end**: PDFium rendered the page at 300 DPI, the
display-equation crops were pixel-clean (verified visually), and
render → crop → `MathOcr::recognize` → LaTeX ran in-process.

The selected model `fklska/trocr_latex` **failed the structural reconstruction
test** on clean, in-domain equations:

| Equation (truth) | Model output | Verdict |
|---|---|---|
| `\beta = \theta - \theta_E \frac{\theta}{\|\theta\|}` | `\frac{\beta=0}{\alpha_i}^2}\frac{\alpha_i}{\alpha_1}}}` | read `\beta`, hallucinated the rest |
| `\alpha(\theta) = \theta_E \frac{\theta}{\|\theta\|}` | `e \pm ins+ei}^n \frac{n(n}{n})=\frac{d\sum...` | garbage |

It emits valid LaTeX *tokens* but does not faithfully reconstruct structure, even
on the Computer-Modern math it was trained for. **Conclusion: the permissively
licensed TrOCR-LaTeX community fine-tunes are inadequate for production.** The
pipeline is proven; the model is the bottleneck. "Emits LaTeX-shaped tokens" is
not a quality signal — faithful reconstruction is the only metric.

### Decision: adopt pix2tex, run it via ONNX (Path C)
Stop evaluating TrOCR fine-tunes; adopt ADR 01's primary model **pix2tex
(LaTeX-OCR, MIT, arXiv-trained)** — the industry standard for image→LaTeX. Since
`candle-transformers` has no pix2tex implementation, there are two ways to run it:

- **Path B — port the pix2tex architecture to candle (Rust).** Rejected for now:
  high effort and risk (ResNet+ViT hybrid encoder + `x_transformers` decoder) —
  precisely the manual port we set out to avoid.
- **Path C — export pix2tex to ONNX and run it via the `ort` crate (ONNX
  Runtime). CHOSEN.** `ort` runs in-process in the Tauri backend (local, no
  cloud, no Python), preserving the privacy guarantee, and the `MathOcr` trait
  absorbs it as a new `impl` with **zero pipeline changes**. ADR 01 already named
  `ort` as the fallback "if a model exports to ONNX more easily"; that
  contingency is now the plan.

Trade-off accepted: a second inference runtime (`ort` alongside `candle`, which
still serves any future ViT+TrOCR model) plus a one-time ONNX export step, in
exchange for the gold-standard math model without a manual Rust port. pix2tex is
typically exported as three graphs — `image_resizer`, `encoder`, `decoder` — and
the autoregressive decode loop is driven from Rust, mirroring the loop the spike
already implements. Pre-converted ONNX builds exist (RapidLaTeXOCR), which may
remove the export step entirely; to be verified at integration.

## References

- ADR 01 — Local Markdown/LaTeX Extraction Engine: [`01-extraction-engine.md`](./01-extraction-engine.md)
- Candle TrOCR example: <https://github.com/huggingface/candle/tree/main/candle-examples/examples/trocr>
- pix2tex / LaTeX-OCR (MIT): <https://github.com/lukas-blecher/LaTeX-OCR>
- `pdfium-render`: <https://github.com/ajrcarey/pdfium-render>
- `hf-hub`: <https://github.com/huggingface/hf-hub>
- safetensors: <https://github.com/huggingface/safetensors>
