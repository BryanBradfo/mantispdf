import { PAPER_SIZES, mmToPt, ptToMm, type PaperName } from "../../lib/geometryJob";
import { inputClass } from "../../pages/ToolShell";

export const CUSTOM_PAPER = "custom";
export type PaperChoice = PaperName | typeof CUSTOM_PAPER | "same";

interface Props {
  paper: PaperChoice;
  onPaper: (p: PaperChoice) => void;
  /** Custom size in mm [width, height]. */
  customMm: [number, number];
  onCustomMm: (v: [number, number]) => void;
  allowSame?: boolean;
  /** Adds a "Fit to image" choice; `fit` says it is selected, `onFit` toggles it. */
  fit?: boolean;
  onFit?: (fit: boolean) => void;
}

/** Paper size select plus custom width/height in mm. */
export default function PaperSizeFields({ paper, onPaper, customMm, onCustomMm, allowSame = false, fit = false, onFit }: Props) {
  const num = (v: string) => (v === "" ? NaN : Number(v));
  const show = (v: number) => (Number.isFinite(v) ? v : "");
  return (
    <div>
      <label className="block text-sm text-gray-700 dark:text-[#aaa]">
        Sheet size
        <select
          value={fit ? "fit" : paper}
          onChange={(e) => {
            const v = e.target.value;
            onFit?.(v === "fit");
            if (v !== "fit") onPaper(v as PaperChoice);
          }}
          className={inputClass}>
          {allowSame && <option value="same">Same as first page</option>}
          {onFit && <option value="fit">Fit to image</option>}
          {(Object.keys(PAPER_SIZES) as PaperName[]).map((name) => (
            <option key={name} value={name}>
              {name} ({Math.round(ptToMm(PAPER_SIZES[name][0]))} x {Math.round(ptToMm(PAPER_SIZES[name][1]))} mm)
            </option>
          ))}
          <option value={CUSTOM_PAPER}>Custom…</option>
        </select>
      </label>
      {!fit && paper === CUSTOM_PAPER && (
        <div className="mt-2 flex gap-3">
          <label className="block flex-1 text-sm text-gray-700 dark:text-[#aaa]">
            Width (mm)
            <input type="number" min={13} max={5080} value={show(customMm[0])}
              onChange={(e) => onCustomMm([num(e.target.value), customMm[1]])} className={inputClass} />
          </label>
          <label className="block flex-1 text-sm text-gray-700 dark:text-[#aaa]">
            Height (mm)
            <input type="number" min={13} max={5080} value={show(customMm[1])}
              onChange={(e) => onCustomMm([customMm[0], num(e.target.value)])} className={inputClass} />
          </label>
        </div>
      )}
    </div>
  );
}

const MIN_PT = 36;
const MAX_PT = 14400;

/** Portrait [w, h] in points for a non-"same" choice, or null if the custom size is invalid. */
export function paperToPt(paper: Exclude<PaperChoice, "same">, customMm: [number, number]): [number, number] | null {
  if (paper !== CUSTOM_PAPER) return [PAPER_SIZES[paper][0], PAPER_SIZES[paper][1]];
  const [w, h] = [mmToPt(customMm[0]), mmToPt(customMm[1])];
  return w >= MIN_PT && w <= MAX_PT && h >= MIN_PT && h <= MAX_PT ? [w, h] : null;
}
