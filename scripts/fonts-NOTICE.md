# Font runtime notice

The files under `/fonts-runtime/` are third-party fonts, served unmodified from the app origin and
fetched only when a text needs them, so that Unicode text in Edit PDF and Fill form is embedded
without any request leaving the origin.

| Files | Source | License |
| --- | --- | --- |
| `NotoSans_*`, `NotoSerif_*`, `NotoSansMono_*` | `@expo-google-fonts/noto-sans`, `noto-serif`, `noto-sans-mono` 0.4.x (Google Fonts static instances) | SIL Open Font License 1.1 |
| `NotoSansArabic_*`, `NotoSansHebrew_*`, `NotoSansDevanagari_*`, `NotoSansThai_*` | `@expo-google-fonts/noto-sans-<script>` | SIL Open Font License 1.1 |
| `NotoSansSC_*`, `NotoSansTC_*`, `NotoSansJP_*`, `NotoSansKR_*` (Regular only) | `@expo-google-fonts/noto-sans-<sc,tc,jp,kr>` | SIL Open Font License 1.1 |

The Noto fonts are Copyright The Noto Project Authors. Each package's `LICENSE_FONT` is copied to
`licenses/<package>.LICENSE_FONT`. `fonts.json` lists every file with its size and the Unicode
ranges its cmap covers; it is generated at build time by `scripts/copy-font-assets.mjs`.

SIL Open Font License 1.1: https://openfontlicense.org
