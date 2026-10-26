import { useId } from "react";
import type { TextStyle } from "../../lib/stampBuilders";
import type { StdFont } from "../../lib/stampJob";
import { inputClass } from "../../pages/ToolShell";
import { formatNumber, useLocale, useT } from "../../i18n";

const FONTS: { value: StdFont; label: string }[] = [
  { value: "Helvetica", label: "Helvetica" },
  { value: "Helvetica-Bold", label: "Helvetica Bold" },
  { value: "Times-Roman", label: "Times Roman" },
  { value: "Courier", label: "Courier" },
];

interface Props {
  value: TextStyle;
  onChange: (style: TextStyle) => void;
}

export default function TextStyleFields({ value, onChange }: Props) {
  const t = useT("stamp");
  const locale = useLocale();
  const id = useId();
  const labelClass = "block text-sm text-gray-700 dark:text-[#aaa]";
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      <label className={labelClass}>
        {t("font")}
        <select
          value={value.font}
          onChange={(e) => onChange({ ...value, font: e.target.value as StdFont })}
          className={inputClass}
        >
          {FONTS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
      </label>
      <label className={labelClass}>
        {t("size")}
        <input
          type="number"
          min={6}
          max={72}
          step={1}
          value={Number.isFinite(value.size) ? value.size : ""}
          onChange={(e) => onChange({ ...value, size: e.target.value === "" ? NaN : Number(e.target.value) })}
          onBlur={() => onChange({ ...value, size: Number.isFinite(value.size) ? Math.min(72, Math.max(6, Math.round(value.size))) : 11 })}
          className={inputClass}
        />
      </label>
      <label className={labelClass}>
        {t("colour")}
        <input
          type="color"
          value={value.color}
          onChange={(e) => onChange({ ...value, color: e.target.value })}
          className={`${inputClass} h-10 cursor-pointer p-1`}
        />
      </label>
      <div className={labelClass}>
        <label htmlFor={`${id}-op`}>{t("opacity", { percent: formatNumber(Math.round(value.opacity * 100) / 100, locale, { style: "percent" }) })}</label>
        <input
          id={`${id}-op`}
          type="range"
          min={0.1}
          max={1}
          step={0.05}
          value={value.opacity}
          onChange={(e) => onChange({ ...value, opacity: Number(e.target.value) })}
          className="mt-3 w-full accent-mantis-600"
        />
      </div>
    </div>
  );
}
