import { useCallback, useState } from "react";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { downloadBlob } from "../lib/fileHelpers";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import RangeInput from "../components/planner/RangeInput";
import PositionPicker from "../components/stamp/PositionPicker";
import LiveSummary from "../components/stamp/LiveSummary";
import TextStyleFields from "../components/stamp/TextStyleFields";
import {
  DEFAULT_MARGIN,
  DEFAULT_STYLE,
  anchorLabel,
  buildPageNumberJob,
  describePages,
  describeStyle,
  pageNumberPresets,
  pageNumberRange,
  previewStampText,
  stampDate,
  type TextStyle,
} from "../lib/stampBuilders";
import type { Anchor } from "../lib/stampJob";
import ToolShell, { inputClass, panelClass, primaryButton, secondaryButton } from "./ToolShell";
import { baseName, usePdfInput } from "./usePdfInput";
import { useLocale, useT } from "../i18n";

const CUSTOM = "custom";

export default function PageNumbersPage() {
  const t = useT("pageNumbers");
  const locale = useLocale();
  const ts = useT("stamp");
  const tp = useT("pages");
  const tg = useT("geometry");
  const tc = useT("common");
  const presets = pageNumberPresets(ts);
  const worker = usePdfWorker();
  const { countPages } = worker;
  const prepare = useCallback((bytes: Uint8Array) => countPages(bytes), [countPages]);
  const { input, error, setError, busy, pick, reset, run } = usePdfInput(worker, prepare);

  const [anchor, setAnchor] = useState<Anchor>("bottom-center");
  const [preset, setPreset] = useState<string>("n");
  const [custom, setCustom] = useState(() => ts("templatePageOf", { n: "{n}", total: "{total}" }));
  const [numberStart, setNumberStart] = useState(1);
  const [style, setStyle] = useState<TextStyle>(DEFAULT_STYLE);
  const [margin, setMargin] = useState(DEFAULT_MARGIN);
  const [pages, setPages] = useState<number[] | null>(null);

  const total = input?.data ?? 0;
  const selected = pages ?? Array.from({ length: total }, (_, i) => i + 1);
  const template = preset === CUSTOM ? custom : (presets.find((p) => p.id === preset)?.template ?? "{n}");

  const problem =
    selected.length === 0 ? tg("selectAtLeastOne")
    : template.trim() === "" ? t("needFormat")
    : !Number.isInteger(numberStart) || numberStart < 0 ? ts("firstNumberRange")
    : !(style.size >= 6 && style.size <= 72) ? ts("sizeRange")
    : !(margin >= 0 && margin <= 300) ? ts("marginRange")
    : null;

  const range = pageNumberRange(Number.isFinite(numberStart) ? numberStart : 1, selected);
  const firstShown = previewStampText(template, {
    n: range.first,
    total: range.last,
    date: stampDate(locale),
    filename: input ? baseName(input.file) : "",
  });
  const summary = `${anchorLabel(anchor, ts)} · ${describePages(selected, total, tp)} · ${describeStyle(style, ts)} · "${firstShown}"`;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input || busy || problem) return;
    const job = buildPageNumberJob(
      { anchor, template, numberStart, style, margin },
      { total, pages: selected, filename: baseName(input.file), date: stampDate(locale) },
    );
    void run(
      () => worker.stampPdf(input.bytes, job),
      (out) => downloadBlob(out.bytes, `${baseName(input.file)}_numbered.pdf`),
    );
  };

  const clear = () => { reset(); setPages(null); };

  return (
    <ToolShell
      title={t("seoTitle")}
      description={t("seoDescription")}
      path="/page-numbers"
      heading={t("heading")}
      intro={t("intro")}
    >
      <ErrorAlert error={worker.initProblem} className="mt-4" />

      {!input && (
        <div className="mt-8">
          <DropZone onFile={(f) => { setPages(null); void pick(f); }} error={error} />
        </div>
      )}

      {input && (
        <form className={panelClass} onSubmit={submit}>
          <p className="text-sm font-medium text-gray-800 dark:text-[#ccc]">{tc("fileWithPagesParen", { name: input.file.name, count: total })}</p>

          <div className="mt-4 flex flex-wrap gap-6">
            <PositionPicker value={anchor} onChange={setAnchor} layout="six" />
            <div className="min-w-[12rem] flex-1 space-y-4">
              <label className="block text-sm text-gray-700 dark:text-[#aaa]">
                {t("format")}
                <select value={preset} onChange={(e) => setPreset(e.target.value)} className={inputClass}>
                  {presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  <option value={CUSTOM}>{t("custom")}</option>
                </select>
              </label>
              {preset === CUSTOM && (
                <label className="block text-sm text-gray-700 dark:text-[#aaa]">
                  {t("customText", { n: "{n}", total: "{total}", date: "{date}", filename: "{filename}" })}
                  <input value={custom} onChange={(e) => setCustom(e.target.value)} className={inputClass} />
                </label>
              )}
              <label className="block text-sm text-gray-700 dark:text-[#aaa]">
                {ts("firstNumber")}
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
            <RangeInput label={t("rangeLabel")} total={total} selectedPages={selected} onPages={setPages} />
          </div>

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
              {busy ? t("numbering") : t("submit")}
            </button>
            <button type="button" onClick={clear} className={secondaryButton}>{tc("chooseAnother")}</button>
          </div>
        </form>
      )}
    </ToolShell>
  );
}
