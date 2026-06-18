# ADR 03 — Stage-3 Licensing (Lemon Squeezy, backend-enforced)

- **Status:** Accepted
- **Date:** 2026-06-18
- **Deciders:** Bryan Chen (product), AI architecture review
- **Context tags:** monetization, freemium, local-first, Tauri desktop, Merchant-of-Record

## Context

MantisPDF is freemium (see project vision): the client-side PDF toolkit and
Stage-1 text extraction stay free; the differentiated, expensive capability —
**Stage-3 math OCR (image → LaTeX)** — is the paid "Pro" feature. We sell via
**Lemon Squeezy** as Merchant of Record (they handle checkout, tax, and license
key generation), so we do not run a payment or license server.

Constraints carried from ADR 01/02: local-first, no cloud dependency for the
core product, privacy (no document data leaves the machine).

## Decision

### 1. Validate **and enforce** the license in the Rust backend
The paid capability executes in the Tauri Rust backend (`extract_pipeline`).
The gate is enforced there, not in React, because **the webview is fully
inspectable and user-editable** — any frontend-only check is trivially
bypassed. The frontend only *reflects* license state to drive UI; it is never
the source of truth.

This is not unbreakable (no client-side DRM is — a determined attacker can
patch the binary). The goal is reasonable friction for honest users; a
backend check plus periodic online re-validation raises the bar far above a
frontend toggle, which is the right trade for a local-first desktop tool.

Privacy reconciliation (as in ADR 02): validation sends only the **license
key** to Lemon Squeezy — never document content. Content-independent, like the
weights download.

### 2. Lemon Squeezy License API (no secret key embedded)
The License API is separate from the main LS API and requires **no
`Authorization` header** — it is designed to run in distributed client apps.
We embed only **public identifiers** (variant/store IDs) to scope licenses to
our product. **We never embed the LS secret API key** (that would be a serious
leak; it is only needed server-side, e.g. webhooks — which we deliberately do
not use, to stay local-first).

| Operation | Endpoint (`POST`) | Params | Key fields used |
|-----------|-------------------|--------|-----------------|
| Activate | `…/v1/licenses/activate` | `license_key`, `instance_name` | `activated`, `instance.id`, `license_key.status`, `meta.{variant_id,store_id}` |
| Validate | `…/v1/licenses/validate` | `license_key`, `instance_id` | `valid`, `license_key.status` |
| Deactivate | `…/v1/licenses/deactivate` | `license_key`, `instance_id` | `deactivated` |

Base host: `https://api.lemonsqueezy.com`. **Product-scope check:** on
activate/validate, reject unless `meta.variant_id` (and `store_id`) match this
product's configured IDs — otherwise any LS license from any store would unlock
the app.

### 3. Local license state (offline-friendly, revocation-aware)
Persist `license.json` in Tauri's **`app_config_dir()`**:
`{ key, instance_id, status, variant_id, last_checked }`. Resolution:
- `status == active` and `last_checked` within the **recheck cadence** (3 days)
  → trust the cache (no network).
- Stale → online `validate`; refresh `last_checked` on success; downgrade to
  free on `expired`/`disabled`.
- Network failure → honor an **offline grace** (14 days since last success)
  before locking. Keeps the app usable offline while still catching
  refunds/expiry eventually.

### 4. Freemium gate + graceful degradation
- **Backend (`extract_pipeline`)** takes a `pro: bool`. When false it runs
  Stages 1–2 only (text + math-region *detection*), **skips Stage 3** (no engine
  load, no OCR), and returns `pro_locked: true` with the detected regions
  carrying empty LaTeX. Free users get clean Markdown + "N math regions
  detected" — the upsell.
- **Frontend (`Workspace.tsx`)** when not Pro: the Preview/KaTeX toggle is
  replaced by an **"Upgrade to Pro" CTA** linking to the Lemon Squeezy checkout;
  the math area shows the locked-region count.

### 5. Commands & UI
- Tauri commands: `get_license_status`, `activate_license(key)`,
  `deactivate_license`.
- `useLicense()` hook + `LicenseDialog.tsx` (key input / activate / manage).

## Configuration (all public — no secrets)
Scaffolded with placeholders; set before shipping `v1.0.0`:
- `LS_VARIANT_ID` (+ optional `LS_STORE_ID`) — compile-time (`option_env!`),
  scopes licenses to the Pro product. Empty placeholder → product check skipped
  (dev only, with a warning).
- `VITE_MANTIS_CHECKOUT_URL` — the LS checkout/permalink for the CTA.
- See `.env.example`.

## Rejected alternatives
- **Frontend-only validation.** Rejected: trivially bypassed; the protected
  code runs in Rust, so the gate must too.
- **Self-hosted license/validation server or webhooks.** Rejected: breaks
  local-first / no-cloud and adds the obligation to run infrastructure; the
  public License API is sufficient as MoR.
- **Embedding the LS secret API key for the main API.** Rejected: distributing
  a secret key is a leak; the License API needs none.
- **Require online check every launch.** Rejected: breaks offline use; the
  recheck-cadence + offline-grace model balances revocation against local-first.

## Consequences
- `extract_document`/`recognize_math` gain an `AppHandle`-resolved license check;
  `extract_pipeline` gains a `pro` flag (kept Tauri-independent for tests).
- New `license.rs` (ureq + serde, reusing existing deps) and a `license.json`
  in app-config.
- A patched binary can defeat the gate; accepted per the local-first DRM reality
  above. Re-validation cadence limits the value of a leaked/refunded key.

## References
- Lemon Squeezy License API: <https://docs.lemonsqueezy.com/api/license-api>
- Activate / Validate / Deactivate license key (LS API docs)
- ADR 02 — Stage-3 Math OCR (the gated capability): [`02-math-ocr.md`](./02-math-ocr.md)
