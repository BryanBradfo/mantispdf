import { toWasmJob } from "../lib/stampJob";
import type { ExtractedImage } from "../lib/imageInput";
import type { ToWorker, FromWorker, ReqId, SuccessPayload } from "../lib/workerProtocol";
// @ts-ignore — resolved by Vite alias, typed via src/wasm.d.ts
import init, { get_page_count, extract_pages, WasmPdf, merge_pdfs, compress_pdf, rotate_pdf, apply_page_plan, add_watermark, encrypt_pdf, sanitize_pdf, stamp_pdf, edit_pdf, crop_pdf, resize_pdf, nup_pdf, images_to_pdf, extract_images, visible_page_sizes, remove_metadata, read_metadata, set_metadata, unlock_pdf, list_form, fill_form, redact_plan, redact, redact_search, redact_prepare, add_text_layer, FontStore } from "mantis-wasm";
import { createFontLoader } from "../lib/fonts/loader";
import { attachJobFonts, type TextLayout } from "../lib/fonts/jobFonts";

let ready = false;
/** Self-hosted fonts (same origin), fetched once per worker and kept for previews and downloads. */
const fonts = createFontLoader();
/**
 * Font files copied into wasm memory once each for previews (layout-text runs on every pause in
 * typing): a 10 MB CJK file is not copied again per call. Freed by `reset-fonts` (a page reset or
 * leaving the editor), and started afresh when full.
 */
let store: FontStore | null = null;

async function layoutStore(files: string[]): Promise<FontStore> {
  for (let attempt = 0; attempt < 2; attempt++) {
    store ??= new FontStore();
    const missing = files.filter((f) => !store!.has(f));
    try {
      for (const f of missing) store.add(f, await fonts.font(f));
      return store;
    } catch (e) {
      // Full (20 files or 64 MiB): start a store holding only what this layout needs.
      store.free();
      store = null;
      if (attempt === 1) throw e;
    }
  }
  throw new Error("unreachable");
}

function postProgress(id: ReqId, progress: number, message: string) {
  self.postMessage({ type: "progress", id, progress, message } satisfies FromWorker);
}

function postSuccess(id: ReqId, payload: SuccessPayload, transfer: Transferable[] = []) {
  self.postMessage({ type: "success", id, payload } satisfies FromWorker, { transfer });
}

