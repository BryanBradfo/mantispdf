import { useCallback, useMemo, useRef, useState } from "react";
import { useMergeState } from "../hooks/useMergeState";
import type { MergeFile } from "../hooks/useMergeState";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { downloadBlob, isPdfFile, readFileAsUint8Array } from "../lib/fileHelpers";
import { useDescribeError, useT, type UiError } from "../i18n";
import { downloadAsZip } from "../lib/downloadZip";
import { MAX_BATES, MAX_BATES_AFFIX, batesRanges, createBatesTokens, describeBatesRange } from "../lib/bates";
import {
  DEFAULT_MARGIN,
  anchorLabel,
  DEFAULT_STYLE,
  describeStyle,
  hexToRgb,
  type TextStyle,
} from "../lib/stampBuilders";
import type { Anchor, StampJobSpec } from "../lib/stampJob";
import type { PdfPart } from "../types/pdf";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import MergeFileList from "../components/merge/MergeFileList";
import PositionPicker from "../components/stamp/PositionPicker";
import LiveSummary from "../components/stamp/LiveSummary";
import TextStyleFields from "../components/stamp/TextStyleFields";
import ToolShell, { inputClass, panelClass, primaryButton, secondaryButton } from "./ToolShell";

let nextId = 0;
const baseOf = (f: File) => f.name.replace(/\.pdf$/i, "");

