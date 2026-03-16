import type { ToWorker, FromWorker } from "../lib/workerProtocol";
// @ts-ignore — resolved by Vite alias, typed via src/wasm.d.ts
import init, { get_page_count, extract_pages, merge_pdfs, compress_pdf, rotate_pdf, reorder_pages, add_watermark, encrypt_pdf } from "mantis-wasm";

function post(msg: FromWorker) {
  self.postMessage(msg);
}

let ready = false;

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data;

  switch (msg.type) {
    case "init": {
      try {
        await init();
        ready = true;
        post({ type: "init-done" });
      } catch (err) {
        post({ type: "init-error", error: String(err) });
      }
      break;
    }

    case "split": {
      if (!ready) {
        post({ type: "split-error", error: "WASM not initialized" });
        return;
      }

      try {
        const { pdfBytes, splitAfterPages } = msg;
        const totalPages = get_page_count(pdfBytes);

        // Convert split-after-page indices into page ranges
        // e.g. splitAfterPages=[2,5] with 8 pages → ranges: [1,2], [3,5], [6,8]
        const sorted = [...splitAfterPages].sort((a, b) => a - b);
        const ranges: [number, number][] = [];
        let start = 1;
        for (const splitAfter of sorted) {
          ranges.push([start, splitAfter]);
          start = splitAfter + 1;
        }
        ranges.push([start, totalPages]);

        const parts: { name: string; bytes: Uint8Array }[] = [];

        for (let i = 0; i < ranges.length; i++) {
          const [rangeStart, rangeEnd] = ranges[i];
          post({
            type: "split-progress",
            progress: i / ranges.length,
            message: `Extracting part ${i + 1} of ${ranges.length} (pages ${rangeStart}–${rangeEnd})`,
          });

          const bytes = extract_pages(pdfBytes, rangeStart, rangeEnd);
          parts.push({
            name: `pages_${rangeStart}-${rangeEnd}.pdf`,
            bytes: new Uint8Array(bytes),
          });
        }

        post({ type: "split-progress", progress: 1, message: "Done" });
        post({ type: "split-done", parts });
      } catch (err) {
        post({ type: "split-error", error: String(err) });
      }
      break;
    }

    case "merge": {
      if (!ready) {
        post({ type: "merge-error", error: "WASM not initialized" });
        return;
      }

      try {
        const { pdfBuffers } = msg;
        post({
          type: "merge-progress",
          progress: 0.2,
          message: `Merging ${pdfBuffers.length} documents…`,
        });

        const merged = merge_pdfs(pdfBuffers);

        post({ type: "merge-progress", progress: 1, message: "Done" });
        post({ type: "merge-done", bytes: new Uint8Array(merged) });
      } catch (err) {
        post({ type: "merge-error", error: String(err) });
      }
      break;
    }

    case "count-pages": {
      if (!ready) {
        post({ type: "count-error", error: "WASM not initialized" });
        return;
      }
      try {
        const count = get_page_count(msg.pdfBytes);
        post({ type: "count-done", count });
      } catch (err) {
        post({ type: "count-error", error: String(err) });
      }
      break;
    }

    case "compress": {
      if (!ready) {
        post({ type: "compress-error", error: "WASM not initialized" });
        return;
      }
      try {
        const result = compress_pdf(new Uint8Array(msg.pdfBytes), 40);
        self.postMessage({ type: "compress-done", result: result.buffer } satisfies FromWorker, { transfer: [result.buffer as ArrayBuffer] });
      } catch (err) {
        post({ type: "compress-error", error: String(err) });
      }
      break;
    }

    case "rotate": {
      if (!ready) {
        post({ type: "rotate-error", error: "WASM not initialized" });
        return;
      }
      try {
        const bytes = new Uint8Array(msg.pdfBytes);
        const result = rotate_pdf(bytes, new Int32Array(msg.rotations));
        self.postMessage(
          { type: "rotate-done", result: result.buffer } satisfies FromWorker,
          { transfer: [result.buffer as ArrayBuffer] },
        );
      } catch (err) {
        post({ type: "rotate-error", error: String(err) });
      }
      return;
    }

    case "edit-pages": {
      if (!ready) {
        post({ type: "edit-error", message: "WASM not initialized" });
        return;
      }
      try {
        const result = reorder_pages(msg.pdfBytes, Uint32Array.from(msg.newOrder));
        self.postMessage(
          { type: "edit-done", result: result.buffer } satisfies FromWorker,
          { transfer: [result.buffer as ArrayBuffer] },
        );
      } catch (err) {
        post({ type: "edit-error", message: String(err) });
      }
      break;
    }

    case "watermark": {
      if (!ready) { post({ type: "watermark-error", error: "WASM not ready" }); break; }
      try {
        const bytes = new Uint8Array(msg.pdfBytes);
        const result = add_watermark(bytes, msg.text, msg.fontSize, msg.opacity, msg.angle, msg.r, msg.g, msg.b);
        self.postMessage(
          { type: "watermark-done", result: result.buffer } satisfies FromWorker,
          { transfer: [result.buffer as ArrayBuffer] },
        );
      } catch (e) {
        post({ type: "watermark-error", error: String(e) });
      }
      break;
    }

    case "encrypt": {
      if (!ready) { post({ type: "encrypt-error", error: "WASM not ready" }); break; }
      try {
        const bytes = new Uint8Array(msg.pdfBytes);
        const result = encrypt_pdf(bytes, msg.userPassword, msg.ownerPassword);
        self.postMessage(
          { type: "encrypt-done", result: result.buffer } satisfies FromWorker,
          { transfer: [result.buffer as ArrayBuffer] },
        );
      } catch (e) {
        post({ type: "encrypt-error", error: String(e) });
      }
      break;
    }
  }
};
