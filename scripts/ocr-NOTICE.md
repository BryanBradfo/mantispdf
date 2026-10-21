# OCR runtime notice

The files under `/ocr-runtime/` are third-party software and data, served unmodified from the app
origin so that text recognition runs entirely in the browser.

| Path | Source | License |
| --- | --- | --- |
| `worker.min.js` | [tesseract.js](https://github.com/naptha/tesseract.js) 7.0.0, `dist/worker.min.js` | Apache-2.0 (`tesseract.js.LICENSE.md`); bundled third-party notices in `worker.min.js.LICENSE.txt` |
| `core/*.wasm.js` | [tesseract.js-core](https://github.com/naptha/tesseract.js-core) 7.0.0 (Tesseract OCR and Leptonica compiled to WebAssembly) | Apache-2.0 (`core/LICENSE`) |
| `lang/*.traineddata.gz` | `@tesseract.js-data/<lang>` 1.0.0, `4.0.0_best_int`: integer versions of the [tessdata_best](https://github.com/tesseract-ocr/tessdata_best) LSTM models | Apache-2.0 (models by Google, tesseract-ocr/tessdata_best) |

The invisible text layer MantisPDF adds to OCR output embeds Tesseract's "GlyphLessFont"
(`pdf.ttf` from [tesseract-ocr/tesseract](https://github.com/tesseract-ocr/tesseract)
`tessdata/pdf.ttf`, Copyright Google Inc., Apache-2.0); see
`crates/mantis-wasm/assets/pdf.ttf.LICENSE.md` in the source repository.

Apache License 2.0: https://www.apache.org/licenses/LICENSE-2.0
