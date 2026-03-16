# 🦗 MantisPDF — Modify Your PDFs Faster Than Ever

<p align="center">
    <picture>
        <source media="(prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/5b2ae020-557c-41e9-88ee-26b04e85c175">
        <img src="https://github.com/user-attachments/assets/5b2ae020-557c-41e9-88ee-26b04e85c175" alt="MantisPDF" width="350">
    </picture>
</p>

<p align="center">
  <a href="https://mantispdf.vercel.app"><img src="https://img.shields.io/badge/Live-mantispdf.vercel.app-brightgreen?style=for-the-badge" alt="Live site"></a>
  <a href="https://github.com/BryanBradfo/mantispdf/actions"><img src="https://img.shields.io/github/actions/workflow/status/BryanBradfo/mantispdf/ci.yml?branch=main&style=for-the-badge" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

**Your files never leave your browser. All PDF processing runs locally via Rust-compiled WebAssembly.**

---

## Why MantisPDF?

Most online PDF tools (ilovepdf, smallpdf, etc.) upload your files to their servers. MantisPDF is different:

- **No uploads.** Your PDFs stay on your machine — always.
- **No server, no tracking.** There's nothing to breach and nothing to log.
- **Rust performance in the browser.** PDF operations run in a Web Worker via `wasm-pack`-compiled Rust, so the UI stays responsive even on large files.
- **Open source.** MIT — audit it, fork it, self-host it.

---

## Features

- **Split PDF** — Select exactly where to split and download the parts as a ZIP
- **Merge PDF** — Combine multiple PDFs into one, with drag-and-drop reordering
- **Edit PDF** — Delete or reorder pages, download result as `_edited.pdf`
- **Compress PDF** — Reduce PDF file size entirely client-side
- **Rotate PDF** — Rotate individual pages (90°, 180°, or 270°)
- **PDF to Images** — Export each page as a PNG or JPEG image
- **Watermark PDF** — Stamp custom text on every page (size, opacity, angle, color)
- **Encrypt PDF** — Password-protect a PDF so only authorized readers can open it

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, TypeScript (strict), Tailwind CSS |
| Bundler | Vite 6 with WASM + top-level-await plugins |
| PDF engine | Rust + `lopdf`, compiled to WASM via `wasm-pack` |
| Preview | `react-pdf` for page thumbnails |
| Packaging | JSZip for multi-file downloads |

## Prerequisites

- **Node.js** >= 18
- **Rust** toolchain (`rustup`)
- **wasm-pack** — install with `cargo install wasm-pack`

## Getting Started

```bash
# Clone the repo
git clone https://github.com/BryanBradfo/mantispdf.git
cd mantispdf

# Build the WASM module (required before first run)
npm run build:wasm

# Install JS dependencies
npm install

# Start dev server
npm run dev
```

The app opens at `http://localhost:5173`.

## Project Structure

```
mantispdf/
├── crates/mantis-wasm/   # Rust crate — PDF ops compiled to WASM via wasm-pack
├── src/
│   ├── pages/            # Route-level page components (one per tool)
│   ├── components/       # UI components grouped by tool + shared common/
│   ├── hooks/            # usePdfWorker, useSplitState, useMergeState, …
│   ├── workers/          # pdf.worker.ts — WASM init + PDF processing off main thread
│   └── lib/              # workerProtocol.ts, fileHelpers.ts, downloadZip.ts
├── vite.config.ts        # WASM plugin config (worker.plugins + optimizeDeps exclude)
└── package.json
```

## Contributing

Contributions are welcome! For ideas or bug reports, open a [Discussion](https://github.com/BryanBradfo/mantispdf/discussions) or [Issue](https://github.com/BryanBradfo/mantispdf/issues).

To contribute code:

```bash
# Fork the repo, then:
git clone https://github.com/<your-fork>/mantispdf.git
cd mantispdf
npm run build:wasm   # build WASM first
npm install
npm run dev          # start dev server at localhost:5173
```

Run Rust tests with:

```bash
cd crates/mantis-wasm && cargo test
```

Then open a PR against `main`. Please keep PRs focused — one feature or fix per PR.

## License

[MIT](LICENSE)

## Star History

[![Star History Chart](https://api.star-history.com/image?repos=bryanbradfo/mantispdf&type=date&legend=top-left)](https://www.star-history.com/?repos=bryanbradfo%2Fmantispdf&type=date&legend=top-left)

## How it works

1. **Upload** — Drop a PDF onto the DropZone. The file is validated (type + 100 MB limit) and read into an `ArrayBuffer`.
2. **Configure** — Choose tool-specific options (split points, passwords, watermark text, …).
3. **Process** — The main thread transfers the PDF bytes to a Web Worker via `postMessage`. The worker calls the relevant Rust/WASM function (`extract_pages`, `merge_pdfs`, `encrypt_pdf`, …) off the main thread.
4. **Download** — The result is transferred back and saved: single files via a Blob URL, multi-part results via JSZip.

```
UI Thread                          Web Worker
────────────                       ──────────
DropZone → validate & read
Configure tool options
  │
  ├── postMessage(pdfBytes, options)  ──→
  │                                  init WASM (once)
  │                                  call WASM fn (lopdf)
  │                                  ←── postMessage(result)
  │
downloadBlob / downloadZip → browser saves file
```



