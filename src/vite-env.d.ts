/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Lemon Squeezy checkout/permalink for the "Upgrade to Pro" CTA (ADR 03). */
  readonly VITE_MANTIS_CHECKOUT_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
