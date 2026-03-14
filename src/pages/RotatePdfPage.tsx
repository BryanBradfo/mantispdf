import { useCallback, useEffect, useState } from "react";
import { Document, Thumbnail } from "react-pdf";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { validatePdfFile, downloadBlob } from "../lib/fileHelpers";
import DropZone from "../components/split/DropZone";

export default function RotatePdfPage() {
  const worker = usePdfWorker();

  const [file, setFile] = useState<File | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [rotations, setRotations] = useState<number[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [rotateError, setRotateError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  const handleFile = useCallback((f: File) => {
    const err = validatePdfFile(f);
    if (err) {
      setUploadError(err);
      return;
    }
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    setUploadError(null);
    setRotateError(null);
    setFile(f);
    setBlobUrl(URL.createObjectURL(f));
    setNumPages(0);
    setRotations([]);
  }, [blobUrl]);

  const handleDocumentLoad = useCallback(({ numPages: n }: { numPages: number }) => {
    setNumPages(n);
    setRotations(Array(n).fill(0));
  }, []);

  const rotatePage = useCallback((idx: number, delta: number) => {
    setRotations((r) => r.map((v, i) => (i === idx ? ((v + delta + 360) % 360) : v)));
  }, []);

  const rotateAll = useCallback((delta: number) => {
    setRotations((r) => r.map((v) => (v + delta + 360) % 360));
  }, []);

  const handleDownload = useCallback(async () => {
    if (!file || rotations.length === 0) return;
    setRotateError(null);
    try {
      const result = await worker.rotatePdf(file, rotations);
      const outName = file.name.replace(/\.pdf$/i, "") + "_rotated.pdf";
      downloadBlob(new Uint8Array(result), outName);
    } catch (err) {
      setRotateError(String(err));
    }
  }, [file, rotations, worker]);

  const handleReset = useCallback(() => {
    setFile(null);
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    setBlobUrl(null);
    setNumPages(0);
    setRotations([]);
    setRotateError(null);
  }, [blobUrl]);

  const allZero = rotations.every((v) => v === 0);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-3xl font-bold text-gray-900 dark:text-[#e5e5e5]">Rotate Pages</h1>
      <p className="mt-2 text-gray-600 dark:text-[#555]">
        Upload a PDF and rotate individual pages or the entire document. All processing happens in your browser.
      </p>

      {worker.initError && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400">
          WASM engine failed to load: {worker.initError}
        </div>
      )}

      {!file ? (
        <div className="mt-8">
          <DropZone onFile={handleFile} error={uploadError} />
        </div>
      ) : (
        <>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-gray-500 dark:text-[#555]">
              {file.name} — {numPages} page{numPages !== 1 ? "s" : ""}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => rotateAll(-90)}
                disabled={numPages === 0}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40 dark:border-[#333] dark:text-[#aaa] dark:hover:bg-[#1a1a1a]"
              >
                ↺ All CCW
              </button>
              <button
                onClick={() => rotateAll(90)}
                disabled={numPages === 0}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40 dark:border-[#333] dark:text-[#aaa] dark:hover:bg-[#1a1a1a]"
              >
                ↻ All CW
              </button>
              <button
                onClick={() => setRotations(Array(numPages).fill(0))}
                disabled={allZero || numPages === 0}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40 dark:border-[#333] dark:text-[#aaa] dark:hover:bg-[#1a1a1a]"
              >
                Reset All
              </button>
              <button
                onClick={handleDownload}
                disabled={worker.rotating || !worker.ready || numPages === 0}
                className="rounded-lg bg-mantis-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-mantis-700 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-mantis-500 focus:ring-offset-2"
              >
                {worker.rotating ? "Processing…" : "Download"}
              </button>
              <button
                onClick={handleReset}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-[#333] dark:text-[#aaa] dark:hover:bg-[#1a1a1a]"
              >
                New file
              </button>
            </div>
          </div>

          {rotateError && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400">
              {rotateError}
              <button onClick={() => setRotateError(null)} className="ml-4 underline">
                Dismiss
              </button>
            </div>
          )}

          {numPages === 0 ? (
            <div className="mt-8 flex items-center justify-center py-12">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-mantis-300 border-t-transparent" />
              <span className="ml-3 text-gray-500 dark:text-[#555]">Loading PDF…</span>
              <Document file={blobUrl} onLoadSuccess={handleDocumentLoad} className="hidden">
                {null}
              </Document>
            </div>
          ) : (
            <Document file={blobUrl} loading={null} className="mt-6">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {Array.from({ length: numPages }, (_, i) => (
                  <div key={i} className="flex flex-col items-center gap-2">
                    <div className="relative w-full">
                      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm dark:border-[#222] dark:bg-[#141414]">
                        <div className="relative aspect-[8.5/11] w-full bg-gray-100 dark:bg-[#1a1a1a]">
                          <Thumbnail
                            pageNumber={i + 1}
                            width={160}
                            className="h-full w-full object-contain"
                          />
                        </div>
                        <div className="border-t border-gray-100 px-2 py-1 text-center text-xs text-gray-500 dark:border-[#222] dark:text-[#555]">
                          Page {i + 1}
                        </div>
                      </div>
                      {rotations[i] !== 0 && (
                        <div className="absolute right-1.5 top-1.5 rounded bg-mantis-600 px-1.5 py-0.5 text-xs font-bold text-white">
                          {rotations[i]}°
                        </div>
                      )}
                    </div>
                    <div className="flex gap-1">
                      <button
                        onClick={() => rotatePage(i, -90)}
                        className="rounded border border-gray-200 px-2.5 py-1 text-sm hover:bg-gray-50 dark:border-[#333] dark:hover:bg-[#1a1a1a]"
                        title="Rotate counter-clockwise"
                      >
                        ↺
                      </button>
                      <button
                        onClick={() => rotatePage(i, 90)}
                        className="rounded border border-gray-200 px-2.5 py-1 text-sm hover:bg-gray-50 dark:border-[#333] dark:hover:bg-[#1a1a1a]"
                        title="Rotate clockwise"
                      >
                        ↻
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </Document>
          )}
        </>
      )}
    </div>
  );
}
