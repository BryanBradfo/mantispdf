export type DocKey = string;

export type ThumbState =
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "error" };

export interface RendererDoc {
  render(page: number, width: number): Promise<Blob>;
  destroy(): void;
}

export interface Renderer {
  open(bytes: Uint8Array): Promise<RendererDoc>;
}

export interface QueuedJob {
  doc: DocKey;
  page: number;
  width: number;
  /** True while the thumbnail's element is within 400px of the viewport. */
  visible: boolean;
  /** Monotonic request order; lower = requested earlier. */
  seq: number;
}