function postFailure(id: ReqId, error: unknown) {
  self.postMessage({ type: "failure", id, error: String(error) } satisfies FromWorker);
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data;

  if (msg.type === "init") {
    try {
      await init();
      ready = true;
      self.postMessage({ type: "init-done" } satisfies FromWorker);
    } catch (err) {
      self.postMessage({ type: "init-error", error: String(err) } satisfies FromWorker);
    }
    return;
  }

  if (!ready) {
    postFailure(msg.id, "WASM engine not initialized");
    return;
  }

  try {
    switch (msg.type) {
      case "split": {
        const pdfBytes = new Uint8Array(msg.pdfBytes);
        const sorted = [...msg.splitAfterPages].sort((a, b) => a - b);

        // Parse once — WasmPdf holds the document through the whole loop.
        const pdf = new WasmPdf(pdfBytes);
        const totalPages = pdf.page_count();

        const ranges: [number, number][] = [];
        let start = 1;
        for (const splitAfter of sorted) {
          ranges.push([start, splitAfter]);
          start = splitAfter + 1;
        }
        ranges.push([start, totalPages]);

        postProgress(msg.id, 0.05, `Splitting into ${ranges.length} parts…`);

        const parts: { name: string; bytes: Uint8Array }[] = [];
        for (let i = 0; i < ranges.length; i++) {
          const [rangeStart, rangeEnd] = ranges[i];
          const bytes = pdf.extract_range(rangeStart, rangeEnd);
          parts.push({ name: `pages_${rangeStart}-${rangeEnd}.pdf`, bytes });
          postProgress(msg.id, 0.05 + (0.85 * (i + 1)) / ranges.length, `Extracting part ${i + 1} of ${ranges.length}…`);
        }
        pdf.free();

        postProgress(msg.id, 1, "Preparing download…");
        const transfer = parts.map((p) => p.bytes.buffer as ArrayBuffer);
        postSuccess(msg.id, { kind: "split", parts }, transfer);
        break;
      }

      case "merge": {
        postProgress(msg.id, 0.2, `Merging ${msg.pdfBuffers.length} documents…`);
        const merged = merge_pdfs(msg.pdfBuffers);
        postProgress(msg.id, 1, "Done");
        postSuccess(msg.id, { kind: "merge", bytes: new Uint8Array(merged) });
        break;
      }

      case "count-pages": {
        const count = get_page_count(msg.pdfBytes);
        postSuccess(msg.id, { kind: "count", count });
        break;
      }

      case "compress": {
        const result = compress_pdf(new Uint8Array(msg.pdfBytes), 40);
        postSuccess(msg.id, { kind: "buffer", result: result.buffer }, [result.buffer as ArrayBuffer]);
        break;
      }

      case "rotate": {
        const result = rotate_pdf(new Uint8Array(msg.pdfBytes), new Int32Array(msg.rotations));
        postSuccess(msg.id, { kind: "buffer", result: result.buffer }, [result.buffer as ArrayBuffer]);
        break;
      }

      case "page-plan": {
        const result = apply_page_plan(msg.pdfBuffers, msg.plan);
        postSuccess(msg.id, { kind: "merge", bytes: new Uint8Array(result) });
        break;
      }

      case "watermark": {
        const result = add_watermark(new Uint8Array(msg.pdfBytes), msg.text, msg.fontSize, msg.opacity, msg.angle, msg.r, msg.g, msg.b);
        postSuccess(msg.id, { kind: "buffer", result: result.buffer }, [result.buffer as ArrayBuffer]);
        break;
      }

      case "encrypt": {
        const result = encrypt_pdf(new Uint8Array(msg.pdfBytes), msg.userPassword, msg.ownerPassword);
        postSuccess(msg.id, { kind: "buffer", result: result.buffer }, [result.buffer as ArrayBuffer]);
        break;
      }

      case "sanitize": {
        const out = sanitize_pdf(msg.pdfBytes, msg.keepComments);
        let bytes: Uint8Array;
        let report: number[];
        try {
          bytes = out.bytes();
          report = Array.from(out.report());
        } finally {
          out.free();
        }
        postSuccess(msg.id, { kind: "sanitized", bytes, report });
        break;
      }

      case "stamp": {
        const out = stamp_pdf(msg.pdfBytes, toWasmJob(msg.job));
        let bytes: Uint8Array;
        let stampedPages: number;
        try {
          bytes = out.bytes();
          stampedPages = out.stamped_pages();
        } finally {
          out.free();
        }
        postSuccess(msg.id, { kind: "stamped", bytes, stampedPages });
        break;
      }

      case "list-form": {
        postSuccess(msg.id, { kind: "form", info: list_form(msg.pdfBytes) });
        break;
      }

      case "fill-form": {
        // Noto fonts by file name: the bytes come from this worker's loader (same origin).
        const formFonts = msg.fonts
          ? {
              files: await Promise.all(msg.fonts.files.map(async (id) => ({ id, bytes: await fonts.font(id) }))),
              fields: msg.fonts.fields,
            }
          : undefined;
        const bytes = fill_form(msg.pdfBytes, msg.values, msg.flatten, formFonts);
        // A fresh copy out of WASM memory: hand it over instead of cloning.
        postSuccess(msg.id, { kind: "merge", bytes }, [bytes.buffer as ArrayBuffer]);
        break;
      }

      case "redact-plan": {
        postSuccess(msg.id, { kind: "redact-plan", pages: redact_plan(msg.pdfBytes, msg.rects) });
        break;
      }

      case "redact-prepare": {
        const bytes = redact_prepare(msg.pdfBytes);
        // A fresh copy out of WASM memory: hand it over instead of cloning.
        postSuccess(msg.id, { kind: "bytes", bytes }, [bytes.buffer as ArrayBuffer]);
        break;
      }

      case "ocr-text-layer": {
        const { bytes, alreadyOcrPages } = add_text_layer(msg.pdfBytes, msg.pages);
        // A fresh copy out of WASM memory: hand it over instead of cloning.
        postSuccess(msg.id, { kind: "text-layer", bytes, alreadyOcrPages }, [bytes.buffer as ArrayBuffer]);
        break;
      }

      case "redact-search": {
        postSuccess(msg.id, { kind: "redact-search", result: redact_search(msg.pdfBytes, msg.query, msg.options) });
        break;
      }

      case "redact": {
        const result = redact(msg.pdfBytes, msg.job);
        // A fresh copy out of WASM memory: hand it over instead of cloning.
        postSuccess(msg.id, { kind: "redacted", result }, [result.bytes.buffer as ArrayBuffer]);
        break;
      }

      case "reset-fonts": {
        store?.free();
        store = null;
        postSuccess(msg.id, { kind: "count", count: 0 });
        break;
      }

      case "layout-text": {
        const held = await layoutStore(msg.fonts);
        const layout = held.layout_text(msg.fonts, msg.text, msg.size, msg.width, msg.height, msg.align, msg.lineHeight) as TextLayout;
        postSuccess(msg.id, { kind: "text-layout", layout });
        break;
      }

      case "edit-pdf": {
        const bytes = edit_pdf(msg.pdfBytes, await attachJobFonts(msg.job, fonts));
        // A fresh copy out of WASM memory: hand it over instead of cloning.
        postSuccess(msg.id, { kind: "merge", bytes }, [bytes.buffer as ArrayBuffer]);
        break;
      }

      case "crop": {
        postSuccess(msg.id, { kind: "merge", bytes: crop_pdf(msg.pdfBytes, msg.job) });
        break;
      }

      case "resize": {
        postSuccess(msg.id, { kind: "merge", bytes: resize_pdf(msg.pdfBytes, msg.job) });
        break;
      }

      case "nup": {
        const out = nup_pdf(msg.pdfBytes, msg.job);
        let bytes: Uint8Array;
        let sheets: number;
        let undecodable: number[];
        try {
          bytes = out.bytes();
          sheets = out.sheets();
          undecodable = Array.from(out.undecodable());
        } finally {
          out.free();
        }
        postSuccess(msg.id, { kind: "nup", bytes, sheets, undecodable });
        break;
      }

      case "images-to-pdf": {
        const bytes = images_to_pdf(msg.images, msg.layout);
        // Hand the (possibly very large) PDF over instead of copying it.
        postSuccess(msg.id, { kind: "merge", bytes }, [bytes.buffer as ArrayBuffer]);
        break;
      }

      case "extract-images": {
        const out = extract_images(msg.pdfBytes);
        const images: ExtractedImage[] = [];
        const transfer: Transferable[] = [];
        const skipped: { reason: string; count: number }[] = [];
        try {
          for (let i = 0; i < out.count(); i++) {
            const page = out.page(i);
            const index = out.index(i);
            if (out.is_jpeg(i)) {
              const bytes = out.bytes(i);
              images.push({ page, index, kind: "jpeg", bytes });
              transfer.push(bytes.buffer as ArrayBuffer);
            } else {
              const pixels = out.pixels(i);
              images.push({ page, index, kind: "rgba", width: out.width(i), height: out.height(i), pixels });
              transfer.push(pixels.buffer as ArrayBuffer);
            }
          }
          const reasons = out.skipped_reasons();
          const counts = out.skipped_counts();
          for (let i = 0; i < reasons.length; i++) skipped.push({ reason: reasons[i], count: counts[i] ?? 0 });
        } finally {
          out.free();
        }
        postSuccess(msg.id, { kind: "extracted", result: { images, skipped } }, transfer);
        break;
      }

      case "page-sizes": {
        const flat = visible_page_sizes(msg.pdfBytes);
        const sizes: [number, number][] = [];
        for (let i = 0; i + 1 < flat.length; i += 2) sizes.push([flat[i], flat[i + 1]]);
        postSuccess(msg.id, { kind: "sizes", sizes });
        break;
      }

      case "remove-metadata": {
        postSuccess(msg.id, { kind: "merge", bytes: new Uint8Array(remove_metadata(msg.pdfBytes)) });
        break;
      }

      case "read-metadata": {
        postSuccess(msg.id, { kind: "metadata", values: read_metadata(msg.pdfBytes) });
        break;
      }

      case "set-metadata": {
        const result = set_metadata(msg.pdfBytes, msg.title, msg.author, msg.subject, msg.keywords);
        postSuccess(msg.id, { kind: "merge", bytes: new Uint8Array(result) });
        break;
      }

      case "unlock": {
        postSuccess(msg.id, { kind: "merge", bytes: new Uint8Array(unlock_pdf(msg.pdfBytes, msg.password)) });
        break;
      }
    }
  } catch (err) {
    postFailure(msg.id, err);
  }
};
