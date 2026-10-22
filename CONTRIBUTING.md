# Contributing to MantisPDF

Thanks for helping. MantisPDF is a private, in-browser PDF toolkit: every file is processed on the
user's device (Rust compiled to WebAssembly, plus pdf.js and tesseract.js). Keep it that way.

## Workflow

1. Fork the repository (or create a branch if you have write access) named `feature/<short-name>`.
2. Make your change with tests, then open a pull request against `main`.
3. CI must pass (Rust tests, unit tests, type-check). Vercel posts a preview URL on every pull
   request: use it to try your change.
4. A maintainer reviews and merges. `main` is protected: nobody pushes to it directly.

Releases are tagged (`v0.4.0`) from `main`.

## Setup

```bash
npm ci
npm run build:wasm      # needs Rust, the wasm32-unknown-unknown target and wasm-pack
npm run dev
```

## Tests

```bash
cd crates/mantis-wasm && cargo test   # engine
npm test                              # unit tests (Vitest)
npm run build && npm run test:e2e     # end-to-end, against the production build (needs poppler-utils)
```

## Ground rules

- No network request outside the app origin, ever. Assets are self-hosted.
- A bug fix comes with a regression test that fails without the fix.
- Hostile PDFs must never panic the engine or blow its memory budgets.
- TypeScript strict mode, no `any`.
