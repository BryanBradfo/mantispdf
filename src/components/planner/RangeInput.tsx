import { useEffect, useId, useState } from "react";
import { formatPageRanges, parsePageRanges } from "../../lib/pagePlan";

interface Props {
  label: string;
  total: number;
  selectedPages: readonly number[];
  onPages: (pages: number[]) => void;
}

export default function RangeInput({ label, total, selectedPages, onPages }: Props) {
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
    const parsed = parsePageRanges(value, total);
    if (parsed.ok) {
      setError(null);
      onPages(parsed.pages);
    } else {
      setError(parsed.error);
    }
  }

  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-gray-700 dark:text-[#aaa]">{label}</label>
      <input
        id={id}
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder="e.g. 1-3, 7, 10-"
        aria-invalid={error !== null}
        aria-describedby={`${id}-help`}
        className={`mt-1 w-full max-w-sm rounded-lg border px-3 py-1.5 text-sm dark:bg-[#141414] dark:text-[#e5e5e5] ${error ? "border-red-400" : "border-gray-300 dark:border-[#333]"}`}
      />
      <p id={`${id}-help`} role={error ? "alert" : undefined} className={`mt-1 text-xs ${error ? "text-red-600 dark:text-red-400" : "text-gray-500 dark:text-[#555]"}`}>
        {error ?? "Click pages or type ranges."}
      </p>
    </div>
  );
}
