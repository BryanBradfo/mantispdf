import { memo } from "react";
import type { MergeFile } from "../../hooks/useMergeState";
import PageImage from "../common/PageImage";
import SortableGrid from "../common/SortableGrid";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { formatNumber, useLocale, useT } from "../../i18n";
import { focusRing } from "../../pages/ToolShell";

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
  const locale = useLocale();
  const iconButton = `flex flex-1 items-center justify-center text-ink-2 hover:bg-ink hover:text-paper disabled:pointer-events-none disabled:opacity-30 ${focusRing}`;
  return (
    <div data-testid="merge-card" className="border border-line bg-surface">
      <div className="relative bg-paper">
        <PageImage source={file.bytes} page={1} width={200} alt={t("firstPageOf", { name: file.file.name })} />
        <button
          data-no-dnd
          onClick={() => onRemove(file.id)}
          className={`absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center border border-line bg-paper text-ink-2 hover:border-danger hover:text-danger ${focusRing}`}
          title={t("removeFile")}
          aria-label={t("removeNamed", { name: file.file.name })}
        >
          <X aria-hidden="true" strokeWidth={1.5} className="h-4 w-4" />
        </button>
      </div>

      <div className="border-t border-line px-3 py-2.5">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[11px] tracking-[0.08em] text-ink-2">{formatNumber(index + 1, locale, { minimumIntegerDigits: 2 })}</span>
          <p className="truncate text-xs font-medium text-ink">{file.file.name}</p>
        </div>
        <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-2">
          {t("pages", { count: file.numPages })}
        </p>
      </div>

      <div className="flex h-9 border-t border-line">
        <button
          data-no-dnd
          onClick={() => onReorder(index, index - 1)}
          disabled={index === 0}
          className={iconButton}
          title={t("moveLeft")}
        >
          <ChevronLeft aria-hidden="true" strokeWidth={1.5} className="h-4 w-4" />
        </button>
        <div className="w-px bg-line" />
        <button
          data-no-dnd
          onClick={() => onReorder(index, index + 1)}
          disabled={index === total - 1}
          className={iconButton}
          title={t("moveRight")}
        >
          <ChevronRight aria-hidden="true" strokeWidth={1.5} className="h-4 w-4" />
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
      className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))] sm:gap-4"
      renderItem={(file, index) => (
        <FileCard file={file} index={index} total={files.length} onRemove={onRemove} onReorder={onReorder} />
      )}
    />
  );
}
