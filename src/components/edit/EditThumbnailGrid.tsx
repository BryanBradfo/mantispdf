import { useMemo } from "react";
import type { EditAction, EditState } from "../../hooks/useEditState";
import PageImage from "../common/PageImage";
import SortableGrid from "../common/SortableGrid";

interface Props {
  pdfBytes: Uint8Array;
  state: EditState;
  dispatch: React.Dispatch<EditAction>;
}

export default function EditThumbnailGrid({ pdfBytes, state, dispatch }: Props) {
  const { pageOrder, deletedPages } = state;
  const items = useMemo(() => pageOrder.map((page) => ({ id: String(page), page })), [pageOrder]);

  return (
    <SortableGrid
      items={items}
      onReorder={(from, to) => dispatch({ type: "reorder", from, to })}
      label={(it) => `Page ${it.page}`}
      className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5"
      renderItem={({ page }, index) => {
        const isDeleted = deletedPages.has(page);
        return (
          <div data-testid="edit-card" className="flex flex-col items-center gap-2">
            <div className="relative w-full">
              <div
                className={`overflow-hidden rounded-lg border bg-white shadow-sm transition-colors dark:bg-[#141414] ${
                  isDeleted ? "border-red-400 dark:border-red-700" : "border-gray-200 dark:border-[#222]"
                }`}
              >
                <div className="relative">
                  <PageImage source={pdfBytes} page={page} width={160} alt={`Page ${page}`} />
                  {isDeleted && (
                    <div className="absolute inset-0 flex items-center justify-center bg-red-500/30 dark:bg-red-900/40">
                      <span className="text-3xl">🗑️</span>
                    </div>
                  )}
                </div>
                <div className="border-t border-gray-100 px-2 py-1 text-center text-xs text-gray-500 dark:border-[#222] dark:text-[#555]">
                  Page {page}
                </div>
              </div>

              <button
                data-no-dnd
                onClick={() => dispatch({ type: "move-page", index, direction: "left" })}
                disabled={index === 0}
                className="absolute left-1 top-1/2 -translate-y-1/2 rounded bg-white/80 px-1 py-0.5 text-xs shadow hover:bg-gray-100 disabled:opacity-0 dark:bg-[#1a1a1a]/80 dark:hover:bg-[#222]"
                title="Move left"
              >
                ←
              </button>
              <button
                data-no-dnd
                onClick={() => dispatch({ type: "move-page", index, direction: "right" })}
                disabled={index === pageOrder.length - 1}
                className="absolute right-1 top-1/2 -translate-y-1/2 rounded bg-white/80 px-1 py-0.5 text-xs shadow hover:bg-gray-100 disabled:opacity-0 dark:bg-[#1a1a1a]/80 dark:hover:bg-[#222]"
                title="Move right"
              >
                →
              </button>
            </div>

            <button
              data-no-dnd
              onClick={() => dispatch({ type: "toggle-delete", page })}
              className={`rounded border px-2 py-1 text-xs font-medium transition-colors ${
                isDeleted
                  ? "border-red-400 bg-red-100 text-red-700 hover:bg-red-200 dark:border-red-700 dark:bg-red-950/40 dark:text-red-400 dark:hover:bg-red-900/40"
                  : "border-gray-200 text-gray-500 hover:border-red-300 hover:bg-red-50 hover:text-red-600 dark:border-[#333] dark:text-[#666] dark:hover:border-red-700 dark:hover:bg-red-950/20 dark:hover:text-red-400"
              }`}
              title={isDeleted ? "Restore page" : "Mark for deletion"}
            >
              {isDeleted ? "Restore" : "Delete"}
            </button>
          </div>
        );
      }}
    />
  );
}
