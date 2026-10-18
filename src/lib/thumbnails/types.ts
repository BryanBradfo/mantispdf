export type DocKey = string;

export type ThumbState =
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "error" };

/**
 * `full`: the page as viewers show it. `no-widgets`: without form field (widget) appearances,
 * other annotations kept, for a page shown under live form controls.
 */
export type RenderMode = "full" | "no-widgets";

export interface RendererDoc {
  render(page: number, width: number, mode: RenderMode): Promise<Blob>;
  destroy(): void;
}

export interface Renderer {
  open(bytes: Uint8Array): Promise<RendererDoc>;
}

export interface QueuedJob {
  doc: DocKey;
  page: number;
  width: number;
  mode: RenderMode;
  /** True while the thumbnail's element is within 400px of the viewport. */
  visible: boolean;
  /** Monotonic request order; lower = requested earlier. */
  seq: number;
}
