import { pickNext } from "./priority";
import type { DocKey, QueuedJob, Renderer, RendererDoc, ThumbState } from "./types";

export const LOADING: ThumbState = { status: "loading" };
const ERROR: ThumbState = { status: "error" };

export interface StoreOptions {
  concurrency?: number;
  createUrl?: (blob: Blob) => string;
  revokeUrl?: (url: string) => void;
  /** Schedules the final dispose after the last release (default: setTimeout 0). */
  defer?: (fn: () => void) => void;
}

interface DocEntry {
  source: Blob | Uint8Array;
  refs: number;
  open: Promise<RendererDoc> | null;
  urls: Set<string>;
  releasePending: boolean;
  disposed: boolean;
}

const SEP = "\u0000";
const keyOf = (doc: DocKey, page: number, width: number) => `${doc}${SEP}${page}${SEP}${width}`;

const docKeys = new WeakMap<object, DocKey>();
let nextDocKey = 0;
/** Stable key per source object: same File/Uint8Array -> same key. */
export function docKeyFor(source: Blob | Uint8Array): DocKey {
  let key = docKeys.get(source);
  if (key === undefined) {
    key = `doc${++nextDocKey}`;
    docKeys.set(source, key);
  }
  return key;
}

/**
 * Owns all thumbnail rendering: one renderer document per DocKey, a bounded
 * render queue, and the lifetime of every thumbnail blob: URL. Components never
 * create or revoke these URLs themselves (that raced StrictMode and broke images).
 */
export class ThumbnailStore {
  private readonly docs = new Map<DocKey, DocEntry>();
  private readonly states = new Map<string, ThumbState>();
  private queue: QueuedJob[] = [];
  private inFlight = 0;
  private seq = 0;
  private readonly listeners = new Set<() => void>();
  private readonly concurrency: number;
  private readonly createUrl: (blob: Blob) => string;
  private readonly revokeUrl: (url: string) => void;
  private readonly defer: (fn: () => void) => void;

  constructor(private readonly renderer: Renderer, opts: StoreOptions = {}) {
    this.concurrency = opts.concurrency ?? 2;
    this.createUrl = opts.createUrl ?? ((b) => URL.createObjectURL(b));
    this.revokeUrl = opts.revokeUrl ?? ((u) => URL.revokeObjectURL(u));
    this.defer = opts.defer ?? ((fn) => setTimeout(fn, 0));
  }

  get inFlightCount(): number {
    return this.inFlight;
  }

  register(doc: DocKey, source: Blob | Uint8Array): void {
    const entry = this.docs.get(doc);
    if (entry) {
      entry.refs++;
      entry.releasePending = false;
      return;
    }
    this.docs.set(doc, { source, refs: 1, open: null, urls: new Set(), releasePending: false, disposed: false });
  }

  release(doc: DocKey): void {
    const entry = this.docs.get(doc);
    if (!entry) return;
    entry.refs--;
    if (entry.refs > 0) return;
    entry.releasePending = true;
    this.defer(() => {
      if (entry.releasePending && this.docs.get(doc) === entry) this.dispose(doc, entry);
    });
  }

  request(doc: DocKey, page: number, width: number): void {
    const key = keyOf(doc, page, width);
    if (this.states.has(key) || !this.docs.has(doc)) return;
    this.states.set(key, LOADING);
    this.queue.push({ doc, page, width, visible: false, seq: this.seq++ });
    this.emit();
    this.pump();
  }

  setVisible(doc: DocKey, page: number, width: number, visible: boolean): void {
    const job = this.queue.find((j) => j.doc === doc && j.page === page && j.width === width);
    if (job) job.visible = visible;
  }

  getThumb(doc: DocKey, page: number, width: number): ThumbState | undefined {
    return this.states.get(keyOf(doc, page, width));
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private pump(): void {
    while (this.inFlight < this.concurrency && this.queue.length > 0) {
      const idx = pickNext(this.queue);
      const [job] = this.queue.splice(idx < 0 ? 0 : idx, 1);
      this.inFlight++;
      void this.run(job).finally(() => {
        this.inFlight--;
        this.pump();
      });
    }
  }

  private async run(job: QueuedJob): Promise<void> {
    const entry = this.docs.get(job.doc);
    if (!entry) return;
    const key = keyOf(job.doc, job.page, job.width);
    let next: ThumbState;
    try {
      entry.open ??= this.openDoc(entry.source);
      const doc = await entry.open;
      const blob = await doc.render(job.page, job.width);
      if (entry.disposed) return;
      const url = this.createUrl(blob);
      entry.urls.add(url);
      next = { status: "ready", url };
    } catch {
      if (entry.disposed) return;
      next = ERROR;
    }
    this.states.set(key, next);
    this.emit();
  }

  private async openDoc(source: Blob | Uint8Array): Promise<RendererDoc> {
    // pdf.js transfers (detaches) the buffer it is given, so always pass a copy.
    const bytes = source instanceof Uint8Array ? source.slice() : new Uint8Array(await source.arrayBuffer());
    return this.renderer.open(bytes);
  }

  private dispose(doc: DocKey, entry: DocEntry): void {
    this.docs.delete(doc);
    entry.disposed = true;
    for (const url of entry.urls) this.revokeUrl(url);
    this.queue = this.queue.filter((j) => j.doc !== doc);
    const prefix = doc + SEP;
    for (const key of [...this.states.keys()]) if (key.startsWith(prefix)) this.states.delete(key);
    entry.open?.then((d) => d.destroy(), () => {});
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
