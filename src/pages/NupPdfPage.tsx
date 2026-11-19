import { useCallback, useMemo, useState } from "react";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { downloadBlob } from "../lib/fileHelpers";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import LiveSummary from "../components/stamp/LiveSummary";
import PaperSizeFields, { CUSTOM_PAPER, paperToPt, type PaperChoice } from "../components/geometry/PaperSizeFields";
import SheetPreview from "../components/geometry/SheetPreview";
import { mmToPt, type NupJobSpec, type Orientation } from "../lib/geometryJob";
import { fitInCell, mmSizeLabel, nupCells, nupGrid, nupProblem, nupSheetSize } from "../lib/geometryLayout";
import ToolShell from "./ToolShell";
import { TriangleAlert } from "lucide-react";
import ToggleChip from "../components/common/ToggleChip";
import { fileMeta, inputClass, monoLabel, noticeClass, panelClass, primaryButton, secondaryButton } from "../styles/ui";
import { baseName, usePdfInput } from "./usePdfInput";
import { useT } from "../i18n";

const PER_SHEET = [2, 4, 6, 8, 9, 16] as const;

const ORIENTATIONS: readonly Orientation[] = ["auto", "portrait", "landscape"];

/** Small grid icon for a per-sheet choice. */
function LayoutIcon({ n }: { n: NupJobSpec["perSheet"] }) {
  const [c, r] = nupGrid(n, false);
  const w = 20;
  const h = 28;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-7 w-5" aria-hidden="true">
      {Array.from({ length: c * r }, (_, i) => (
        <rect
          key={i}
          x={1 + (i % c) * ((w - 2) / c) + 0.5}
          y={1 + Math.floor(i / c) * ((h - 2) / r) + 0.5}
          width={(w - 2) / c - 1}
          height={(h - 2) / r - 1}
          fill="currentColor"
          opacity={0.55}
        />
      ))}
    </svg>
  );
}

