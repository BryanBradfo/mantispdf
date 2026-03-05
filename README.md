# MantisPDF

**Client-side PDF tools powered by WebAssembly. Your files never leave your browser.**

> **Early MVP** — Split and Merge are available today. Compress and rotate are planned.

---

## Features

- **Split PDF** — Select exactly where to split and download the parts as a ZIP
- **Merge PDF** — Combine multiple PDFs into one, with drag-and-drop reordering
- **100% client-side** — All processing happens in your browser. No uploads, no server, no tracking
- **Rust/WASM performance** — PDF manipulation runs in a Web Worker via compiled WebAssembly, keeping the UI responsive

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
├── crates/mantis-wasm/         # Rust WASM crate
│   ├── src/lib.rs              #   WASM entry point (get_page_count, extract_pages, merge_pdfs)
│   ├── src/split.rs            #   PDF splitting logic using lopdf
│   └── src/merge.rs            #   PDF merging logic using lopdf
├── src/
│   ├── pages/                  # Route-level pages
│   │   ├── HomePage.tsx        #   Landing page with tool grid
│   │   ├── SplitPdfPage.tsx    #   Split tool orchestrator
│   │   └── MergePdfPage.tsx    #   Merge tool orchestrator
│   ├── components/
│   │   ├── layout/             #   Header, Footer
│   │   ├── split/              #   DropZone, ThumbnailGrid, SplitActions, ProgressOverlay
│   │   └── merge/              #   MergeDropZone, FileList, MergeActions
│   ├── hooks/
│   │   ├── usePdfWorker.ts     #   Web Worker communication
│   │   ├── useSplitState.ts    #   Split state management (useReducer)
│   │   └── useMergeState.ts    #   Merge state management
│   ├── lib/
│   │   ├── workerProtocol.ts   #   Main ↔ Worker message types
│   │   ├── fileHelpers.ts      #   File validation (100 MB max)
│   │   └── downloadZip.ts      #   ZIP creation and download trigger
│   ├── workers/
│   │   └── pdf.worker.ts       #   Web Worker — WASM init + PDF splitting
│   └── App.tsx                 # Router setup
├── scripts/
│   └── build-wasm.sh           # wasm-pack build script
├── index.html                  # Vite entry point
├── vite.config.ts              # WASM aliases and plugins
└── package.json
```

## How It Works

1. **Upload** — Drop a PDF onto the DropZone. The file is validated (type + 100 MB limit) and read as a `Uint8Array`
2. **Preview** — `react-pdf` renders page thumbnails. Click the dividers between pages to mark split points
3. **Split** — The main thread sends the PDF bytes and split indices to a Web Worker
4. **WASM processing** — The worker calls Rust-compiled `extract_pages()` for each page range, running off the main thread
5. **Download** — The split parts are packaged into a ZIP via JSZip and downloaded automatically

```
UI Thread                          Web Worker
────────────                       ──────────
DropZone → validate & read
react-pdf → thumbnails
User marks split points
  │
  ├── postMessage(pdfBytes, splitPoints)
  │                                  ↓
  │                            init WASM
  │                            compute ranges
  │                            for each range:
  │                              extract_pages() ← Rust/WASM
  │                              post progress
  │                                  │
  ← postMessage(parts) ─────────────┘
  │
downloadZip(parts) → browser saves ZIP
```

## License

[GPL-3.0](LICENSE)
