import { useCallback, useMemo, useState } from "react";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { downloadBlob } from "../lib/fileHelpers";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import RangeInput from "../components/planner/RangeInput";
import LiveSummary from "../components/stamp/LiveSummary";
import PaperSizeFields, { CUSTOM_PAPER, paperToPt, type PaperChoice } from "../components/geometry/PaperSizeFields";
import SheetPreview from "../components/geometry/SheetPreview";
import { mmToPt, type Orientation, type ResizeJobSpec } from "../lib/geometryJob";
import { resizeLayout } from "../lib/geometryLayout";
import { describePages } from "../lib/stampBuilders";
import ToolShell, { inputClass, panelClass, primaryButton, secondaryButton } from "./ToolShell";
import { baseName, usePdfInput } from "./usePdfInput";

const ORIENTATIONS: { id: Orientation; label: string }[] = [
  { id: "auto", label: "Auto (follow each page)" },
  { id: "portrait", label: "Portrait" },
  { id: "landscape", label: "Landscape" },
];

export default function ResizePdfPage() {
  const worker = usePdfWorker();
  const { pageSizes } = worker;
  const prepare = useCallback((bytes: Uint8Array) => pageSizes(bytes), [pageSizes]);
  const { input, error, setError, busy, pick, reset, run } = usePdfInput(worker, prepare);

  const [paper, setPaper] = useState<PaperChoice>("A4");
  const [customMm, setCustomMm] = useState<[number, number]>([210, 297]);
  const [orientation, setOrientation] = useState<Orientation>("auto");
  const [mode, setMode] = useState<"fit" | "extend">("fit");
  const [marginMm, setMarginMm] = useState(0);
  const [pages, setPages] = useState<number[] | null>(null);

  const sizes = input?.data ?? [];
  const total = sizes.length;
  const selected = useMemo(() => pages ?? Array.from({ length: total }, (_, i) => i + 1), [pages, total]);
  const size = paperToPt(paper === "same" ? "A4" : paper, customMm);
  const margin = mmToPt(marginMm);

  const problem =
    selected.length === 0 ? "Select at least one page."
    : !size ? "Custom size must be between 13 and 5080 mm on each side."
    : !(marginMm >= 0 && marginMm <= 200) ? "Margin must be between 0 and 200 mm."
    : null;

  const firstPage = selected[0];
  const firstSize = firstPage ? sizes[firstPage - 1] : undefined;
  const layout = useMemo(() => {
    if (!size || !firstSize || problem) return null;
    const l = resizeLayout(firstSize, { size, orientation, mode, margin });
    return l.rect[2] > 0 && l.rect[3] > 0 ? l : null;
  }, [size, firstSize, problem, orientation, mode, margin]);

  const paperLabel = paper === CUSTOM_PAPER ? `${customMm[0]} x ${customMm[1]} mm` : paper;
  const summary = `${paperLabel} · ${orientation} · ${mode === "fit" ? "Fit" : "Extend"} · margin ${marginMm || 0} mm · ${describePages(selected, total)}`;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input || busy || problem || !size) return;
    const job: ResizeJobSpec = {
      pages: selected.length === total ? "all" : selected,
      size,
      orientation,
      mode,
      margin,
    };
    void run(
      () => worker.resizePdf(input.bytes, job),
      (out) => downloadBlob(out, `${baseName(input.file)}_resized.pdf`),
    );
  };

  const clear = () => { reset(); setPages(null); };

  return (
    <ToolShell
      title="Resize PDF Pages | MantisPDF"
      description="Resize PDF pages to A4, Letter or a custom size, scaling the content to fit. Free, private, nothing is uploaded."
      path="/resize"
      heading="Resize pages"
      intro="Change the page size of a PDF and scale the content to fit. Everything stays on your device."
    >
      <ErrorAlert error={worker.initError ? `WASM engine failed to load: ${worker.initError}` : null} className="mt-4" />

      {!input && (
        <div className="mt-8">
          <DropZone onFile={(f) => { setPages(null); void pick(f); }} error={error} />
        </div>
      )}

      {input && (
        <form className={panelClass} onSubmit={submit}>
          <p className="text-sm font-medium text-gray-800 dark:text-[#ccc]">{input.file.name} ({total} pages)</p>

          <div className="mt-4 flex flex-wrap gap-6">
            <div className="min-w-[14rem] flex-1 space-y-4">
              <PaperSizeFields paper={paper} onPaper={setPaper} customMm={customMm} onCustomMm={setCustomMm} />
              <label className="block text-sm text-gray-700 dark:text-[#aaa]">
                Orientation
                <select value={orientation} onChange={(e) => setOrientation(e.target.value as Orientation)} className={inputClass}>
                  {ORIENTATIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
              </label>
              <fieldset>
                <legend className="text-sm text-gray-700 dark:text-[#aaa]">Mode</legend>
                <div className="mt-1 flex gap-4 text-sm text-gray-700 dark:text-[#aaa]">
                  <label className="flex items-center gap-2">
                    <input type="radio" name="mode" checked={mode === "fit"} onChange={() => setMode("fit")} /> Fit (scale up or down)
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="radio" name="mode" checked={mode === "extend"} onChange={() => setMode("extend")} /> Extend (never enlarge)
                  </label>
                </div>
              </fieldset>
              <label className="block text-sm text-gray-700 dark:text-[#aaa]">
                Margin (mm)
                <input type="number" min={0} max={200} step={1} value={Number.isFinite(marginMm) ? marginMm : ""}
                  onChange={(e) => setMarginMm(e.target.value === "" ? NaN : Number(e.target.value))}
                  className={`${inputClass} max-w-[8rem]`} />
              </label>
            </div>
            <div className="flex flex-col items-center gap-2">
              <p className="text-sm text-gray-700 dark:text-[#aaa]">Preview{firstPage ? ` (page ${firstPage})` : ""}</p>
              {layout ? (
                <SheetPreview
                  sheet={layout.sheet}
                  items={[{ rect: layout.rect, page: firstPage }]}
                  source={input.file}
                  label="One page placed on the target sheet"
                />
              ) : (
                <p className="text-xs text-gray-500 dark:text-[#888]">Fix the settings to see a preview.</p>
              )}
            </div>
          </div>

          <div className="mt-4">
            <RangeInput label="Pages to resize" total={total} selectedPages={selected} onPages={setPages} />
          </div>

          <LiveSummary text={summary} className="mt-4 text-sm text-gray-600 dark:text-[#888]" />

          <ErrorAlert error={problem} className="mt-4" />
          <ErrorAlert error={error} onDismiss={() => setError(null)} className="mt-4" />
          <div className="mt-6 flex gap-3">
            <button type="submit" disabled={busy || problem !== null} className={`flex-1 ${primaryButton}`}>
              {busy ? "Resizing…" : "Resize and download"}
            </button>
            <button type="button" onClick={clear} className={secondaryButton}>Choose another file</button>
          </div>
        </form>
      )}
    </ToolShell>
  );
}
