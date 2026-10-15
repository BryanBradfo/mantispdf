import { useRef, type CSSProperties } from "react";
import { useThumbnail } from "../../lib/thumbnails";

interface PageImageProps {
  source: Blob | Uint8Array;
  page: number;
  width: number;
  alt: string;
  imgStyle?: CSSProperties;
  className?: string;
}

export default function PageImage({ source, page, width, alt, imgStyle, className = "" }: PageImageProps) {
  const ref = useRef<HTMLDivElement>(null);
  const thumb = useThumbnail(source, page, width, ref);

  return (
    <div
      ref={ref}
      className={`relative flex aspect-[8.5/11] w-full items-center justify-center overflow-hidden bg-gray-50 dark:bg-[#1a1a1a] ${className}`}
    >
      {thumb.status === "ready" && (
        <img
          src={thumb.url}
          alt={alt}
          data-thumb="ready"
          draggable={false}
          style={imgStyle}
          className="h-full w-full select-none object-contain"
        />
      )}
      {thumb.status === "loading" && (
        <div
          role="status"
          aria-label="Loading preview"
          className="h-6 w-6 animate-spin rounded-full border-2 border-mantis-300 border-t-transparent motion-reduce:animate-none"
        />
      )}
      {thumb.status === "error" && (
        <svg viewBox="0 0 80 100" className="h-20 w-16 drop-shadow-sm" fill="none" role="img" aria-label="Preview unavailable">
          <path d="M4 4 H58 L76 22 V96 H4 Z" fill="white" stroke="#e5e7eb" strokeWidth="1.5" className="dark:fill-[#1e1e1e] dark:stroke-[#333]" />
          <path d="M58 4 L58 22 L76 22" fill="#f3f4f6" stroke="#e5e7eb" strokeWidth="1.5" className="dark:fill-[#2a2a2a] dark:stroke-[#333]" />
          <line x1="14" y1="38" x2="66" y2="38" stroke="#d1d5db" strokeWidth="2.5" strokeLinecap="round" className="dark:stroke-[#333]" />
          <line x1="14" y1="50" x2="66" y2="50" stroke="#d1d5db" strokeWidth="2.5" strokeLinecap="round" className="dark:stroke-[#333]" />
          <line x1="14" y1="62" x2="55" y2="62" stroke="#d1d5db" strokeWidth="2.5" strokeLinecap="round" className="dark:stroke-[#333]" />
        </svg>
      )}
    </div>
  );
}
