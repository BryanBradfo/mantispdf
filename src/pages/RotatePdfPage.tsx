import { useCallback, useRef, useState } from "react";
import { Link, useDescribeError, useT, type UiError } from "../i18n";
import { PageSEO } from "../components/seo/PageSEO";
import PageImage from "../components/common/PageImage";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { isPdfFile, downloadBlob, readFileAsUint8Array } from "../lib/fileHelpers";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import { thumbnailTransform } from "../lib/rotationTransform";

export default function RotatePdfPage() {
  const worker = usePdfWorker();

  const [file, setFile] = useState<File | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [rotations, setRotations] = useState<number[]>([]);
  const t = useT("rotate");
  const tc = useT("common");
  const describe = useDescribeError();
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [rotateError, setRotateError] = useState<UiError | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [loading, setLoading] = useState(false);
  // Identifies the latest upload so a superseded countPages result is ignored.
  const uploadToken = useRef(0);

  const handleFile = useCallback(
    async (f: File) => {
      if (!isPdfFile(f)) {
        setUploadError(tc("invalidPdf"));
        return;
      }
      if (!worker.ready) {
        setUploadError(worker.initError ? tc("engineFailedReload") : tc("engineLoading"));
        return;
      }
      const token = ++uploadToken.current;
      setUploadError(null);
      setRotateError(null);
      setLoading(true);
      try {
        const n = await worker.countPages(await readFileAsUint8Array(f));
        if (token !== uploadToken.current) return;
        if (n <= 0) {
          setUploadError(tc("readFailed"));
        } else {
          setFile(f);
          setNumPages(n);
          setRotations(Array(n).fill(0));
        }
      } catch {
        if (token === uploadToken.current) setUploadError(tc("readFailed"));
      } finally {
        if (token === uploadToken.current) setLoading(false);
      }
    },
    [worker, tc],
  );

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
      setDownloaded(true);
    } catch (err) {
      setRotateError(describe(err));
    }
  }, [file, rotations, worker, describe]);

  const handleReset = useCallback(() => {
    setFile(null);
    setNumPages(0);
    setRotations([]);
    setRotateError(null);
    setDownloaded(false);
  }, []);

  const allZero = rotations.every((v) => v === 0);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <PageSEO
        title={t("seoTitle")}
        description={t("seoDescription")}
        path="/rotate"
      />
      <h1 className="text-3xl font-bold text-gray-900 dark:text-[#e5e5e5]">{t("heading")}</h1>
      <p className="mt-2 text-gray-600 dark:text-[#555]">
        {t("intro")}
      </p>

      <ErrorAlert error={worker.initProblem} className="mt-4" />

      {!file ? (
        loading ? (
          <div className="mt-8 flex items-center justify-center py-12">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-mantis-300 border-t-transparent motion-reduce:animate-none" />
            <span className="ml-3 text-gray-500 dark:text-[#555]">{tc("loadingPdf")}</span>
          </div>
        ) : (
          <div className="mt-8">
            <DropZone onFile={handleFile} error={uploadError} />
          </div>
        )
      ) : (
        <>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-gray-500 dark:text-[#555]">
              {tc("fileWithPages", { name: file.name, count: numPages })}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => rotateAll(-90)}
                disabled={numPages === 0}
                aria-label={t("allCcwLabel")}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40 dark:border-[#333] dark:text-[#aaa] dark:hover:bg-[#1a1a1a]"
              >
                {t("allCcw")}
              </button>
              <button
                onClick={() => rotateAll(90)}
                disabled={numPages === 0}
                aria-label={t("allCwLabel")}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40 dark:border-[#333] dark:text-[#aaa] dark:hover:bg-[#1a1a1a]"
              >
                {t("allCw")}
              </button>
              <button
                onClick={() => setRotations(Array(numPages).fill(0))}
                disabled={allZero || numPages === 0}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40 dark:border-[#333] dark:text-[#aaa] dark:hover:bg-[#1a1a1a]"
              >
                {t("resetAll")}
              </button>
              <button
                onClick={handleDownload}
                disabled={worker.rotating || !worker.ready || numPages === 0}
                className="rounded-lg bg-mantis-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-mantis-700 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-mantis-500 focus:ring-offset-2"
              >
                {worker.rotating ? tc("processing") : tc("download")}
              </button>
              {downloaded && (
                <Link
                  to="/"
                  className="rounded-lg border border-mantis-500 px-3 py-1.5 text-sm font-medium text-mantis-700 hover:bg-mantis-50 dark:border-mantis-600 dark:text-mantis-400 dark:hover:bg-mantis-950/20"
                >
                  {tc("allTools")}
                </Link>
              )}
              <button
                onClick={handleReset}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-[#333] dark:text-[#aaa] dark:hover:bg-[#1a1a1a]"
              >
                {tc("newFile")}
              </button>
            </div>
          </div>

          <ErrorAlert error={rotateError} onDismiss={() => setRotateError(null)} className="mt-4" />

          <div className="mt-6">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {Array.from({ length: numPages }, (_, i) => (
                <div key={i} className="flex flex-col items-center gap-2">
                  <div className="relative w-full">
                    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm dark:border-[#222] dark:bg-[#141414]">
                      <div className="relative aspect-[8.5/11] w-full overflow-hidden bg-gray-100 dark:bg-[#1a1a1a]">
                        <div
                          className="absolute inset-0 flex items-center justify-center"
                          style={{
                            transform: thumbnailTransform(rotations[i] ?? 0),
                            transition: "transform 0.3s ease",
                          }}
                        >
                          <PageImage source={file!} page={i + 1} width={160} alt={tc("pageN", { n: i + 1 })} />
                        </div>
                      </div>
                      <div className="border-t border-gray-100 px-2 py-1 text-center text-xs text-gray-500 dark:border-[#222] dark:text-[#555]">
                        {tc("pageN", { n: i + 1 })}
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
                      title={t("ccw")}
                      aria-label={t("ccwPage", { n: i + 1 })}
                    >
                      ↺
                    </button>
                    <button
                      onClick={() => rotatePage(i, 90)}
                      className="rounded border border-gray-200 px-2.5 py-1 text-sm hover:bg-gray-50 dark:border-[#333] dark:hover:bg-[#1a1a1a]"
                      title={t("cw")}
                      aria-label={t("cwPage", { n: i + 1 })}
                    >
                      ↻
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
