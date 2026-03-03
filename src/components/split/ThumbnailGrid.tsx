import { Document } from "react-pdf";
import PageThumbnail from "./PageThumbnail";

interface ThumbnailGridProps {
  pdfUrl: string;
  numPages: number;
  splitPoints: Set<number>;
  onToggleSplit: (page: number) => void;
}

function VerticalDivider({
  pageNumber,
  isActive,
  onToggle,
}: {
  pageNumber: number;
  isActive: boolean;
  onToggle: (page: number) => void;
}) {
  return (
    <button
      onClick={() => onToggle(pageNumber)}
      className={`group flex w-6 shrink-0 cursor-pointer flex-col items-center justify-center self-stretch transition ${
        isActive ? "text-mantis-600" : "text-gray-300 hover:text-gray-500"
      }`}
      title={isActive ? "Remove split point" : "Split after this page"}
    >
      <div
        className={`w-px flex-1 transition ${
          isActive
            ? "border-l-2 border-dashed border-mantis-400"
            : "border-l border-dashed border-gray-200 group-hover:border-gray-400"
        }`}
      />
      <svg
        className="h-5 w-5 shrink-0 rotate-90"
        viewBox="0 0 24 24"
        fill="currentColor"
      >
        <path d="M9.64 7.64c.23-.5.36-1.05.36-1.64a4 4 0 1 0-8 0 4 4 0 0 0 4 4c.59 0 1.14-.13 1.64-.36L10 12l-2.36 2.36A4.2 4.2 0 0 0 6 14a4 4 0 1 0 4 4c0-.59-.13-1.14-.36-1.64L12 14l7 7h3v-1L9.64 7.64M6 8a2 2 0 1 1 0-4 2 2 0 0 1 0 4m0 12a2 2 0 1 1 0-4 2 2 0 0 1 0 4M19 3l-3 3 1.5 1.5L22 3h-3Z" />
      </svg>
      <div
        className={`w-px flex-1 transition ${
          isActive
            ? "border-l-2 border-dashed border-mantis-400"
            : "border-l border-dashed border-gray-200 group-hover:border-gray-400"
        }`}
      />
    </button>
  );
}

export default function ThumbnailGrid({
  pdfUrl,
  numPages,
  splitPoints,
  onToggleSplit,
}: ThumbnailGridProps) {
  return (
    <Document file={pdfUrl} loading={null}>
      <div className="flex flex-wrap items-start gap-y-4">
        {Array.from({ length: numPages }, (_, i) => {
          const page = i + 1;
          const isLast = page === numPages;
          return (
            <div key={page} className="flex items-start">
              <div className="w-[200px]">
                <PageThumbnail pageNumber={page} />
              </div>
              {!isLast && (
                <VerticalDivider
                  pageNumber={page}
                  isActive={splitPoints.has(page)}
                  onToggle={onToggleSplit}
                />
              )}
            </div>
          );
        })}
      </div>
    </Document>
  );
}
