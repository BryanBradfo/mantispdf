import { useCallback, useState } from "react";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { downloadBlob } from "../lib/fileHelpers";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import RangeInput from "../components/planner/RangeInput";
import LiveSummary from "../components/stamp/LiveSummary";
import TextStyleFields from "../components/stamp/TextStyleFields";
import {
  DEFAULT_MARGIN,
  DEFAULT_STYLE,
  HEADER_FOOTER_SLOTS,
  buildHeaderFooterJob,
  describePages,
  describeStyle,
  previewHeaderFooter,
  slotLabel,
  stampDate,
  type HeaderFooterSlots,
  type TextStyle,
} from "../lib/stampBuilders";
import ToolShell, { inputClass, panelClass, primaryButton, secondaryButton } from "./ToolShell";
import { baseName, usePdfInput } from "./usePdfInput";
import { useLocale, useT } from "../i18n";

/** Empty slots; the footer center gets "Page {n} of {total}" in the UI language. */
const EMPTY_SLOTS: HeaderFooterSlots = {
  "top-left": "", "top-center": "", "top-right": "",
  "bottom-left": "", "bottom-center": "", "bottom-right": "",
};

export default function HeaderFooterPage() {
  const t = useT("headerFooter");
  const ts = useT("stamp");
  const tp = useT("pages");
  const tg = useT("geometry");
  const tc = useT("common");
  const locale = useLocale();
  const worker = usePdfWorker();
  const { countPages } = worker;
  const prepare = useCallback((bytes: Uint8Array) => countPages(bytes), [countPages]);
  const { input, error, setError, busy, pick, reset, run } = usePdfInput(worker, prepare);

  const [slots, setSlots] = useState<HeaderFooterSlots>(() => ({
    ...EMPTY_SLOTS,
    "bottom-center": ts("templatePageOf", { n: "{n}", total: "{total}" }),
  }));
  const [style, setStyle] = useState<TextStyle>(DEFAULT_STYLE);
  const [margin, setMargin] = useState(DEFAULT_MARGIN);
  const [numberStart, setNumberStart] = useState(1);
  const [pages, setPages] = useState<number[] | null>(null);

  const total = input?.data ?? 0;
  const selected = pages ?? Array.from({ length: total }, (_, i) => i + 1);
  const filled = HEADER_FOOTER_SLOTS.filter((s) => slots[s.anchor].trim() !== "");

  const problem =
    filled.length === 0 ? t("needText")
    : selected.length === 0 ? tg("selectAtLeastOne")
    : !Number.isInteger(numberStart) || numberStart < 0 ? ts("firstNumberRange")
    : !(style.size >= 6 && style.size <= 72) ? ts("sizeRange")
    : !(margin >= 0 && margin <= 300) ? ts("marginRange")
    : null;

  const ctx = { total, pages: selected, filename: input ? baseName(input.file) : "", date: stampDate(locale) };
  const preview = previewHeaderFooter(slots, Number.isFinite(numberStart) ? numberStart : 1, ctx, ts);
  const firstPage = selected.length > 0 ? selected.reduce((a, b) => Math.min(a, b)) : null;
  const summary = t("summary", {
    count: filled.length,
    slots: filled.map((s) => slotLabel(s.anchor, ts).toLocaleLowerCase(locale)).join(", ") || t("none"),
    pages: describePages(selected, total, tp),
    style: describeStyle(style, ts),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input || busy || problem) return;
    const job = buildHeaderFooterJob({ slots, style, margin, numberStart }, ctx);
    if (!job) return;
    void run(
      () => worker.stampPdf(input.bytes, job),
      (out) => downloadBlob(out.bytes, `${baseName(input.file)}_header-footer.pdf`),
    );
  };

  const clear = () => { reset(); setPages(null); };

  return (
    <ToolShell
      title={t("seoTitle")}
      description={t("seoDescription")}
      path="/header-footer"
      heading={t("heading")}
      intro={t("intro")}
    >
      <ErrorAlert error={worker.initError ? tc("engineFailed", { error: worker.initError }) : null} className="mt-4" />

      {!input && (
        <div className="mt-8">
          <DropZone onFile={(f) => { setPages(null); void pick(f); }} error={error} />
        </div>
      )}

      {input && (
        <form className={panelClass} onSubmit={submit}>
          <p className="text-sm font-medium text-gray-800 dark:text-[#ccc]">{tc("fileWithPagesParen", { name: input.file.name, count: total })}</p>

          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {HEADER_FOOTER_SLOTS.map((s) => (
              <label key={s.anchor} className="block text-sm text-gray-700 dark:text-[#aaa]">
                {slotLabel(s.anchor, ts)}
                <input
                  value={slots[s.anchor]}
                  onChange={(e) => setSlots({ ...slots, [s.anchor]: e.target.value })}
                  className={inputClass}
                />
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-gray-500 dark:text-[#555]">
            {t("tokens", { n: "{n}", total: "{total}", date: "{date}", filename: "{filename}" })}
          </p>

          <div className="mt-4 flex flex-wrap items-start gap-4">
            <div className="min-w-[12rem] flex-1">
              <RangeInput label={t("pages")} total={total} selectedPages={selected} onPages={setPages} />
            </div>
            <label className="block text-sm text-gray-700 dark:text-[#aaa]">
              {ts("firstNumber")}
              <input
                type="number"
                min={0}
                step={1}
                value={Number.isFinite(numberStart) ? numberStart : ""}
                onChange={(e) => setNumberStart(e.target.value === "" ? NaN : Number(e.target.value))}
                className={`${inputClass} max-w-[8rem]`}
              />
            </label>
          </div>

          {firstPage !== null && preview.length > 0 && (
            <div className="mt-4 rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-700 dark:bg-[#141414] dark:text-[#aaa]" data-testid="hf-preview">
              <p className="font-medium">{t("onPage", { page: firstPage })}</p>
              <ul className="mt-1 space-y-0.5">
                {preview.map((p) => (
                  <li key={p.label}>
                    {t("slotPreview", { label: p.label })}
                    <span className="font-mono">{p.text === "" ? t("empty") : p.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-4"><TextStyleFields value={style} onChange={setStyle} /></div>

          <label className="mt-4 block text-sm text-gray-700 dark:text-[#aaa]">
            {ts("marginFromEdge")}
            <input
              type="number"
              min={0}
              max={300}
              value={Number.isFinite(margin) ? margin : ""}
              onChange={(e) => setMargin(e.target.value === "" ? NaN : Number(e.target.value))}
              className={`${inputClass} max-w-[8rem]`}
            />
          </label>

          <LiveSummary text={summary} className="mt-4 text-sm text-gray-600 dark:text-[#888]" />

          <ErrorAlert error={problem} className="mt-4" />
          <ErrorAlert error={error} onDismiss={() => setError(null)} className="mt-4" />
          <div className="mt-6 flex gap-3">
            <button type="submit" disabled={busy || problem !== null} className={`flex-1 ${primaryButton}`}>
              {busy ? t("stamping") : t("submit")}
            </button>
            <button type="button" onClick={clear} className={secondaryButton}>{tc("chooseAnother")}</button>
          </div>
        </form>
      )}
    </ToolShell>
  );
}
