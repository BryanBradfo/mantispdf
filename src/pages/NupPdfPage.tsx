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
import ToolShell, { inputClass, panelClass, primaryButton, secondaryButton } from "./ToolShell";
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
      title={t("seoTitle")}
      description={t("seoDescription")}
      path="/n-up"
      heading={t("heading")}
      intro={t("intro")}
    >
      <ErrorAlert error={worker.initError ? tc("engineFailed", { error: worker.initError }) : null} className="mt-4" />

      {!input && (
        <div className="mt-8">
          <DropZone onFile={(f) => { setUndecodable({ settings: "", pages: [] }); setMade(null); void pick(f); }} error={error} />
        </div>
      )}

      {input && (
        <form className={panelClass} onSubmit={submit}>
          <p className="text-sm font-medium text-gray-800 dark:text-[#ccc]">{tc("fileWithPagesParen", { name: input.file.name, count: total })}</p>

          <fieldset className="mt-4">
            <legend className="text-sm text-gray-700 dark:text-[#aaa]">{t("perSheet")}</legend>
            <div className="mt-1 flex flex-wrap gap-2">
              {PER_SHEET.map((n) => (
                <button
                  key={n}
                  type="button"
                  aria-pressed={perSheet === n}
                  onClick={() => setPerSheet(n)}
                  className={`flex w-14 flex-col items-center gap-1 rounded-lg border px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mantis-500 ${
                    perSheet === n
                      ? "border-mantis-600 bg-mantis-100 text-mantis-800 dark:bg-[#1a2a1a] dark:text-mantis-300"
                      : "border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-[#333] dark:text-[#aaa] dark:hover:bg-[#1a1a1a]"
                  }`}
                >
                  <LayoutIcon n={n} />
                  {n}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="mt-4 flex flex-wrap gap-6">
            <div className="min-w-[14rem] flex-1 space-y-4">
              <PaperSizeFields paper={paper} onPaper={setPaper} customMm={customMm} onCustomMm={setCustomMm} allowSame />
              <label className="block text-sm text-gray-700 dark:text-[#aaa]">
                {tg("orientation")}
                <select value={orientation} onChange={(e) => setOrientation(e.target.value as Orientation)} className={inputClass}>
                  {ORIENTATIONS.map((o) => <option key={o} value={o}>{orientationLabel[o]}</option>)}
                </select>
              </label>
              <label className="block text-sm text-gray-700 dark:text-[#aaa]">
                {t("order")}
                <select value={order} onChange={(e) => setOrder(e.target.value as NupJobSpec["order"])} className={inputClass}>
                  <option value="rows">{t("rows")}</option>
                  <option value="columns">{t("columns")}</option>
                </select>
              </label>
              <div className="flex gap-3">
                <label className="block flex-1 text-sm text-gray-700 dark:text-[#aaa]">
                  {tg("margin")}
                  <input type="number" min={0} max={200} value={Number.isFinite(marginMm) ? marginMm : ""}
                    onChange={(e) => setMarginMm(e.target.value === "" ? NaN : Number(e.target.value))} className={inputClass} />
                </label>
                <label className="block flex-1 text-sm text-gray-700 dark:text-[#aaa]">
                  {t("gap")}
                  <input type="number" min={0} max={200} value={Number.isFinite(gapMm) ? gapMm : ""}
                    onChange={(e) => setGapMm(e.target.value === "" ? NaN : Number(e.target.value))} className={inputClass} />
                </label>
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-[#aaa]">
                <input type="checkbox" checked={border} onChange={(e) => setBorder(e.target.checked)} />
                {t("border")}
              </label>
            </div>
            <div className="flex flex-col items-center gap-2">
              <p className="text-sm text-gray-700 dark:text-[#aaa]">{t("previewFirst")}</p>
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
                <p className="text-xs text-gray-500 dark:text-[#888]">{tg("fixSettings")}</p>
              )}
            </div>
          </div>

          <p className="mt-4 text-xs text-gray-500 dark:text-[#888]">
            {t("note")}
          </p>

          <LiveSummary text={summary} className="mt-4 text-sm text-gray-600 dark:text-[#888]" />

          {made && blankPages.length > 0 && (
            <div role="alert" className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-[#2a2210] dark:text-amber-200">
              {t("blankPages", { count: blankPages.length, list: blankPages.join(", ") })}
            </div>
          )}

          <ErrorAlert error={problem} className="mt-4" />
          <ErrorAlert error={error} onDismiss={() => setError(null)} className="mt-4" />
          <div className="mt-6 flex gap-3">
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
