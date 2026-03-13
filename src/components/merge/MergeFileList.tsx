import { useCallback, useEffect, useMemo, useState } from "react";
import React from "react";
import { Document, Thumbnail } from "react-pdf";
import type { MergeFile } from "../../hooks/useMergeState";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";

const SLIDE_DURATION = 600; // ms
const SLIDE_PX = 216;       // card 200px + gap 16px

interface MergeFileListProps {
  files: MergeFile[];
  onReorder: (fromIndex: number, toIndex: number) => void;
  onRemove: (id: string) => void;
}

const FileCard = React.memo(
  function FileCard({
    file,
    index,
    total,
    slideDir,
    onRemove,
    onMove,
  }: {
    file: MergeFile;
    index: number;
    total: number;
    slideDir: -1 | 1 | null;
    onRemove: (id: string) => void;
    onMove: (fromIndex: number, direction: -1 | 1) => void;
  }) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
      useSortable({ id: file.id });

    const style: React.CSSProperties = {
      transform: [
        transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : null,
        slideDir !== null ? `translateX(${slideDir * SLIDE_PX}px)` : null,
      ].filter(Boolean).join(' ') || undefined,
      transition: slideDir !== null
        ? `transform ${SLIDE_DURATION}ms ease-in-out`
        : (transition ?? undefined),
      opacity: isDragging ? 0.5 : 1,
      cursor: isDragging ? "grabbing" : undefined,
      zIndex: slideDir !== null ? 1 : undefined,
      position: 'relative',
    };

    const blobUrl = useMemo(
      () => URL.createObjectURL(new Blob([file.bytes], { type: "application/pdf" })),
      [file.bytes],
    );
    useEffect(() => () => URL.revokeObjectURL(blobUrl), [blobUrl]);

    const [thumbLoaded, setThumbLoaded] = useState(false);
    const [loadError, setLoadError] = useState(false);

    return (
      <div ref={setNodeRef} style={style} className="relative w-[200px] shrink-0">
        {/* Inner: visual card + CSS hover animation */}
        <div className="rounded-lg border border-gray-200 bg-white shadow-sm hover:-translate-y-px hover:shadow-md transition-[transform,box-shadow] duration-150 dark:border-[#222] dark:bg-[#141414]">
          {/* Thumbnail area */}
          <div className="relative">
            {/* Drag handle — top-center */}
            <div
              {...attributes}
              {...listeners}
              className="absolute top-1/2 left-1/2 z-10 -translate-x-1/2 -translate-y-1/2 flex h-10 w-10 cursor-grab items-center justify-center rounded-full bg-white/70 text-mantis-400 shadow-sm backdrop-blur-sm hover:bg-white/90 hover:text-mantis-600 dark:bg-black/40 dark:text-mantis-400 dark:hover:bg-black/60 dark:hover:text-mantis-300 active:cursor-grabbing transition-colors duration-150"
              title="Drag to reorder"
            >
              <svg className="h-5 w-5" viewBox="0 0 16 16" fill="currentColor">
                <circle cx="5" cy="4" r="1.2" />
                <circle cx="5" cy="8" r="1.2" />
                <circle cx="5" cy="12" r="1.2" />
                <circle cx="11" cy="4" r="1.2" />
                <circle cx="11" cy="8" r="1.2" />
                <circle cx="11" cy="12" r="1.2" />
              </svg>
            </div>

            {/* PDF thumbnail */}
            <Document file={blobUrl} loading={null} error={null} onLoadError={() => setLoadError(true)}>
              <div className="pointer-events-none relative aspect-[8.5/11] w-full overflow-hidden rounded-t-lg bg-gray-50 dark:bg-[#1a1a1a]">
                {loadError ? (
                  <div className="flex h-full flex-col items-center justify-center gap-2">
                    <svg
                      viewBox="0 0 80 100"
                      className="h-20 w-16 drop-shadow-sm"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <path d="M4 4 H58 L76 22 V96 H4 Z" fill="white" stroke="#e5e7eb" strokeWidth="1.5" className="dark:fill-[#1e1e1e] dark:stroke-[#333]" />
                      <path d="M58 4 L58 22 L76 22" fill="#f3f4f6" stroke="#e5e7eb" strokeWidth="1.5" className="dark:fill-[#2a2a2a] dark:stroke-[#333]" />
                      <line x1="14" y1="38" x2="66" y2="38" stroke="#d1d5db" strokeWidth="2.5" strokeLinecap="round" className="dark:stroke-[#333]" />
                      <line x1="14" y1="50" x2="66" y2="50" stroke="#d1d5db" strokeWidth="2.5" strokeLinecap="round" className="dark:stroke-[#333]" />
                      <line x1="14" y1="62" x2="55" y2="62" stroke="#d1d5db" strokeWidth="2.5" strokeLinecap="round" className="dark:stroke-[#333]" />
                      <line x1="14" y1="74" x2="48" y2="74" stroke="#e5e7eb" strokeWidth="2.5" strokeLinecap="round" className="dark:stroke-[#2a2a2a]" />
                    </svg>
                    <span className="text-[10px] font-semibold tracking-wider text-gray-300 dark:text-[#444]">PDF</span>
                  </div>
                ) : (
                  <>
                    <Thumbnail
                      pageNumber={1}
                      width={200}
                      onRenderSuccess={() => setThumbLoaded(true)}
                      className="h-full w-full object-contain"
                    />
                    {!thumbLoaded && (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <div className="h-6 w-6 animate-spin rounded-full border-2 border-mantis-300 border-t-transparent" />
                      </div>
                    )}
                  </>
                )}
              </div>
            </Document>

            {/* Remove button — top-right */}
            <button
              onClick={() => onRemove(file.id)}
              className="absolute top-2 right-2 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-white/80 text-gray-400 shadow-sm backdrop-blur-sm hover:bg-red-50 hover:text-red-500 dark:bg-[#1a1a1a]/80 dark:text-[#666] dark:hover:bg-red-950/40 dark:hover:text-red-400"
              title="Remove file"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* File info */}
          <div className="border-t border-gray-100 px-2 py-1.5 dark:border-[#222]">
            <div className="flex items-center gap-1.5">
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-mantis-100 text-[9px] font-semibold text-mantis-700 dark:bg-[#1a1a1a] dark:text-mantis-400">
                {index + 1}
              </span>
              <p className="truncate text-xs font-medium text-gray-900 dark:text-[#e5e5e5]">{file.file.name}</p>
            </div>
            <p className="text-[11px] text-gray-500 dark:text-[#555]">
              {file.numPages} page{file.numPages !== 1 ? "s" : ""}
            </p>
          </div>

          {/* Move zones — left half / right half */}
          <div className="flex h-8 border-t border-gray-100 dark:border-[#222]">
            <button
              onClick={() => onMove(index, -1)}
              disabled={index === 0}
              className="flex flex-1 items-center justify-center text-gray-300 hover:bg-gray-50 hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-30 transition-colors dark:hover:bg-[#1a1a1a] dark:hover:text-[#888]"
              title="Move left"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <div className="w-px bg-gray-100 dark:bg-[#222]" />
            <button
              onClick={() => onMove(index, 1)}
              disabled={index === total - 1}
              className="flex flex-1 items-center justify-center text-gray-300 hover:bg-gray-50 hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-30 transition-colors dark:hover:bg-[#1a1a1a] dark:hover:text-[#888]"
              title="Move right"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    );
  },
  (prev, next) =>
    prev.file === next.file &&
    prev.index === next.index &&
    prev.total === next.total &&
    prev.slideDir === next.slideDir,
);

