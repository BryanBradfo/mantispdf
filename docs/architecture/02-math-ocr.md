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

## References

- ADR 01 — Local Markdown/LaTeX Extraction Engine: [`01-extraction-engine.md`](./01-extraction-engine.md)
- Candle TrOCR example: <https://github.com/huggingface/candle/tree/main/candle-examples/examples/trocr>
- pix2tex / LaTeX-OCR (MIT): <https://github.com/lukas-blecher/LaTeX-OCR>
- `pdfium-render`: <https://github.com/ajrcarey/pdfium-render>
- `hf-hub`: <https://github.com/huggingface/hf-hub>
- safetensors: <https://github.com/huggingface/safetensors>
