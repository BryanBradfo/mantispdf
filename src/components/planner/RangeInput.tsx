import { useEffect, useId, useState } from "react";
import { formatPageRanges, parsePageRanges } from "../../lib/pagePlan";
import { useT } from "../../i18n";
import { inputClass } from "../../styles/ui";

interface Props {
  label: string;
  total: number;
  selectedPages: readonly number[];
  onPages: (pages: number[]) => void;
}

export default function RangeInput({ label, total, selectedPages, onPages }: Props) {
  const t = useT("pages");
  const id = useId();
  const canonical = formatPageRanges(selectedPages);
  const [text, setText] = useState(canonical);
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!focused) {
      setText(canonical);
      setError(null);
    }
  }, [canonical, focused]);

  function handleChange(value: string) {
    setText(value);
    const parsed = parsePageRanges(value, total, t);
    if (parsed.ok) {
      setError(null);
      onPages(parsed.pages);
    } else {
      setError(parsed.error);
    }
  }

  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-ink">{label}</label>
      <input
        id={id}
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={t("rangePlaceholder")}
        aria-invalid={error !== null}
        aria-describedby={`${id}-help`}
        className={`${inputClass} max-w-sm ${error ? "!border-danger" : ""}`}
      />
      <p id={`${id}-help`} role={error ? "alert" : undefined} className={`mt-1.5 text-xs ${error ? "text-danger" : "text-ink-2"}`}>
        {error ?? t("rangeHelp")}
      </p>
    </div>
  );
}
