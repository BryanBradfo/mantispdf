import { useRef, type CSSProperties } from "react";
import { useThumbnail, type RenderMode } from "../../lib/thumbnails";
import { useT } from "../../i18n";

interface PageImageProps {
  source: Blob | Uint8Array;
  page: number;
  width: number;
  alt: string;
  imgStyle?: CSSProperties;
  className?: string;
  /** "no-widgets" leaves out form field appearances (for a page under live form controls). */
  mode?: RenderMode;
}

export default function PageImage({ source, page, width, alt, imgStyle, className = "", mode = "full" }: PageImageProps) {
  const t = useT("common");
  const ref = useRef<HTMLDivElement>(null);
  const thumb = useThumbnail(source, page, width, ref, mode);

  return (
    <div
      ref={ref}
      className={`relative flex aspect-[8.5/11] w-full items-center justify-center overflow-hidden bg-surface ${className}`}
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
          aria-label={t("previewLoading")}
          className="h-6 w-6 animate-spin rounded-full border-2 border-ink-3 border-t-transparent"
        />
      )}
      {thumb.status === "error" && (
        <svg viewBox="0 0 80 100" className="h-20 w-16 text-line-strong" fill="none" role="img" aria-label={t("previewUnavailable")}>
          <path d="M4 4 H58 L76 22 V96 H4 Z" className="fill-paper" stroke="currentColor" strokeWidth="1.5" />
          <path d="M58 4 L58 22 L76 22" className="fill-surface" stroke="currentColor" strokeWidth="1.5" />
          <line x1="14" y1="38" x2="66" y2="38" stroke="currentColor" strokeWidth="2" />
          <line x1="14" y1="50" x2="66" y2="50" stroke="currentColor" strokeWidth="2" />
          <line x1="14" y1="62" x2="55" y2="62" stroke="currentColor" strokeWidth="2" />
        </svg>
      )}
    </div>
  );
}
