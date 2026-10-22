import { useCallback, useEffect, useState } from "react";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { downloadBlob } from "../lib/fileHelpers";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import PageImage from "../components/common/PageImage";
import PlacementCanvas from "../components/sign/PlacementCanvas";
import SignaturePad, { type Signature } from "../components/sign/SignaturePad";
import { todayIso } from "../lib/stampBuilders";
import { substituteJsTokens } from "../lib/stampJob";
import {
  SIGNED_ON_SIZE,
  buildSignJob,
  clampVisibleRect,
  initialSignatureRect,
  signedOnOrigin,
  type VisibleRect,
} from "../lib/signPlacement";
import ToolShell, { panelClass, primaryButton, secondaryButton } from "./ToolShell";
import { baseName, usePdfInput } from "./usePdfInput";
import { useT } from "../i18n";


function StepHeading({ n, children }: { n: number; children: string }) {
  return (
    <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-[#ddd]">
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-mantis-600 text-xs text-white">{n}</span>
      {children}
    </h2>
  );
}

export default function SignPdfPage() {
  const t = useT("sign");
  const tc = useT("common");
  const worker = usePdfWorker();
  const { pageSizes } = worker;
  const prepare = useCallback((bytes: Uint8Array) => pageSizes(bytes), [pageSizes]);
  const { input, error, setError, busy, pick, reset, run } = usePdfInput(worker, prepare);

  const [signature, setSignature] = useState<Signature | null>(null);
  const [page, setPage] = useState(1);
  const [rect, setRect] = useState<VisibleRect | null>(null);
  const [addDate, setAddDate] = useState(false);

  const sizes = input?.data ?? [];
  const total = sizes.length;
  const pageSize = sizes[page - 1] ?? null;
  const aspect = signature ? signature.width / signature.height : null;

  // Keep the box on the page and matching the signature's aspect when either changes.
  useEffect(() => {
    if (aspect === null || pageSize === null) return;
    setRect((r) =>
      r ? clampVisibleRect([r[0], r[1], r[2], r[2] / aspect], pageSize) : initialSignatureRect(aspect, pageSize),
    );
  }, [aspect, pageSize]);

  // Printed on the page, so in the UI language; {date} is resolved by the stamp tokens.
  const signedOnTemplate = t("signedOn", { date: "{date}" });
  const signedOn = addDate ? substituteJsTokens(signedOnTemplate, { date: todayIso(), filename: input ? baseName(input.file) : "" }) : null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input || busy || !signature || !rect || !pageSize) return;
    const job = buildSignJob(signature, page, rect, pageSize, signedOn);
    void run(
      () => worker.stampPdf(input.bytes, job),
      (out) => downloadBlob(out.bytes, `${baseName(input.file)}_signed.pdf`),
    );
  };

  const clear = () => {
    reset();
    setPage(1);
    setRect(null);
  };

  const ready = input !== null && signature !== null && rect !== null && pageSize !== null;

  return (
    <ToolShell
      title={t("seoTitle")}
      description={t("seoDescription")}
      path="/sign"
      heading={t("heading")}
      intro={t("intro")}
    >
      <ErrorAlert error={worker.initError ? tc("engineFailed", { error: worker.initError }) : null} className="mt-4" />

      {!input && (
        <div className="mt-8">
          <DropZone onFile={(f) => { setPage(1); setRect(null); void pick(f); }} error={error} />
        </div>
      )}

      {input && (
        <form className={panelClass} onSubmit={submit}>
          <p className="text-sm font-medium text-gray-800 dark:text-[#ccc]">
            {tc("fileWithPagesParen", { name: input.file.name, count: total })}
          </p>

          <section className="mt-6">
            <StepHeading n={1}>{t("stepCreate")}</StepHeading>
            <div className="mt-3"><SignaturePad onChange={setSignature} /></div>
          </section>

          {signature && pageSize && (
            <>
              <section className="mt-8">
                <StepHeading n={2}>{t("stepPage")}</StepHeading>
                <div className="mt-3 flex gap-2 overflow-x-auto pb-2" role="group" aria-label={tc("pagesGroup")}>
                  {sizes.map((_, i) => {
                    const n = i + 1;
                    return (
                      <button
                        key={n}
                        type="button"
                        aria-label={tc("pageN", { n })}
                        aria-pressed={page === n}
                        onClick={() => setPage(n)}
                        className={`w-20 shrink-0 overflow-hidden rounded-md border-2 bg-white text-xs dark:bg-[#111] ${
                          page === n ? "border-mantis-600" : "border-transparent hover:border-gray-300 dark:hover:border-[#444]"
                        }`}
                      >
                        <PageImage source={input.file} page={n} width={80} alt="" />
                        <span className="block py-0.5 text-gray-700 dark:text-[#aaa]">{n}</span>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="mt-6">
                <StepHeading n={3}>{t("stepPlace")}</StepHeading>
                <div className="mt-3">
                  {rect && (
                    <PlacementCanvas
                      source={input.file}
                      page={page}
                      pageSize={pageSize}
                      signatureUrl={signature.url}
                      rect={rect}
                      onRect={setRect}
                      caption={signedOn ? { text: signedOn, at: signedOnOrigin(rect, SIGNED_ON_SIZE, pageSize, signedOn), size: SIGNED_ON_SIZE } : null}
                    />
                  )}
                </div>
                <label className="mt-4 flex items-center gap-2 text-sm text-gray-700 dark:text-[#aaa]">
                  <input
                    type="checkbox"
                    checked={addDate}
                    onChange={(e) => setAddDate(e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300 text-mantis-600 focus:ring-mantis-500"
                  />
                  {t("addDate", { text: substituteJsTokens(signedOnTemplate, { date: todayIso(), filename: "" }) })}
                </label>
              </section>
            </>
          )}

          <ErrorAlert error={error} onDismiss={() => setError(null)} className="mt-4" />
          <div className="mt-6 flex gap-3">
            <button type="submit" disabled={busy || !ready} className={`flex-1 ${primaryButton}`}>
              {busy ? t("signing") : t("submit")}
            </button>
            <button type="button" onClick={clear} className={secondaryButton}>{tc("chooseAnother")}</button>
          </div>
          <p className="mt-4 text-xs text-gray-500 dark:text-[#777]">{t("visualOnly")}</p>
        </form>
      )}
    </ToolShell>
  );
}
