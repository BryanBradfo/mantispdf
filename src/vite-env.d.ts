/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/vanillajs" />

/** package.json `version`, injected by `define` in vite.config.ts. */
declare const __MANTIS_VERSION__: string;

interface ImportMetaEnv {
  /** Lemon Squeezy checkout/permalink for the "Upgrade to Pro" CTA (ADR 03). */
  readonly VITE_MANTIS_CHECKOUT_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
