# ADR 01 — Local Markdown/LaTeX Extraction Engine

- **Status:** Accepted
- **Date:** 2026-06-16
- **Deciders:** Bryan Chen (product), AI architecture review
- **Context tags:** privacy-first, local-only, B2B, Tauri desktop, freemium web

## Context

MantisPDF is pivoting from a client-side PDF toolkit into a **local-first AI
document-prep tool**: convert PDFs (especially dense scientific papers) into
clean Markdown and **accurate LaTeX** for RAG/LLM pipelines. The extraction
engine is the product's moat.

Hard constraints:

1. **Privacy-first / local.** Extraction must run on the user's machine — no
   cloud, no API keys. The paid tier runs natively in the **Tauri (Rust)**
   backend to bypass browser/WASM limits (memory ceiling, threading, model
   size).
2. **No VLM training budget.** We cannot train a Vision-Language Model from
   scratch, and we will not depend on cloud inference. We compose
   permissively-licensed pretrained models.
3. **High math accuracy.** Complex mathematics (e.g. the PINN loss
   `\mathcal{L}_{PINN} = \mathcal{L}_{data} + \lambda \mathcal{L}_{PDE}`,
   fractions, sub/superscripts, summation limits) must survive extraction.

## Decision

Adopt a **three-stage hybrid pipeline**, not a single end-to-end model:

```
PDF
 └─ Stage 1 — Text & geometry        LiteParse (Rust, Apache-2.0; WASM-capable)
 │     → line-level TextItems: text + bounding box + font_name/size/flags
 │     → confidence=None marks born-digital; Some(x) marks OCR'd text
 │
 └─ Stage 2 — Math-region classifier  Heuristic first (no model)
 │     signals: font family ≠ body font; font_is_buggy / has_unicode_map_error;
 │              font-size outliers; spatial fragmentation; isolated/centered geometry
 │     → tag which boxes are math / figure regions
 │     (upgrade path: lightweight layout model, e.g. Surya-style ONNX)
 │
 └─ Stage 3 — Math OCR                pix2tex (LaTeX-OCR, MIT) via Candle (pure Rust)
       → crop tagged regions, render to image, run model → LaTeX
       → splice LaTeX back into the Stage-1 Markdown assembler → final .md
```

