import PageImage from "../common/PageImage";

interface Props {
  source: Blob | Uint8Array;
  pageCount: number;
  /** 1-based page shown in the editor. */
  page: number;
  /** Pages marked with a dot (pages that carry at least one edit, by default). */
  edited: ReadonlySet<number>;
  onPage: (page: number) => void;
  /** What a dot means, read out after the page number and shown as its tooltip. */
  markLabel?: string;
}

export default function PageStrip({ source, pageCount, page, edited, onPage, markLabel = "edited" }: Props) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-2" role="group" aria-label="Pages">
      {Array.from({ length: pageCount }, (_, i) => {
        const n = i + 1;
        const isEdited = edited.has(n);
        return (
          <button
            key={n}
            type="button"
            aria-label={`Page ${n}${isEdited ? `, ${markLabel}` : ""}`}
            aria-pressed={page === n}
            onClick={() => onPage(n)}
            className={`relative w-16 shrink-0 overflow-hidden rounded-md border-2 bg-white text-xs dark:bg-[#111] ${
              page === n ? "border-mantis-600" : "border-transparent hover:border-gray-300 dark:hover:border-[#444]"
            }`}
          >
            <PageImage source={source} page={n} width={64} alt="" />
            <span className="block py-0.5 text-gray-700 dark:text-[#aaa]">{n}</span>
            {isEdited && (
              <span
                aria-hidden="true"
                title={markLabel.charAt(0).toUpperCase() + markLabel.slice(1)}
                className="absolute right-1 top-1 h-2.5 w-2.5 rounded-full bg-mantis-600 ring-2 ring-white dark:ring-[#111]"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
