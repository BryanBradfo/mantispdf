import { useCallback, useState } from "react";
import { PageSEO } from "../components/seo/PageSEO";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { validatePdfFile, downloadBlob } from "../lib/fileHelpers";
import DropZone from "../components/split/DropZone";

interface CompressionResult {
  originalSize: number;
  compressedSize: number;
  bytes: Uint8Array;
  fileName: string;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

export default function CompressPdfPage() {
  const worker = usePdfWorker();
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [compressError, setCompressError] = useState<string | null>(null);
  const [result, setResult] = useState<CompressionResult | null>(null);

  const handleFile = useCallback(
    async (file: File) => {
      const validationError = validatePdfFile(file);
      if (validationError) {
        setUploadError(validationError);
        return;
      }
      setUploadError(null);
      setCompressError(null);
      setResult(null);

      try {
        const compressed = await worker.compressPdf(file);
        setResult({
          originalSize: file.size,
          compressedSize: compressed.byteLength,
          bytes: new Uint8Array(compressed),
          fileName: file.name.replace(/\.pdf$/i, "") + "_compressed.pdf",
        });
      } catch (err) {
        setCompressError(String(err));
      }
    },
    [worker],
  );

  const handleDownload = useCallback(() => {
    if (!result) return;
    downloadBlob(result.bytes, result.fileName);
  }, [result]);

  const savings = result
    ? Math.round(((result.originalSize - result.compressedSize) / result.originalSize) * 100)
    : 0;

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <PageSEO
        title="Compress PDF — Reduce PDF File Size — MantisPDF"
        description="Reduce PDF file size by compressing images and streams. No upload, no data sent to any server."
        path="/compress"
      />
      <h1 className="text-3xl font-bold text-gray-900 dark:text-[#e5e5e5]">Compress PDF</h1>
      <p className="mt-2 text-gray-600 dark:text-[#555]">
        Reduce file size by downsampling and re-encoding images, stripping metadata, and compressing streams — no upload required.
      </p>

      {worker.initError && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400">
          WASM engine failed to load: {worker.initError}
        </div>
      )}

      {!result && !worker.compressing && (
        <div className="mt-8">
          <DropZone onFile={handleFile} error={uploadError} />
        </div>
      )}

      {worker.compressing && (
        <div className="mt-12 flex flex-col items-center justify-center gap-4">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-mantis-300 border-t-transparent" />
          <p className="text-gray-500 dark:text-[#555]">Compressing…</p>
        </div>
      )}

      {compressError && (
        <div className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400">
          {compressError}
          <button
            onClick={() => { setCompressError(null); }}
            className="ml-4 underline"
          >
            Try again
          </button>
        </div>
      )}

      {result && (
        <div className="mt-8 rounded-xl border border-mantis-200 bg-mantis-50/50 p-6 dark:border-mantis-900 dark:bg-[#0f1a0f]">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <p className="text-sm text-gray-500 dark:text-[#555]">Original</p>
              <p className="text-xl font-semibold text-gray-800 dark:text-[#ccc]">
                {formatBytes(result.originalSize)}
              </p>
            </div>
            <div className="text-2xl text-mantis-500">→</div>
            <div className="flex-1">
              <p className="text-sm text-gray-500 dark:text-[#555]">Compressed</p>
              <p className="text-xl font-semibold text-gray-800 dark:text-[#ccc]">
                {formatBytes(result.compressedSize)}
              </p>
            </div>
            <div className="rounded-lg bg-mantis-100 px-3 py-2 text-center dark:bg-mantis-900/40">
              <p className="text-2xl font-bold text-mantis-700 dark:text-mantis-400">
                {savings > 0 ? `-${savings}%` : "~0%"}
              </p>
              <p className="text-xs text-mantis-600 dark:text-mantis-500">smaller</p>
            </div>
          </div>

          <div className="mt-6 flex gap-3">
            <button
              onClick={handleDownload}
              className="flex-1 rounded-lg bg-mantis-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-mantis-700 focus:outline-none focus:ring-2 focus:ring-mantis-500 focus:ring-offset-2"
            >
              Download compressed PDF
            </button>
            <button
              onClick={() => setResult(null)}
              className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-[#333] dark:text-[#aaa] dark:hover:bg-[#1a1a1a]"
            >
              Compress another
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
