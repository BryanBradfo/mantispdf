import { useCallback, useState } from "react";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { downloadBlob } from "../lib/fileHelpers";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import RangeInput from "../components/planner/RangeInput";
import PositionPicker from "../components/stamp/PositionPicker";
import TextStyleFields from "../components/stamp/TextStyleFields";
import {
  ANCHOR_LABELS,
  DEFAULT_MARGIN,
  DEFAULT_STYLE,
  PAGE_NUMBER_PRESETS,
  buildPageNumberJob,
  describePages,
  describeStyle,
  todayIso,
  type TextStyle,
} from "../lib/stampBuilders";
import type { Anchor } from "../lib/stampJob";
import ToolShell, { inputClass, panelClass, primaryButton, secondaryButton } from "./ToolShell";
import { baseName, usePdfInput } from "./usePdfInput";

const CUSTOM = "custom";

export default function PageNumbersPage() {
  const worker = usePdfWorker();
  const { countPages } = worker;
  const prepare = useCallback((bytes: Uint8Array) => countPages(bytes), [countPages]);
  const { input, error, setError, busy, pick, reset, run } = usePdfInput(worker, prepare);

  const [anchor, setAnchor] = useState<Anchor>("bottom-center");
  const [preset, setPreset] = useState<string>("n");
  const [custom, setCustom] = useState("Page {n} of {total}");
  const [numberStart, setNumberStart] = useState(1);
  const [style, setStyle] = useState<TextStyle>(DEFAULT_STYLE);
  const [margin, setMargin] = useState(DEFAULT_MARGIN);
  const [pages, setPages] = useState<number[] | null>(null);

  const total = input?.data ?? 0;
  const selected = pages ?? Array.from({ length: total }, (_, i) => i + 1);
  const template = preset === CUSTOM ? custom : (PAGE_NUMBER_PRESETS.find((p) => p.id === preset)?.template ?? "{n}");

  const problem =
    selected.length === 0 ? "Select at least one page."
    : template.trim() === "" ? "Enter a format for the page number."
    : !Number.isInteger(numberStart) || numberStart < 0 ? "First number must be a whole number, 0 or more."
    : !(style.size >= 6 && style.size <= 72) ? "Size must be between 6 and 72 pt."
    : !(margin >= 0 && margin <= 300) ? "Margin must be between 0 and 300 pt."
    : null;

  const firstShown = template.replace(/\{n\}/g, String(numberStart)).replace(/\{total\}/g, String(selected.length ? numberStart + selected.length - 1 : numberStart));
  const summary = `${ANCHOR_LABELS[anchor]} · ${describePages(selected, total)} · ${describeStyle(style)} · "${firstShown}"`;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input || busy || problem) return;
    const job = buildPageNumberJob(
      { anchor, template, numberStart, style, margin },
      { total, pages: selected, filename: baseName(input.file), date: todayIso() },
    );
    void run(
      () => worker.stampPdf(input.bytes, job),
      (out) => downloadBlob(out.bytes, `${baseName(input.file)}_numbered.pdf`),
    );
  };

  const clear = () => { reset(); setPages(null); };

  return (
    <ToolShell
      title="Add Page Numbers to PDF | MantisPDF"
      description="Add page numbers to a PDF: choose position, format and font. Free, private, nothing is uploaded."
      path="/page-numbers"
      heading="Add page numbers"
      intro="Number the pages of a PDF, in the corner you choose. Everything stays on your device."
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
            <PositionPicker value={anchor} onChange={setAnchor} layout="six" label="Position" />
            <div className="min-w-[12rem] flex-1 space-y-4">
              <label className="block text-sm text-gray-700 dark:text-[#aaa]">
                Format
                <select value={preset} onChange={(e) => setPreset(e.target.value)} className={inputClass}>
                  {PAGE_NUMBER_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  <option value={CUSTOM}>Custom…</option>
                </select>
              </label>
              {preset === CUSTOM && (
                <label className="block text-sm text-gray-700 dark:text-[#aaa]">
                  Custom text (use {"{n}"}, {"{total}"}, {"{date}"}, {"{filename}"})
                  <input value={custom} onChange={(e) => setCustom(e.target.value)} className={inputClass} />
                </label>
              )}
              <label className="block text-sm text-gray-700 dark:text-[#aaa]">
                First number
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={Number.isFinite(numberStart) ? numberStart : ""}
                  onChange={(e) => setNumberStart(e.target.value === "" ? NaN : Number(e.target.value))}
                  className={inputClass}
                />
              </label>
            </div>
          </div>

          <div className="mt-4">
            <RangeInput label="Pages to number" total={total} selectedPages={selected} onPages={setPages} />
          </div>

          <div className="mt-4"><TextStyleFields value={style} onChange={setStyle} /></div>

          <label className="mt-4 block text-sm text-gray-700 dark:text-[#aaa]">
            Margin from the edge (pt)
            <input
              type="number"
              min={0}
              max={300}
              value={Number.isFinite(margin) ? margin : ""}
              onChange={(e) => setMargin(e.target.value === "" ? NaN : Number(e.target.value))}
              className={`${inputClass} max-w-[8rem]`}
            />
          </label>

          <p className="mt-4 text-sm text-gray-600 dark:text-[#888]" aria-live="polite">{summary}</p>

          <ErrorAlert error={problem} className="mt-4" />
          <ErrorAlert error={error} onDismiss={() => setError(null)} className="mt-4" />
          <div className="mt-6 flex gap-3">
            <button type="submit" disabled={busy || problem !== null} className={`flex-1 ${primaryButton}`}>
              {busy ? "Numbering…" : "Add numbers and download"}
            </button>
            <button type="button" onClick={clear} className={secondaryButton}>Choose another file</button>
          </div>
        </form>
      )}
    </ToolShell>
  );
}
