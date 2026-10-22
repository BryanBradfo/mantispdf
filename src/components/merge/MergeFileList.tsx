import { memo } from "react";
import type { MergeFile } from "../../hooks/useMergeState";
import PageImage from "../common/PageImage";
import SortableGrid from "../common/SortableGrid";
import { useT } from "../../i18n";

interface MergeFileListProps {
  files: MergeFile[];
  onReorder: (fromIndex: number, toIndex: number) => void;
  onRemove: (id: string) => void;
}

const FileCard = memo(function FileCard({
  file,
  index,
  total,
  onRemove,
  onReorder,
}: {
  file: MergeFile;
  index: number;
  total: number;
  onRemove: (id: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
}) {
  const t = useT("merge");
  return (
    <div
      data-testid="merge-card"
      className="rounded-lg border border-gray-200 bg-white shadow-sm transition-shadow duration-150 hover:shadow-md dark:border-[#222] dark:bg-[#141414]"
    >
      <div className="relative">
        <PageImage source={file.bytes} page={1} width={200} alt={t("firstPageOf", { name: file.file.name })} className="rounded-t-lg" />
        <button
          data-no-dnd
          onClick={() => onRemove(file.id)}
          className="absolute top-2 right-2 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-white/80 text-gray-400 shadow-sm backdrop-blur-sm hover:bg-red-50 hover:text-red-500 dark:bg-[#1a1a1a]/80 dark:text-[#666] dark:hover:bg-red-950/40 dark:hover:text-red-400"
          title={t("removeFile")}
          aria-label={t("removeNamed", { name: file.file.name })}
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="border-t border-gray-100 px-2 py-1.5 dark:border-[#222]">
        <div className="flex items-center gap-1.5">
          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-mantis-100 text-[9px] font-semibold text-mantis-700 dark:bg-[#1a1a1a] dark:text-mantis-400">
            {index + 1}
          </span>
          <p className="truncate text-xs font-medium text-gray-900 dark:text-[#e5e5e5]">{file.file.name}</p>
        </div>
        <p className="text-[11px] text-gray-500 dark:text-[#555]">
          {t("pages", { count: file.numPages })}
        </p>
      </div>

      <div className="flex h-8 border-t border-gray-100 dark:border-[#222]">
        <button
          data-no-dnd
          onClick={() => onReorder(index, index - 1)}
          disabled={index === 0}
          className="flex flex-1 items-center justify-center text-gray-300 transition-colors hover:bg-gray-50 hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-[#1a1a1a] dark:hover:text-[#888]"
          title={t("moveLeft")}
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="w-px bg-gray-100 dark:bg-[#222]" />
        <button
          data-no-dnd
          onClick={() => onReorder(index, index + 1)}
          disabled={index === total - 1}
          className="flex flex-1 items-center justify-center text-gray-300 transition-colors hover:bg-gray-50 hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-[#1a1a1a] dark:hover:text-[#888]"
          title={t("moveRight")}
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>
    </div>
  );
});

export default function MergeFileList({ files, onReorder, onRemove }: MergeFileListProps) {
  return (
    <SortableGrid
      items={files}
      onReorder={onReorder}
      label={(f) => f.file.name}
      className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-4"
      renderItem={(file, index) => (
        <FileCard file={file} index={index} total={files.length} onRemove={onRemove} onReorder={onReorder} />
      )}
    />
  );
}
