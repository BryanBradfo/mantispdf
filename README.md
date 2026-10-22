# 🦗 MantisPDF

<p align="center">
    <picture>
        <source media="(prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/5b2ae020-557c-41e9-88ee-26b04e85c175">
        <img src="https://github.com/user-attachments/assets/5b2ae020-557c-41e9-88ee-26b04e85c175" alt="MantisPDF" width="350">
    </picture>
</p>

<p align="center">
  <a href="https://github.com/BryanBradfo/mantispdf/actions/workflows/ci.yml"><img src="https://github.com/BryanBradfo/mantispdf/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://mantispdf.vercel.app/"><img src="https://img.shields.io/github/deployments/BryanBradfo/mantispdf/Production?label=deploy&logo=vercel" alt="Deployment"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

<p align="center"><b><a href="https://mantispdf.vercel.app/">mantispdf.vercel.app</a></b></p>

**MantisPDF** is a free, open-source PDF toolkit that runs entirely in your browser: 27 tools, from
merging and compressing to editing, filling forms, true redaction and OCR. Every file is processed on
your device by a Rust engine compiled to WebAssembly. Nothing is uploaded.

---

## Why MantisPDF?

Most online PDF tools (iLovePDF, Smallpdf, ...) upload your files to their servers. MantisPDF does not.

- **No uploads.** Your PDFs never leave your device. Every request stays on the app's own origin,
  including the OCR engine and its language data, and the end-to-end tests check it.
- **No account.** Open the page and use it, online or as a desktop app.
- **Fast.** PDF work runs in a Web Worker, so the interface stays responsive on large files.
- **Open source.** MIT licensed: audit it, fork it, self-host it.

The hosted site uses Vercel's cookieless page-view analytics. Your documents are never part of it.

## Tools

| Organize | Optimize and convert | Edit and annotate | Security |
|---|---|---|---|
| Split PDF | Compress PDF | Edit PDF (text, images, shapes, drawings) | Encrypt PDF |
| Merge PDF | PDF to Images | Fill PDF form (editable or flattened) | Unlock PDF |
| Organize PDF | Images to PDF | Sign PDF | Redact PDF (true removal) |
| Rotate Pages | Extract Images | Watermark PDF | Sanitize PDF |
| Remove Pages | OCR PDF (searchable scans) | Page Numbers | Remove Metadata |
| Extract Pages | Crop PDF | Header & Footer | Edit Metadata |
| | Resize Pages | Bates Numbering | |
| | N-up Pages | | |

A few that go further than most online tools:

- **Redact PDF** removes the text, image pixels and drawings under each mark, then checks the result
  and refuses to deliver it if anything marked is still there. Pages it cannot guarantee are converted
  to images, and it tells you which ones.
- **OCR PDF** adds an invisible, searchable text layer to scans, in 7 languages, with automatic deskew.
- **Fill PDF form** handles text, checkboxes, radio buttons and lists, and never stores password fields.

## Tech stack

| Layer | Technology |
|---|---|
| Interface | React 19, TypeScript (strict), Tailwind CSS, Vite 6 |
| PDF engine | Rust with `lopdf`, compiled to WebAssembly with `wasm-pack`, run in a Web Worker |
| Rendering | pdf.js (`react-pdf`) for previews and thumbnails |
| OCR | tesseract.js 7, self-hosted under `/ocr-runtime/` |
| Downloads | `fflate` for ZIP archives |
| Desktop | Tauri 2 |

## Getting started

Requirements: **Node.js 22+**, the **Rust** toolchain with the `wasm32-unknown-unknown` target, and
**wasm-pack** (`cargo install wasm-pack`).

```bash
git clone https://github.com/BryanBradfo/mantispdf.git
cd mantispdf
npm ci
npm run build:wasm   # builds the Rust engine into crates/mantis-wasm/pkg
npm run dev          # http://localhost:5173
```

To try the production build, which is what the end-to-end tests use:

```bash
npm run build && npm run preview
```

## Tests

```bash
cd crates/mantis-wasm && cargo test   # Rust engine
npm test                              # unit tests (Vitest)
npm run build && npm run test:e2e     # end-to-end in Chromium (needs poppler-utils)
```

## Project structure

```
mantispdf/
├── crates/mantis-wasm/   Rust engine (split, merge, stamps, forms, redaction, OCR text layer, ...)
├── src/
│   ├── pages/            one page per tool
│   ├── components/       UI components, grouped by tool, plus shared ones in common/
│   ├── hooks/            usePdfWorker and per-tool state
│   ├── workers/          pdf.worker.ts: loads the engine and runs operations off the main thread
│   └── lib/              worker protocol, thumbnails, editor, forms, redaction and OCR logic
├── e2e/                  Playwright tests and their fixtures
├── scripts/              build helpers and fixture generators
└── src-tauri/            desktop app
```

## How it works

1. You drop a PDF. It is read in the browser.
2. You choose the tool's options.
3. The bytes go to a Web Worker, which calls the Rust engine compiled to WebAssembly.
4. The result comes back to the page and is saved as a file or a ZIP.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md), then open a pull request
against `main` from a `feature/<name>` branch. CI must pass, and Vercel posts a preview link for
every pull request. Ideas and bug reports go to
[Discussions](https://github.com/BryanBradfo/mantispdf/discussions) or
[Issues](https://github.com/BryanBradfo/mantispdf/issues).

## License

[MIT](LICENSE)

## Star History

<a href="https://www.star-history.com/?repos=BryanBradfo%2Fmantispdf&type=date&logscale=&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=BryanBradfo/mantispdf&type=date&theme=dark&logscale&legend=bottom-right&sealed_token=xvoJQvt2fO5_HD39G19nf7HBLYtWNSxcKYRxwMu3Tyl3VcM81s5Wiv6O1I-sLIluLEr8ycBqWa73njx7Z9_isgz1gj0DP0qPiVnFxH5Y_zXmVz1y7_XZiCNK41c-BZKbttZa5Hwi-inx58lEhXvUwyLjHqtd0fhwZvcfOJLMODpB6Fkcxwo3_9hCBBSy" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=BryanBradfo/mantispdf&type=date&logscale&legend=bottom-right&sealed_token=xvoJQvt2fO5_HD39G19nf7HBLYtWNSxcKYRxwMu3Tyl3VcM81s5Wiv6O1I-sLIluLEr8ycBqWa73njx7Z9_isgz1gj0DP0qPiVnFxH5Y_zXmVz1y7_XZiCNK41c-BZKbttZa5Hwi-inx58lEhXvUwyLjHqtd0fhwZvcfOJLMODpB6Fkcxwo3_9hCBBSy" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=BryanBradfo/mantispdf&type=date&logscale&legend=bottom-right&sealed_token=xvoJQvt2fO5_HD39G19nf7HBLYtWNSxcKYRxwMu3Tyl3VcM81s5Wiv6O1I-sLIluLEr8ycBqWa73njx7Z9_isgz1gj0DP0qPiVnFxH5Y_zXmVz1y7_XZiCNK41c-BZKbttZa5Hwi-inx58lEhXvUwyLjHqtd0fhwZvcfOJLMODpB6Fkcxwo3_9hCBBSy" />
 </picture>
</a>
