## What does this change?

<!-- One or two sentences. Link the issue if there is one: Closes #123 -->

## How was it tested?

- [ ] `cd crates/mantis-wasm && cargo test`
- [ ] `npm test`
- [ ] `npm run build:wasm && npm run build && npm run test:e2e` (for UI or engine changes)
- [ ] Tried in the browser on a real PDF (say which tool and which file type)

## Checklist

- [ ] Files never leave the browser: no new request outside the app origin
- [ ] User-facing text is in English, with no em-dash
- [ ] A bug fix comes with a test that failed before the fix
