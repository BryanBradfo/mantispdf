declare module "mantis-wasm" {
  export default function init(): Promise<void>;
  export function get_page_count(pdf_bytes: Uint8Array): number;
  export function extract_pages(
    pdf_bytes: Uint8Array,
    page_start: number,
    page_end: number,
  ): Uint8Array;
}
