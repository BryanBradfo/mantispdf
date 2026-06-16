import type { ToWorker, FromWorker, ReqId, SuccessPayload } from "../lib/workerProtocol";
// @ts-ignore — resolved by Vite alias, typed via src/wasm.d.ts
import init, { get_page_count, extract_pages, WasmPdf, merge_pdfs, compress_pdf, rotate_pdf, reorder_pages, add_watermark, encrypt_pdf } from "mantis-wasm";

let ready = false;

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

      case "edit-pages": {
        const result = reorder_pages(msg.pdfBytes, Uint32Array.from(msg.newOrder));
        postSuccess(msg.id, { kind: "buffer", result: result.buffer }, [result.buffer as ArrayBuffer]);
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
    }
  } catch (err) {
    postFailure(msg.id, err);
  }
};
