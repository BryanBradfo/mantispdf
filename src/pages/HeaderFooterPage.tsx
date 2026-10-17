import { useCallback, useState } from "react";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { downloadBlob } from "../lib/fileHelpers";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import RangeInput from "../components/planner/RangeInput";
import TextStyleFields from "../components/stamp/TextStyleFields";
import {
  DEFAULT_MARGIN,
  DEFAULT_STYLE,
  HEADER_FOOTER_SLOTS,
  buildHeaderFooterJob,
  describePages,
  describeStyle,
  todayIso,
  type HeaderFooterSlots,
  type TextStyle,
} from "../lib/stampBuilders";
import ToolShell, { inputClass, panelClass, primaryButton, secondaryButton } from "./ToolShell";
import { baseName, usePdfInput } from "./usePdfInput";

const INITIAL_SLOTS: HeaderFooterSlots = {
  "top-left": "", "top-center": "", "top-right": "",
  "bottom-left": "", "bottom-center": "Page {n} of {total}", "bottom-right": "",
};

export default function HeaderFooterPage() {
  const worker = usePdfWorker();
  const { countPages } = worker;
  const prepare = useCallback((bytes: Uint8Array) => countPages(bytes), [countPages]);
  const { input, error, setError, busy, pick, reset, run } = usePdfInput(worker, prepare);

  const [slots, setSlots] = useState<HeaderFooterSlots>(INITIAL_SLOTS);
  const [style, setStyle] = useState<TextStyle>(DEFAULT_STYLE);
  const [margin, setMargin] = useState(DEFAULT_MARGIN);
  const [pages, setPages] = useState<number[] | null>(null);

  const total = input?.data ?? 0;
  const selected = pages ?? Array.from({ length: total }, (_, i) => i + 1);
  const filled = HEADER_FOOTER_SLOTS.filter((s) => slots[s.anchor].trim() !== "");

  const problem =
    filled.length === 0 ? "Fill in at least one header or footer field."
    : selected.length === 0 ? "Select at least one page."
    : !(style.size >= 6 && style.size <= 72) ? "Size must be between 6 and 72 pt."
    : !(margin >= 0 && margin <= 300) ? "Margin must be between 0 and 300 pt."
    : null;

  const summary = `${filled.length} text${filled.length === 1 ? "" : "s"} (${filled.map((s) => s.label.toLowerCase()).join(", ") || "none"}) · ${describePages(selected, total)} · ${describeStyle(style)}`;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input || busy || problem) return;
    const job = buildHeaderFooterJob(
      { slots, style, margin },
      { total, pages: selected, filename: baseName(input.file), date: todayIso() },
    );
    if (!job) return;
    void run(
      () => worker.stampPdf(input.bytes, job),
      (out) => downloadBlob(out.bytes, `${baseName(input.file)}_header-footer.pdf`),
    );
  };

  const clear = () => { reset(); setPages(null); };

  return (
    <ToolShell
      title="Add Header and Footer to PDF | MantisPDF"
      description="Add a header and footer to every page of a PDF, with page numbers, date and file name. Free, private, nothing is uploaded."
      path="/header-footer"
      heading="Header and footer"
      intro="Add text at the top and bottom of your pages. Everything stays on your device."
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

          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {HEADER_FOOTER_SLOTS.map((s) => (
              <label key={s.anchor} className="block text-sm text-gray-700 dark:text-[#aaa]">
                {s.label}
                <input
                  value={slots[s.anchor]}
                  onChange={(e) => setSlots({ ...slots, [s.anchor]: e.target.value })}
                  className={inputClass}
                />
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-gray-500 dark:text-[#555]">
            Tokens: {"{n}"} page number, {"{total}"} page count, {"{date}"} today (yyyy-mm-dd), {"{filename}"} file name without .pdf.
          </p>

          <div className="mt-4">
            <RangeInput label="Pages" total={total} selectedPages={selected} onPages={setPages} />
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
              {busy ? "Stamping…" : "Add and download"}
            </button>
            <button type="button" onClick={clear} className={secondaryButton}>Choose another file</button>
          </div>
        </form>
      )}
    </ToolShell>
  );
}
