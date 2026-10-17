declare module "mantis-wasm" {
  export default function init(): Promise<void>;
  export function get_page_count(pdf_bytes: Uint8Array): number;
  export class WasmPdf {
    constructor(bytes: Uint8Array);
    page_count(): number;
    extract_range(start: number, end: number): Uint8Array;
    free(): void;
  }
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
  export function encrypt_pdf(
    pdf_bytes: Uint8Array,
    user_password: string,
    owner_password: string,
  ): Uint8Array;
  export function apply_page_plan(pdf_list: Uint8Array[], plan: Int32Array): Uint8Array;
  export class SanitizeOutput {
    bytes(): Uint8Array;
    /** [links_kept, links_dropped, comments_kept, comments_dropped, fields_flattened, warnings, too_deep_pages] */
    report(): Uint32Array;
    free(): void;
  }
  export function sanitize_pdf(pdf_bytes: Uint8Array, keep_comments: boolean): SanitizeOutput;
  export class StampOutput {
    bytes(): Uint8Array;
    stamped_pages(): number;
    free(): void;
  }
  export function stamp_pdf(pdf_bytes: Uint8Array, job: object): StampOutput;
  /** Visible [w, h] of every page in points, flattened: [w1, h1, w2, h2, ...]. */
  export function visible_page_sizes(pdf_bytes: Uint8Array): Float64Array;
  export function remove_metadata(pdf_bytes: Uint8Array): Uint8Array;
  /** [title, author, subject, keywords] */
  export function read_metadata(pdf_bytes: Uint8Array): string[];
  export function set_metadata(
    pdf_bytes: Uint8Array,
    title: string,
    author: string,
    subject: string,
    keywords: string,
  ): Uint8Array;
  export function unlock_pdf(pdf_bytes: Uint8Array, password: string): Uint8Array;
}
