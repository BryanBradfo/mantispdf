import { useCallback, useMemo, useRef, useState } from "react";
import { useMergeState } from "../hooks/useMergeState";
import type { MergeFile } from "../hooks/useMergeState";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { downloadBlob, readFileAsUint8Array, validatePdfFile } from "../lib/fileHelpers";
import { downloadAsZip } from "../lib/downloadZip";
import { MAX_BATES, MAX_BATES_AFFIX, batesRanges, createBatesTokens, describeBatesRange } from "../lib/bates";
import {
  ANCHOR_LABELS,
  DEFAULT_MARGIN,
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
  const worker = usePdfWorker();
  const [state, dispatch] = useMergeState();
  const tokens = useMemo(createBatesTokens, []);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      if (worker.initError) return dispatch({ type: "upload-error", error: "PDF engine failed to load. Please reload the page." });
      if (!worker.ready) return dispatch({ type: "upload-error", error: "Engine is still loading, please wait a moment." });
      if (busy) return;
      const current = tokens.upload.begin();
      setAdding(true);
      try {
        const added: MergeFile[] = [];
        for (const file of picked) {
          const invalid = validatePdfFile(file);
          if (invalid) return dispatch({ type: "upload-error", error: `${file.name}: ${invalid}` });
          try {
            const bytes = await readFileAsUint8Array(file);
            const numPages = await worker.countPages(bytes);
            if (!current()) return;
            added.push({ id: String(++nextId), file, bytes, numPages });
          } catch (err) {
            if (current()) dispatch({ type: "upload-error", error: `${file.name}: ${err instanceof Error ? err.message : String(err)}` });
            return;
          }
        }
        dispatch({ type: "files-added", files: added });
      } finally {
        if (current()) setAdding(false);
      }
    },
    [dispatch, worker, tokens, busy],
  );

  const ranges = useMemo(
    () => batesRanges(files.map((f) => f.numPages), start, digits, prefix, suffix),
    [files, start, digits, prefix, suffix],
  );
  const rangeText = describeBatesRange(ranges);

  const problem =
    files.length === 0 ? "Add at least one PDF."
    : !Number.isInteger(start) || start < 0 ? "Start number must be a whole number, 0 or more."
    : start + files.reduce((n, f) => n + f.numPages, 0) > MAX_BATES ? "Start number plus total pages is too large."
    : !Number.isInteger(digits) || digits < 1 || digits > 12 ? "Digits must be between 1 and 12."
    : !(style.size >= 6 && style.size <= 72) ? "Size must be between 6 and 72 pt."
    : !(margin >= 0 && margin <= 300) ? "Margin must be between 0 and 300 pt."
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
      if (current()) setError(err instanceof Error ? err.message : String(err));
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
      title="Bates Numbering for PDF | MantisPDF"
      description="Add Bates numbers across one or many PDFs, continuing the count from file to file. Free, private, nothing is uploaded."
      path="/bates"
      heading="Bates numbering"
      intro="Stamp a running identifier on every page, continuing across documents. Everything stays on your device."
    >
      <ErrorAlert error={worker.initError ? `WASM engine failed to load: ${worker.initError}` : null} className="mt-4" />

      <div className={`mt-8 ${busy ? "pointer-events-none opacity-50" : ""}`} inert={busy}>
        <DropZone multiple onFiles={(f) => void handleFiles(f)} error={state.uploadError} />
      </div>

      {files.length > 0 && (
        <form className={panelClass} onSubmit={(e) => void submit(e)}>
          <p className="text-sm text-gray-600 dark:text-[#888]">
            {files.length} file{files.length !== 1 ? "s" : ""}. Drag to set the numbering order.
          </p>
          <div className="mt-3">
            <MergeFileList
              files={files}
              onReorder={(from, to) => dispatch({ type: "reorder", fromIndex: from, toIndex: to })}
              onRemove={(id) => dispatch({ type: "remove-file", id })}
            />
          </div>

          <div className="mt-6 flex flex-wrap gap-6">
            <PositionPicker value={anchor} onChange={setAnchor} label="Position" />
            <div className="grid min-w-[12rem] flex-1 grid-cols-2 gap-4">
              <label className={labelClass}>
                Prefix
                <input value={prefix} onChange={(e) => setPrefix(e.target.value)} maxLength={MAX_BATES_AFFIX} placeholder="ACME-" className={inputClass} />
              </label>
              <label className={labelClass}>
                Suffix
                <input value={suffix} onChange={(e) => setSuffix(e.target.value)} maxLength={MAX_BATES_AFFIX} className={inputClass} />
              </label>
              <label className={labelClass}>
                Start number
                <input
                  type="number" min={0} step={1} value={num(start)}
                  onChange={(e) => setStart(e.target.value === "" ? NaN : Number(e.target.value))}
                  className={inputClass}
                />
              </label>
              <label className={labelClass}>
                Digits
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
            Margin from the edge (pt)
            <input
              type="number" min={0} max={300} value={num(margin)}
              onChange={(e) => setMargin(e.target.value === "" ? NaN : Number(e.target.value))}
              className={`${inputClass} max-w-[8rem]`}
            />
          </label>

          <LiveSummary
            text={`${ANCHOR_LABELS[anchor]} · ${describeStyle(style)}${rangeText ? ` · ${rangeText}` : ""}`}
            className="mt-4 text-sm text-gray-600 dark:text-[#888]"
          />

          <ErrorAlert error={problem} className="mt-4" />
          <ErrorAlert error={error} onDismiss={() => setError(null)} className="mt-4" />
          <div className="mt-6 flex gap-3">
            <button type="submit" disabled={busy || adding || problem !== null} className={`flex-1 ${primaryButton}`}>
              {busy ? "Numbering…" : files.length > 1 ? "Add Bates numbers and download ZIP" : "Add Bates numbers and download"}
            </button>
            <button type="button" onClick={clear} className={secondaryButton}>Start over</button>
          </div>
        </form>
      )}
    </ToolShell>
  );
}
