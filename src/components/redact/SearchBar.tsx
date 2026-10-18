import { useId, useState } from "react";

export interface SearchResult {
  query: string;
  /** Areas found: one per line of each match. */
  count: number;
  /** Pages with at least one match, ascending. */
  pages: number[];
}

interface Props {
  /** True while the pages are being searched. */
  searching: boolean;
  result: SearchResult | null;
  onFind: (query: string, wholeWord: boolean) => void;
  onMarkAll: () => void;
  /** A redaction runs or waits for its go-ahead: "Find" and "Mark all" wait. */
  locked: boolean;
}

const fieldClass =
  "w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm text-gray-900 focus:border-mantis-500 focus:outline-none focus:ring-1 focus:ring-mantis-500 dark:border-[#333] dark:bg-[#111] dark:text-[#ddd]";
const buttonClass =
  "rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-mantis-500 disabled:opacity-50 dark:border-[#333] dark:text-[#bbb] dark:hover:bg-[#1a1a1a]";

/** "Find text": every case-insensitive match on every page, then "Mark all". */
export default function SearchBar({ searching, result, onFind, onMarkAll, locked }: Props) {
  const [query, setQuery] = useState("");
  const [wholeWord, setWholeWord] = useState(false);
  const id = useId();

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
              <button type="button" onClick={onMarkAll} disabled={locked} className={`mt-2 ${buttonClass}`}>
                Mark all
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
