import { useCallback, useEffect, useState } from "react";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { downloadBlob } from "../lib/fileHelpers";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import PlacementCanvas from "../components/sign/PlacementCanvas";
import SignaturePad, { type Signature } from "../components/sign/SignaturePad";
import { stampDate } from "../lib/stampBuilders";
import { substituteJsTokens } from "../lib/stampJob";
import {
  SIGNED_ON_SIZE,
  buildSignJob,
  clampVisibleRect,
  initialSignatureRect,
  signedOnOrigin,
  type VisibleRect,
} from "../lib/signPlacement";
import ToolShell from "./ToolShell";
import { checkClass, fileMeta, panelClass, primaryButton, secondaryButton } from "../styles/ui";
import CropPageStrip from "../components/geometry/CropPageStrip";
import { baseName, usePdfInput } from "./usePdfInput";
import { useLocale, useT } from "../i18n";


function StepHeading({ n, children }: { n: number; children: string }) {
  return (
    <h2 className="flex items-baseline gap-3 font-display text-base font-normal uppercase tracking-wider text-ink">
      <span className="font-mono text-[11px] tracking-[0.08em] text-ink-2">{String(n).padStart(2, "0")}</span>
      {children}
    </h2>
  );
}

export default function SignPdfPage() {
  const t = useT("sign");
  const locale = useLocale();
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
  const signedOn = addDate ? substituteJsTokens(signedOnTemplate, { date: stampDate(locale), filename: input ? baseName(input.file) : "" }) : null;

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
      tool="sign"
      title={t("seoTitle")}
      description={t("seoDescription")}
      path="/sign"
      heading={t("heading")}
      intro={t("intro")}
    >
      <ErrorAlert error={worker.initProblem} className="mt-6" />

      {!input && (
        <div className="mt-8">
          <DropZone onFile={(f) => { setPage(1); setRect(null); void pick(f); }} error={error} />
        </div>
      )}

      {input && (
        <form className={panelClass} onSubmit={submit}>
          <p className={fileMeta}>
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
                <CropPageStrip source={input.file} count={sizes.length} page={page} disabled={false} onPage={setPage} />
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
                <label className="mt-4 flex items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={addDate}
                    onChange={(e) => setAddDate(e.target.checked)}
                    className={checkClass}
                  />
                  {t("addDate", { text: substituteJsTokens(signedOnTemplate, { date: stampDate(locale), filename: "" }) })}
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
          <p className="mt-4 text-xs text-ink-2">{t("visualOnly")}</p>
        </form>
      )}
    </ToolShell>
  );
}