export default function NupPdfPage() {
  const t = useT("nUp");
  const tg = useT("geometry");
  const tc = useT("common");
  const worker = usePdfWorker();
  const { pageSizes } = worker;
  const prepare = useCallback((bytes: Uint8Array) => pageSizes(bytes), [pageSizes]);
  const { input, error, setError, busy, pick, reset, run } = usePdfInput(worker, prepare);

  const [perSheet, setPerSheet] = useState<NupJobSpec["perSheet"]>(4);
  const [paper, setPaper] = useState<PaperChoice>("A4");
  const [customMm, setCustomMm] = useState<[number, number]>([210, 297]);
  const [orientation, setOrientation] = useState<Orientation>("auto");
  const [order, setOrder] = useState<NupJobSpec["order"]>("rows");
  const [marginMm, setMarginMm] = useState(10);
  const [gapMm, setGapMm] = useState(5);
  const [border, setBorder] = useState(false);
  /** Pages the last run left blank, with the settings they were made with. */
  const [undecodable, setUndecodable] = useState<{ settings: string; pages: number[] }>({ settings: "", pages: [] });
  const [made, setMade] = useState<{ sheets: number } | null>(null);

  const sizes = input?.data ?? [];
  const total = sizes.length;
  const sheetPt = paper === "same" ? "same" : paperToPt(paper, customMm);
  const margin = mmToPt(marginMm);
  const gap = mmToPt(gapMm);

  const preview = useMemo(() => {
    if (!sheetPt || sizes.length === 0) return null;
    const sheet = nupSheetSize({ perSheet, sheet: sheetPt, orientation }, sizes[0]);
    const cells = nupCells(perSheet, sheet, order, margin, gap);
    return { sheet, cells };
  }, [sheetPt, sizes, perSheet, orientation, order, margin, gap]);

  const problem = nupProblem({ perSheet, sheet: sheetPt, orientation, order, first: sizes[0], marginMm, gapMm }, tg);
  // The blank-pages warning describes the output of these exact settings only.
  const settings = JSON.stringify([perSheet, paper, customMm, orientation, order, marginMm, gapMm, border]);
  const blankPages = undecodable.settings === settings ? undecodable.pages : [];

  const sheetsCount = Math.ceil(total / perSheet);
  const paperLabel = paper === "same" ? t("sameAsFirst") : paper === CUSTOM_PAPER ? mmSizeLabel(customMm, tg) : paper;
  const orientationWord = { auto: tg("wordAuto"), portrait: tg("wordPortrait"), landscape: tg("wordLandscape") }[orientation];
  const summary = t("summary", {
    perSheet,
    paper: paperLabel,
    orientation: orientationWord,
    order: order === "rows" ? t("rowsWord") : t("columnsWord"),
    margin: marginMm || 0,
    gap: gapMm || 0,
    count: sheetsCount,
  });
  const orientationLabel = { auto: t("orientationAuto"), portrait: tg("portrait"), landscape: tg("landscape") };

  const items = useMemo(() => {
    if (!preview || problem || !input) return [];
    return preview.cells.slice(0, Math.min(perSheet, total)).map((cell, i) => ({
      rect: fitInCell(cell, sizes[i]),
      page: i + 1,
    }));
  }, [preview, problem, input, perSheet, total, sizes]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input || busy || problem || !sheetPt) return;
    const job: NupJobSpec = { perSheet, sheet: sheetPt, orientation, order, margin, gap, border };
    setUndecodable({ settings: "", pages: [] });
    setMade(null);
    void run(
      () => worker.nupPdf(input.bytes, job),
      (out) => {
        setUndecodable({ settings, pages: out.undecodable });
        setMade({ sheets: out.sheets });
        downloadBlob(out.bytes, `${baseName(input.file)}_${perSheet}-up.pdf`);
      },
    );
  };

  const clear = () => { reset(); setUndecodable({ settings: "", pages: [] }); setMade(null); };

  return (
    <ToolShell
      tool="nUp"
      title={t("seoTitle")}
      description={t("seoDescription")}
      path="/n-up"
      heading={t("heading")}
      intro={t("intro")}
    >
      <ErrorAlert error={worker.initProblem} className="mt-6" />

      {!input && (
        <div className="mt-8">
          <DropZone onFile={(f) => { setUndecodable({ settings: "", pages: [] }); setMade(null); void pick(f); }} error={error} />
        </div>
      )}

      {input && (
        <form className={panelClass} onSubmit={submit}>
          <p className={fileMeta}>{tc("fileWithPagesParen", { name: input.file.name, count: total })}</p>

          <fieldset className="mt-4">
            <legend className="text-sm text-ink">{t("perSheet")}</legend>
            <div className="mt-1 flex flex-wrap gap-2">
              {PER_SHEET.map((n) => (
                <ToggleChip
                  key={n}
                  on={perSheet === n}
                  onClick={() => setPerSheet(n)}
                  className="!h-auto w-14 flex-col gap-1 !px-2 py-2 font-mono"
                >
                  <LayoutIcon n={n} />
                  {n}
                </ToggleChip>
              ))}
            </div>
          </fieldset>

          <div className="mt-4 flex flex-wrap gap-6">
            <div className="min-w-[14rem] flex-1 space-y-4">
              <PaperSizeFields paper={paper} onPaper={setPaper} customMm={customMm} onCustomMm={setCustomMm} allowSame />
              <label className="block text-sm text-ink">
                {tg("orientation")}
                <select value={orientation} onChange={(e) => setOrientation(e.target.value as Orientation)} className={inputClass}>
                  {ORIENTATIONS.map((o) => <option key={o} value={o}>{orientationLabel[o]}</option>)}
                </select>
              </label>
              <label className="block text-sm text-ink">
                {t("order")}
                <select value={order} onChange={(e) => setOrder(e.target.value as NupJobSpec["order"])} className={inputClass}>
                  <option value="rows">{t("rows")}</option>
                  <option value="columns">{t("columns")}</option>
                </select>
              </label>
              <div className="flex flex-wrap gap-3">
                <label className="block flex-1 text-sm text-ink">
                  {tg("margin")}
                  <input type="number" min={0} max={200} value={Number.isFinite(marginMm) ? marginMm : ""}
                    onChange={(e) => setMarginMm(e.target.value === "" ? NaN : Number(e.target.value))} className={inputClass} />
                </label>
                <label className="block flex-1 text-sm text-ink">
                  {t("gap")}
                  <input type="number" min={0} max={200} value={Number.isFinite(gapMm) ? gapMm : ""}
                    onChange={(e) => setGapMm(e.target.value === "" ? NaN : Number(e.target.value))} className={inputClass} />
                </label>
              </div>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input type="checkbox" checked={border} onChange={(e) => setBorder(e.target.checked)} />
                {t("border")}
              </label>
            </div>
            <div className="flex flex-col items-center gap-2">
              <p className={monoLabel}>{t("previewFirst")}</p>
              {preview && !problem ? (
                <SheetPreview
                  sheet={preview.sheet}
                  items={items}
                  cells={preview.cells}
                  bordered={border}
                  source={input.file}
                  label={t("firstSheetLabel", { n: Math.min(perSheet, total) })}
                  maxSide={280}
                />
              ) : (
                <p className="text-xs text-ink-2">{tg("fixSettings")}</p>
              )}
            </div>
          </div>

          <p className="mt-4 text-xs text-ink-2">
            {t("note")}
          </p>

          <LiveSummary text={summary} className="mt-4 text-sm text-ink-2" />

          {made && blankPages.length > 0 && (
            <div role="alert" className={`mt-4 flex gap-3 ${noticeClass}`}>
              <TriangleAlert aria-hidden="true" strokeWidth={1.5} className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{t("blankPages", { count: blankPages.length, list: blankPages.join(", ") })}</span>
            </div>
          )}

          <ErrorAlert error={problem} className="mt-4" />
          <ErrorAlert error={error} onDismiss={() => setError(null)} className="mt-4" />
          <div className="mt-6 flex flex-wrap gap-3">
            <button type="submit" disabled={busy || problem !== null} className={`flex-1 ${primaryButton}`}>
              {busy ? t("arranging") : t("submit")}
            </button>
            <button type="button" onClick={clear} className={secondaryButton}>{tc("chooseAnother")}</button>
          </div>
        </form>
      )}
    </ToolShell>
  );
}