### Stage 1 — LiteParse (text + geometry)
`run-llama/liteparse` v2.x. **Apache-2.0** (clean for B2B), Rust crate with
Python/Node/**WASM** bindings, PDFium-backed, no LLM. Emits line-level
`TextItem`s with text, bbox, and **per-item font metadata**. Markdown generation
and math are explicitly out of its scope, and its default OCR (Tesseract)
mangles math — exactly the division of labour we want.

> **Freemium leverage:** LiteParse's WASM build means **Stage 1 can run in the
> browser (free web tier)** while the heavy Stage 3 math brain stays native in
> the paid Tauri desktop tier. The paywall sits on the expensive, differentiated
> capability.

### Stage 2 — Math-region classifier ("the missing middle")
LiteParse locates *where text is*, not *which regions are math*. A dedicated
classifier bridges Stages 1 and 3. The spike (below) confirmed a **font/geometry
heuristic is viable for v1** — no model required initially. The layout-model
upgrade is deferred until heuristics demonstrably break (multi-column, tables).

### Stage 3 — pix2tex on Candle (math → LaTeX)
Run a **specialized image→LaTeX model on isolated crops**, not a full-page model.
- **Model:** pix2tex / LaTeX-OCR (**MIT**, ~30M params, arXiv-trained). Alt:
  GOT-OCR2.0 (Apache-2.0, ~580M).
- **Runtime:** **Candle** (HuggingFace pure-Rust ML) — no Python, no C++ FFI,
  GGUF/int8 quantization, runs in-process in the Tauri backend. `ort`
  (ONNX Runtime) is the fallback if a model exports to ONNX more easily.

## Rejected alternatives

### A pure VLM ("just run a multimodal model on the page")
Rejected for the core path:
- A **text-only LLM (LLaMA/Mistral via llama.cpp) cannot OCR** — it never sees
  the pixels. The "tiny local LLaMA" idea is a category error for this problem.
- A **VLM** (Qwen2-VL, MiniCPM-V) *can* see the page, but a 2B+ VLM on CPU is
  slow **and** unreliable on dense nested math — the exact case we must nail.
- A **purpose-built math-OCR model (~30M, arXiv-trained), invoked only on the
  ~5% of the page that is math, beats a 7B general VLM** on formula accuracy at
  a fraction of the compute. Accuracy-per-watt decides a local, budget-bound
  product.
- An LLM still has an **optional, non-core** role: text post-processing
  (reading-order repair, table assembly) over already-extracted text.

### Full-page end-to-end OCR (Nougat / Marker) as the default
- **Nougat** (Meta) is high quality but its **weights are CC-BY-NC** —
  unusable for a paid B2B product.
- **Marker/Surya/Texify** are source-available but **revenue-gated** — must be
  re-verified before shipping.
- Beyond licensing, running a full-page model wastes compute re-OCR'ing prose
  that the born-digital text layer already provides losslessly and for free.

**License is the single biggest non-technical risk.** Lock Stage 3 to MIT/Apache
(pix2tex, GOT-OCR2) and re-verify weight licenses at integration time.

## Spike findings (2026-06-16)

A throwaway Rust harness pulled `liteparse 2.0.8` and parsed our generated
`public/sample-paper.pdf` (a PINN/Poisson paper). Verified output schema:

- **Granularity:** line-level `TextItem`s (a paragraph = N items; equations
  fragment further by font-size/baseline run).
- **Font metadata:** `font_name`, `font_size`, `font_weight`, `font_flags`
  exposed per item. Math glyphs landed in a *different* font (`NotoSans`) than
  the body (`LiberationSerif`) — so the font heuristic is usable.
- **Born-digital signal:** `confidence: None` on all items (Tesseract never
  fired); `font_is_buggy` / `has_unicode_map_error` flag unreliable glyph text.

### The decisive finding: linear parsers destroy 2D math structure
Our sample is HTML/Chromium-generated, so its math is **clean Unicode with
ToUnicode maps** — PDFium extracts the *symbols* perfectly. Yet the **2D
structure was still destroyed**:

- `\frac{1}{N_r}` came out as scattered fragments `"(θ) = 1"` + `"ℒpde"` +
  `"Σ ∣ Δuθ"` in broken reading order;
- every subscript/superscript was flattened (`\mathcal{L}_{data}` → `"ℒdata"`,
  `u_\theta` → `"uθ"`);
- the squared term and the summation limits `i=1 .. N_r` were simply lost.

**Conclusion:** `pix2tex` is **mandatory, not a fallback.** It is the only way to
recover fraction / sub-superscript / limit structure that *any* linear text
extractor — born-digital **or** OCR — inherently loses. The math model earns its
place on **every** PDF, not just scanned ones. This is the core B2B value.

> Caveat for future testing: because the sample is HTML-generated Unicode, it
> does **not** exhibit the glyph-level garbling of a real LaTeX/Computer-Modern
> PDF (CMMI/CMSY fonts, missing ToUnicode → `font_is_buggy: true`). A real arXiv
> PDF should be used to validate the garbling path before the classifier ships.

## Consequences

- **Next:** wire LiteParse directly into `src-tauri`, expose a Tauri command
  (`extract_document`), and connect it to the React workspace — replacing the
  2-second `setTimeout` stub in `HomePage` with a real `invoke(...)`.
- The web tier can later gain Stage 1 via LiteParse's WASM build.
- Model weights (~150–600 MB) ship with the desktop app or download on first
  run — acceptable for a paid desktop product, and a reason the engine lives in
  Tauri rather than browser WASM.
- Stage boundaries are clean seams: the classifier and math model can be
  upgraded independently without touching the text-extraction or assembly code.

## References

- LiteParse: <https://github.com/run-llama/liteparse> (Apache-2.0)
- pix2tex / LaTeX-OCR: MIT
- GOT-OCR2.0: Apache-2.0
- Candle: <https://github.com/huggingface/candle>
