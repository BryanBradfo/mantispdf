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

export async function downloadAsZip(parts: PdfPart[], baseName: string) {
  // Single part: skip the zip entirely, download as plain PDF
  if (parts.length === 1) {
    triggerDownload(
      new Blob([parts[0].bytes], { type: "application/pdf" }),
      parts[0].name,
    );
    return;
  }

  // Multiple parts: stream into a Blob via fflate Zip chunks.
  // fflate emits incremental Uint8Array chunks; Blob([chunks]) avoids
  // a single large contiguous ArrayBuffer allocation (unlike JSZip).
  const chunks: Uint8Array[] = [];
  await new Promise<void>((resolve, reject) => {
    const zip = new Zip((chunk, final) => {
      chunks.push(chunk);
      if (final) resolve();
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

  triggerDownload(
    new Blob(chunks, { type: "application/zip" }),
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

  const chunks: Uint8Array[] = [];
  await new Promise<void>((resolve, reject) => {
    const zip = new Zip((chunk, final) => {
      chunks.push(chunk);
      if (final) resolve();
    });

    try {
      for (const part of bytesParts) {
        const file = new ZipPassThrough(part.name); // STORE mode — no compression
        zip.add(file);
        file.push(part.bytes, true);
      }
      zip.end();
    } catch (err) {
      reject(err);
    }
  });

  triggerDownload(new Blob(chunks, { type: "application/zip" }), zipName);
}
