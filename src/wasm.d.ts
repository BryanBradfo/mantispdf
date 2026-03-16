declare module "mantis-wasm" {
  export default function init(): Promise<void>;
  export function get_page_count(pdf_bytes: Uint8Array): number;
  export function extract_pages(
    pdf_bytes: Uint8Array,
    page_start: number,
    page_end: number,
  ): Uint8Array;
  export function merge_pdfs(pdf_list: Uint8Array[]): Uint8Array;
  export function compress_pdf(pdf_bytes: Uint8Array, quality: number): Uint8Array;
  export function rotate_pdf(pdf_bytes: Uint8Array, rotations: Int32Array): Uint8Array;
  export function reorder_pages(pdf_bytes: Uint8Array, new_order: Uint32Array): Uint8Array;
  export function add_watermark(
    pdf_bytes: Uint8Array,
    text: string,
    font_size: number,
    opacity: number,
    angle_deg: number,
    r: number,
    g: number,
    b: number,
  ): Uint8Array;
}
