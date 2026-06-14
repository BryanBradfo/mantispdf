import { Zip, ZipPassThrough } from "fflate";
import type { PdfPart } from "../types/pdf";

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Build a STORE-mode (uncompressed — PDFs/JPEGs are already compressed) zip from
 * in-memory parts, returning the complete archive bytes.
 *
 * fflate's `Zip` callback is `(err, chunk, final)`. Collect the streamed chunks
 * and concatenate on the final chunk.
 */
export function buildZip(parts: { name: string; bytes: Uint8Array }[]): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const zip = new Zip((err, chunk, final) => {
      if (err) {
        reject(err);
        return;
      }
      chunks.push(chunk);
      if (final) {
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
          out.set(c, offset);
          offset += c.length;
        }
        resolve(out);
      }
    });

    try {
      for (const part of parts) {
        const file = new ZipPassThrough(part.name); // STORE mode — no compression
        zip.add(file);
        file.push(part.bytes, true);
      }
      zip.end();
    } catch (err) {
      reject(err);
    }
  });
}

export async function downloadAsZip(parts: PdfPart[], baseName: string) {
  // Single part: skip the zip entirely, download as plain PDF
  if (parts.length === 1) {
    triggerDownload(
      new Blob([parts[0].bytes], { type: "application/pdf" }),
      parts[0].name,
    );
    return;
  }

  const zipped = await buildZip(parts);
  triggerDownload(
    new Blob([zipped], { type: "application/zip" }),
    `${baseName}_split.zip`,
  );
}

export async function downloadBlobsAsZip(
  parts: { name: string; blob: Blob }[],
  zipName: string,
) {
  // Read all blobs to bytes first (async, before entering the sync Zip loop)
  const bytesParts = await Promise.all(
    parts.map(async (p) => ({
      name: p.name,
      bytes: new Uint8Array(await p.blob.arrayBuffer()),
    })),
  );

  const zipped = await buildZip(bytesParts);
  triggerDownload(new Blob([zipped], { type: "application/zip" }), zipName);
}
