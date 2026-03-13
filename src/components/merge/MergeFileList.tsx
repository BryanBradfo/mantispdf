import { useRef, useState, useMemo } from "react";
import { Document, Thumbnail } from "react-pdf";
import type { MergeFile } from "../../hooks/useMergeState";

interface MergeFileListProps {
  files: MergeFile[];
  onReorder: (fromIndex: number, toIndex: number) => void;
  onRemove: (id: string) => void;
}

function ChevronArrow() {
  return (
    <div className="flex shrink-0 items-center self-center px-1 text-gray-300 dark:text-[#333]">
      <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
    </div>
  );
}

function FileCard({
  file,
  index,
  pdfUrl,
  onDragStart,
  onDragEnd,
  onDragOver,
  onRemove,
}: {
  file: MergeFile;
  index: number;
  pdfUrl: string;
  onDragStart: (e: React.DragEvent, index: number) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent, index: number) => void;
  onRemove: (id: string) => void;
}) {
  const [loaded, setLoaded] = useState(false);

  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, index)}
      onDragEnd={onDragEnd}
      onDragOver={(e) => onDragOver(e, index)}
      className="w-[200px] shrink-0 cursor-grab rounded-lg border border-gray-200 bg-white shadow-sm transition-all duration-200 active:cursor-grabbing dark:border-[#222] dark:bg-[#141414]"
    >
      {/* Thumbnail area */}
      <div className="relative">
        <Document file={pdfUrl} loading={null}>
          <div className="relative aspect-[8.5/11] w-full overflow-hidden rounded-t-lg bg-gray-100 dark:bg-[#1a1a1a]">
            <Thumbnail
              pageNumber={1}
              width={200}
              onRenderSuccess={() => setLoaded(true)}
              className="h-full w-full object-contain"
            />
            {!loaded && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-mantis-300 border-t-transparent" />
              </div>
            )}
          </div>
        </Document>

        {/* Order badge — top-left */}
        <span className="absolute top-2 left-2 flex h-6 w-6 items-center justify-center rounded-full bg-mantis-100 text-xs font-semibold text-mantis-700 shadow-sm dark:bg-[#1a1a1a] dark:text-mantis-400">
          {index + 1}
        </span>

        {/* Remove button — top-right */}
        <button
          onClick={() => onRemove(file.id)}
          className="absolute top-2 right-2 flex h-6 w-6 items-center justify-center rounded-full bg-white/80 text-gray-400 shadow-sm backdrop-blur-sm hover:bg-red-50 hover:text-red-500 dark:bg-[#1a1a1a]/80 dark:text-[#666] dark:hover:bg-red-950/40 dark:hover:text-red-400"
          title="Remove file"
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* File info */}
      <div className="border-t border-gray-100 px-2 py-1.5 dark:border-[#222]">
        <p className="truncate text-xs font-medium text-gray-900 dark:text-[#e5e5e5]">{file.file.name}</p>
        <p className="text-[11px] text-gray-500 dark:text-[#555]">
          {file.numPages} page{file.numPages !== 1 ? "s" : ""}
        </p>
      </div>
    </div>
  );
}

export default function MergeFileList({ files, onReorder, onRemove }: MergeFileListProps) {
  const [previewFiles, setPreviewFiles] = useState<MergeFile[] | null>(null);
  const draggedId = useRef<string | null>(null);
  const dragNodeRef = useRef<HTMLElement | null>(null);
  const dragGhostRef = useRef<HTMLElement | null>(null);

  // Incremental Blob URL map — reuses URLs for existing files, only creates/revokes on add/remove.
  // Avoids StrictMode double-invoke cleanup revoking valid URLs.
  const urlMapRef = useRef(new Map<string, string>());

  const pdfUrlMap = useMemo(() => {
    const prev = urlMapRef.current;
    const next = new Map<string, string>();

    for (const f of files) {
      const existing = prev.get(f.id);
      next.set(f.id, existing ?? URL.createObjectURL(new Blob([f.bytes], { type: "application/pdf" })));
    }

    for (const [id, url] of prev) {
      if (!next.has(id)) URL.revokeObjectURL(url);
    }

    urlMapRef.current = next;
    return next;
  }, [files]);

  function handleDragStart(e: React.DragEvent, index: number) {
    draggedId.current = files[index].id;
    setPreviewFiles([...files]);
    dragNodeRef.current = e.currentTarget as HTMLElement;
    e.dataTransfer.effectAllowed = "move";

    // Build a semi-transparent ghost clone with thumbnail canvas data
    const card = e.currentTarget as HTMLElement;
    const ghost = card.cloneNode(true) as HTMLElement;

    // cloneNode produces blank canvases — copy pixel data from originals
    const srcCanvases = card.querySelectorAll("canvas");
    const dstCanvases = ghost.querySelectorAll("canvas");
    srcCanvases.forEach((src, i) => {
      const dst = dstCanvases[i];
      if (!dst) return;
      dst.width = src.width;
      dst.height = src.height;
      dst.getContext("2d")?.drawImage(src, 0, 0);
    });

    ghost.style.opacity = "0.7";
    ghost.style.position = "absolute";
    ghost.style.top = "-9999px";
    ghost.style.left = "-9999px";
    ghost.style.pointerEvents = "none";
    document.body.appendChild(ghost);

    const rect = card.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    e.dataTransfer.setDragImage(ghost, offsetX, offsetY);
    dragGhostRef.current = ghost;

    requestAnimationFrame(() => {
      dragNodeRef.current?.classList.add("opacity-50");
    });
  }

  function handleDragOver(e: React.DragEvent, index: number) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (!previewFiles || !draggedId.current) return;

    const currentIndex = previewFiles.findIndex((f) => f.id === draggedId.current);
    if (currentIndex === -1 || currentIndex === index) return;

    const updated = [...previewFiles];
    const [moved] = updated.splice(currentIndex, 1);
    updated.splice(index, 0, moved);
    setPreviewFiles(updated);
  }

  function handleDragEnd() {
    dragNodeRef.current?.classList.remove("opacity-50");
    dragGhostRef.current?.remove();
    dragGhostRef.current = null;

    if (previewFiles && draggedId.current) {
      const originalIndex = files.findIndex((f) => f.id === draggedId.current);
      const finalIndex = previewFiles.findIndex((f) => f.id === draggedId.current);
      if (originalIndex !== -1 && finalIndex !== -1 && originalIndex !== finalIndex) {
        onReorder(originalIndex, finalIndex);
      }
    }

    setPreviewFiles(null);
    draggedId.current = null;
    dragNodeRef.current = null;
  }

  const displayFiles = previewFiles ?? files;

  return (
    <div className="flex flex-wrap items-start gap-y-4">
      {displayFiles.map((file, index) => {
        const isLast = index === displayFiles.length - 1;
        return (
          <div key={file.id} className="flex items-start">
            <FileCard
              file={file}
              index={index}
              pdfUrl={pdfUrlMap.get(file.id)!}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragOver={handleDragOver}
              onRemove={onRemove}
            />
            {!isLast && <ChevronArrow />}
          </div>
        );
      })}
    </div>
  );
}