export default function BatesPage() {
  const t = useT("bates");
  const ts = useT("stamp");
  const tc = useT("common");
  const describe = useDescribeError();
  const worker = usePdfWorker();
  const [state, dispatch] = useMergeState();
  const tokens = useMemo(createBatesTokens, []);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiError | null>(null);

  const [anchor, setAnchor] = useState<Anchor>("bottom-right");
  const [prefix, setPrefix] = useState("");
  const [suffix, setSuffix] = useState("");
  const [start, setStart] = useState(1);
  const [digits, setDigits] = useState(6);
  const [style, setStyle] = useState<TextStyle>(DEFAULT_STYLE);
  const [margin, setMargin] = useState(DEFAULT_MARGIN);

  const files = state.files;
  const filesRef = useRef(files);
  filesRef.current = files;

  const handleFiles = useCallback(
    async (picked: File[]) => {
      if (worker.initError) return dispatch({ type: "upload-error", error: tc("engineFailedReload") });
      if (!worker.ready) return dispatch({ type: "upload-error", error: tc("engineLoading") });
      if (busy) return;
      const current = tokens.upload.begin();
      setAdding(true);
      try {
        const added: MergeFile[] = [];
        for (const file of picked) {
          if (!isPdfFile(file)) {
            return dispatch({ type: "upload-error", error: tc("fileProblem", { name: file.name, problem: tc("invalidPdf") }) });
          }
          try {
            const bytes = await readFileAsUint8Array(file);
            const numPages = await worker.countPages(bytes);
            if (!current()) return;
            added.push({ id: String(++nextId), file, bytes, numPages });
          } catch (err) {
            if (current()) {
              const d = describe(err);
              dispatch({ type: "upload-error", error: { ...d, message: tc("fileProblem", { name: file.name, problem: d.message }) } });
            }
            return;
          }
        }
        dispatch({ type: "files-added", files: added });
      } finally {
        if (current()) setAdding(false);
      }
    },
    [dispatch, worker, tokens, busy, tc, describe],
  );

  const ranges = useMemo(
    () => batesRanges(files.map((f) => f.numPages), start, digits, prefix, suffix),
    [files, start, digits, prefix, suffix],
  );
  const rangeText = describeBatesRange(ranges, t);

  const problem =
    files.length === 0 ? t("needFile")
    : !Number.isInteger(start) || start < 0 ? t("startRange")
    : start + files.reduce((n, f) => n + f.numPages, 0) > MAX_BATES ? t("tooLarge")
    : !Number.isInteger(digits) || digits < 1 || digits > 12 ? t("digitsRange")
    : !(style.size >= 6 && style.size <= 72) ? ts("sizeRange")
    : !(margin >= 0 && margin <= 300) ? ts("marginRange")
    : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || adding || problem) return;
    const current = tokens.run.begin();
    const list = filesRef.current;
    setBusy(true);
    setError(null);
    try {
      const parts: PdfPart[] = [];
      let next = start;
      for (const f of list) {
        const job: StampJobSpec = {
          pages: "all",
          texts: [{
            template: "{bates}",
            font: style.font,
            size: style.size,
            color: hexToRgb(style.color),
            opacity: style.opacity,
            anchor,
            marginX: margin,
            marginY: margin,
          }],
          images: [],
          numberStart: 1,
          bates: { prefix, suffix, start: next, digits },
        };
        const out = await worker.stampPdf(f.bytes, job);
        if (!current()) return;
        next += out.stampedPages;
        parts.push({ name: `${baseOf(f.file)}_bates.pdf`, bytes: out.bytes });
      }
      if (parts.length === 1) downloadBlob(parts[0].bytes, parts[0].name);
      else await downloadAsZip(parts, "bates", "bates");
    } catch (err) {
      if (current()) setError(describe(err));
    } finally {
      if (current()) setBusy(false);
    }
  };

  const clear = () => {
    tokens.invalidateAll();
    setAdding(false);
    dispatch({ type: "reset" });
    setBusy(false);
    setError(null);
  };

  const labelClass = "block text-sm text-gray-700 dark:text-[#aaa]";
  const num = (v: number) => (Number.isFinite(v) ? v : "");

  return (
    <ToolShell
      title={t("seoTitle")}
      description={t("seoDescription")}
      path="/bates"
      heading={t("heading")}
      intro={t("intro")}
    >
      <ErrorAlert error={worker.initError ? tc("engineFailed", { error: worker.initError }) : null} className="mt-4" />

      <div className={`mt-8 ${busy ? "pointer-events-none opacity-50" : ""}`} inert={busy}>
        <DropZone multiple onFiles={(f) => void handleFiles(f)} error={state.uploadError} />
      </div>

      {files.length > 0 && (
        <form className={panelClass} onSubmit={(e) => void submit(e)}>
          <p className="text-sm text-gray-600 dark:text-[#888]">
            {t("files", { count: files.length })}
          </p>
          <div className="mt-3">
            <MergeFileList
              files={files}
              onReorder={(from, to) => dispatch({ type: "reorder", fromIndex: from, toIndex: to })}
              onRemove={(id) => dispatch({ type: "remove-file", id })}
            />
          </div>

          <div className="mt-6 flex flex-wrap gap-6">
            <PositionPicker value={anchor} onChange={setAnchor} />
            <div className="grid min-w-[12rem] flex-1 grid-cols-2 gap-4">
              <label className={labelClass}>
                {t("prefix")}
                <input value={prefix} onChange={(e) => setPrefix(e.target.value)} maxLength={MAX_BATES_AFFIX} placeholder="ACME-" className={inputClass} />
              </label>
              <label className={labelClass}>
                {t("suffix")}
                <input value={suffix} onChange={(e) => setSuffix(e.target.value)} maxLength={MAX_BATES_AFFIX} className={inputClass} />
              </label>
              <label className={labelClass}>
                {t("startNumber")}
                <input
                  type="number" min={0} step={1} value={num(start)}
                  onChange={(e) => setStart(e.target.value === "" ? NaN : Number(e.target.value))}
                  className={inputClass}
                />
              </label>
              <label className={labelClass}>
                {t("digits")}
                <input
                  type="number" min={1} max={12} step={1} value={num(digits)}
                  onChange={(e) => setDigits(e.target.value === "" ? NaN : Number(e.target.value))}
                  className={inputClass}
                />
              </label>
            </div>
          </div>

          <div className="mt-4"><TextStyleFields value={style} onChange={setStyle} /></div>

          <label className={`mt-4 ${labelClass}`}>
            {ts("marginFromEdge")}
            <input
              type="number" min={0} max={300} value={num(margin)}
              onChange={(e) => setMargin(e.target.value === "" ? NaN : Number(e.target.value))}
              className={`${inputClass} max-w-[8rem]`}
            />
          </label>

          <LiveSummary
            text={`${anchorLabel(anchor, ts)} · ${describeStyle(style, ts)}${rangeText ? ` · ${rangeText}` : ""}`}
            className="mt-4 text-sm text-gray-600 dark:text-[#888]"
          />

          <ErrorAlert error={problem} className="mt-4" />
          <ErrorAlert error={error} onDismiss={() => setError(null)} className="mt-4" />
          <div className="mt-6 flex gap-3">
            <button type="submit" disabled={busy || adding || problem !== null} className={`flex-1 ${primaryButton}`}>
              {busy ? t("numbering") : files.length > 1 ? t("submitZip") : t("submit")}
            </button>
            <button type="button" onClick={clear} className={secondaryButton}>{tc("startOver")}</button>
          </div>
        </form>
      )}
    </ToolShell>
  );
}
