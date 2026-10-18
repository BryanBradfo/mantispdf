import { useEffect, useId, useState } from "react";
import { entryLabel, selectedMarks, type SearchEntry } from "../../lib/redact/marking";
import type { MarkInput } from "../../lib/redact/model";

export interface SearchResult {
  query: string;
  /** Areas found: one per line of each match. */
  count: number;
  /** Pages with at least one match, ascending. */
  pages: number[];
  /** The areas, numbered per page, for the review list. */
  entries: SearchEntry[];
}

interface Props {
  /** True while the pages are being searched. */
  searching: boolean;
  result: SearchResult | null;
  onFind: (query: string, wholeWord: boolean) => void;
  /** Mark the given areas (the checked ones, or all of them). */
  onMark: (marks: MarkInput[]) => void;
  /** Show a page in the canvas. */
  onShowPage: (page: number) => void;
  /** A redaction runs or waits for its go-ahead: "Find" and marking wait. */
  locked: boolean;
}

const fieldClass =
  "w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm text-gray-900 focus:border-mantis-500 focus:outline-none focus:ring-1 focus:ring-mantis-500 dark:border-[#333] dark:bg-[#111] dark:text-[#ddd]";
const buttonClass =
  "rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-mantis-500 disabled:opacity-50 dark:border-[#333] dark:text-[#bbb] dark:hover:bg-[#1a1a1a]";

/**
 * "Find text": every case-insensitive match on every page, reviewed in a list (all checked at
 * first), then "Mark selected" or the "Mark all" shortcut.
 */
export default function SearchBar({ searching, result, onFind, onMark, onShowPage, locked }: Props) {
  const [query, setQuery] = useState("");
  const [wholeWord, setWholeWord] = useState(false);
  const [checked, setChecked] = useState<ReadonlySet<number>>(new Set());
  const id = useId();

  // A new search starts with every area checked.
  useEffect(() => setChecked(new Set(result?.entries.map((e) => e.id) ?? [])), [result]);

  const toggle = (entry: number) =>
    setChecked((c) => {
      const next = new Set(c);
      if (next.has(entry)) next.delete(entry);
      else next.add(entry);
      return next;
    });

  const pagesLabel = (pages: number[]) =>
    pages.length <= 8 ? pages.join(", ") : `${pages.slice(0, 8).join(", ")} and ${pages.length - 8} more`;

  return (
    <section aria-labelledby={`${id}-title`} className="rounded-xl border border-gray-200 bg-white p-4 dark:border-[#333] dark:bg-[#111]">
      <h2 id={`${id}-title`} className="text-sm font-semibold text-gray-900 dark:text-[#ddd]">
        Find text
      </h2>
      <form
        className="mt-2 space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim() !== "") onFind(query, wholeWord);
        }}
      >
        <div className="flex gap-2">
          <input
            type="search"
            aria-label="Text to find"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name, number, word..."
            className={fieldClass}
          />
          <button type="submit" disabled={searching || locked || query.trim() === ""} className={buttonClass}>
            {searching ? "Finding…" : "Find"}
          </button>
        </div>
        <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-[#aaa]">
          <input
            type="checkbox"
            checked={wholeWord}
            onChange={(e) => setWholeWord(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-mantis-600 focus:ring-mantis-500"
          />
          Whole words only
        </label>
        <p className="text-xs text-gray-500 dark:text-[#777]">Words split across lines with a hyphen are not found.</p>
      </form>
      {result && (
        <div className="mt-3" role="status">
          {result.count === 0 ? (
            <p className="text-sm text-gray-600 dark:text-[#999]">No match for "{result.query}".</p>
          ) : (
            <>
              <p className="text-sm text-gray-800 dark:text-[#ccc]">
                {result.count} {result.count === 1 ? "area" : "areas"} (one per line of each match) for "{result.query}" on{" "}
                {result.pages.length === 1 ? "page" : "pages"} {pagesLabel(result.pages)}.
              </p>
              <ul aria-label="Search results" className="mt-2 max-h-48 space-y-1 overflow-y-auto pr-1">
                {result.entries.map((e) => (
                  <li key={e.id} className="flex items-center justify-between gap-2 text-sm">
                    <label className="flex items-center gap-2 text-gray-800 dark:text-[#ccc]">
                      <input
                        type="checkbox"
                        checked={checked.has(e.id)}
                        disabled={locked}
                        onChange={() => toggle(e.id)}
                        className="h-4 w-4 rounded border-gray-300 text-mantis-600 focus:ring-mantis-500"
                      />
                      {entryLabel(e)}
                    </label>
                    <button type="button" onClick={() => onShowPage(e.page)} className="text-xs text-gray-500 underline dark:text-[#888]">
                      Show
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => onMark(selectedMarks(result.entries, checked))}
                  disabled={locked || checked.size === 0}
                  className={buttonClass}
                >
                  Mark selected ({checked.size})
                </button>
                <button type="button" onClick={() => onMark(result.entries.map((e) => e.mark))} disabled={locked} className={buttonClass}>
                  Mark all
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