export default function MergeFileList({ files, onReorder, onRemove }: MergeFileListProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  );

  const [swapping, setSwapping] = useState<{ fromIndex: number; dir: -1 | 1 } | null>(null);

  const handleMove = useCallback(
    (fromIndex: number, dir: -1 | 1) => {
      if (swapping !== null) return;
      setSwapping({ fromIndex, dir });
      setTimeout(() => {
        setSwapping(null);
        onReorder(fromIndex, fromIndex + dir);
      }, SLIDE_DURATION);
    },
    [swapping, onReorder],
  );

  const handleRemove = useCallback((id: string) => onRemove(id), [onRemove]);

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = files.findIndex((f) => f.id === String(active.id));
      const newIndex = files.findIndex((f) => f.id === String(over.id));
      if (oldIndex !== -1 && newIndex !== -1) onReorder(oldIndex, newIndex);
    }
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={files.map((f) => f.id)} strategy={rectSortingStrategy}>
        <div className="flex flex-wrap gap-4">
          {files.map((file, index) => (
            <FileCard
              key={file.id}
              file={file}
              index={index}
              total={files.length}
              slideDir={
                swapping === null ? null
                : index === swapping.fromIndex ? swapping.dir
                : index === swapping.fromIndex + swapping.dir ? (-swapping.dir as -1 | 1)
                : null
              }
              onRemove={handleRemove}
              onMove={handleMove}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
