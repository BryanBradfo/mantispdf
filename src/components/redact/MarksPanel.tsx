import { Redo2, Trash2, Undo2 } from "lucide-react";
import type { Mark } from "../../lib/redact/model";
import type { Fill } from "../../lib/redact/toJob";

interface Props {
  marks: readonly Mark[];
  /** Page shown in the canvas. */
  page: number;
  onPage: (page: number) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** Whether the shown page is marked whole, and how to change it. */
  wholePage: boolean;
  onToggleWholePage: () => void;
  fill: Fill;
  onFill: (fill: Fill) => void;
  removeMetadata: boolean;
  onRemoveMetadata: (on: boolean) => void;
  /** A redaction is running or waiting for its go-ahead: nothing here can change. */
  locked: boolean;
}

const smallButton =
  "flex items-center justify-center gap-1 rounded-md border border-gray-300 px-2 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-mantis-500 disabled:opacity-40 dark:border-[#333] dark:text-[#bbb] dark:hover:bg-[#1a1a1a]";

function describe(m: Mark): string {
  switch (m.kind) {
    case "area":
      return "Marked area";
    case "search":
      return `Match: "${m.query}"`;
    case "page":
      return "Whole page";
  }
}

/** The marks by page, history, whole-page toggle and output options. */
export default function MarksPanel(props: Props) {
  const { marks, page, locked } = props;
  const pages = [...new Set(marks.map((m) => m.page))].sort((a, b) => a - b);

  return (
    <div className="space-y-4">
      <section aria-label="Marks" className="rounded-xl border border-gray-200 bg-white p-4 dark:border-[#333] dark:bg-[#111]">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-[#ddd]">
            Marks ({marks.length})
          </h2>
          <div className="flex gap-1">
            <button type="button" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={locked || !props.canUndo} onClick={props.onUndo} className={smallButton}>
              <Undo2 aria-hidden="true" className="h-4 w-4" />
            </button>
            <button type="button" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={locked || !props.canRedo} onClick={props.onRedo} className={smallButton}>
              <Redo2 aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>
        </div>

        <label className="mt-3 flex items-center gap-2 text-sm text-gray-700 dark:text-[#aaa]">
          <input
            type="checkbox"
            checked={props.wholePage}
            disabled={locked}
            onChange={props.onToggleWholePage}
            className="h-4 w-4 rounded border-gray-300 text-mantis-600 focus:ring-mantis-500"
          />
          Redact whole page {page}
        </label>

        {marks.length === 0 ? (
          <p className="mt-3 text-sm text-gray-600 dark:text-[#888]">Drag on the page or find text to mark what to remove.</p>
        ) : (
          <ol className="mt-3 max-h-72 space-y-3 overflow-y-auto pr-1">
            {pages.map((p) => (
              <li key={p}>
                <button
                  type="button"
                  onClick={() => props.onPage(p)}
                  aria-current={p === page ? "page" : undefined}
                  className="text-xs font-semibold text-gray-600 underline-offset-2 hover:underline dark:text-[#999]"
                >
                  Page {p}
                </button>
                <ul className="mt-1 space-y-1">
                  {marks
                    .filter((m) => m.page === p)
                    .map((m) => (
                      <li
                        key={m.id}
                        className={`flex items-center justify-between gap-2 rounded-md px-2 py-1 text-sm ${
                          m.id === props.selectedId ? "bg-mantis-50 dark:bg-[#0f1a0f]" : ""
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            props.onPage(m.page);
                            props.onSelect(m.kind === "page" ? null : m.id);
                          }}
                          className="min-w-0 truncate text-left text-gray-800 dark:text-[#ccc]"
                        >
                          {describe(m)}
                        </button>
                        <button type="button" aria-label={`Delete ${describe(m).toLowerCase()} on page ${m.page}`} disabled={locked} onClick={() => props.onRemove(m.id)} className={smallButton}>
                          <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                          Delete
                        </button>
                      </li>
                    ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
        {marks.length > 0 && (
          <button type="button" disabled={locked} onClick={props.onClear} className={`mt-3 ${smallButton}`}>
            Remove all marks
          </button>
        )}
      </section>

      <section aria-label="Output" className="rounded-xl border border-gray-200 bg-white p-4 dark:border-[#333] dark:bg-[#111]">
        <fieldset>
          <legend className="text-sm font-semibold text-gray-900 dark:text-[#ddd]">Box colour</legend>
          <div className="mt-2 flex gap-4">
            {(["black", "white"] as const).map((f) => (
              <label key={f} className="flex items-center gap-2 text-sm text-gray-700 dark:text-[#aaa]">
                <input
                  type="radio"
                  name="redact-fill"
                  checked={props.fill === f}
                  disabled={locked}
                  onChange={() => props.onFill(f)}
                  className="h-4 w-4 border-gray-300 text-mantis-600 focus:ring-mantis-500"
                />
                {f === "black" ? "Black" : "White"}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="mt-3 flex items-start gap-2 text-sm text-gray-700 dark:text-[#aaa]">
          <input
            type="checkbox"
            checked={props.removeMetadata}
            disabled={locked}
            onChange={(e) => props.onRemoveMetadata(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-gray-300 text-mantis-600 focus:ring-mantis-500"
          />
          Remove document metadata (title, author, dates)
        </label>
      </section>
    </div>
  );
}
