import PageImage from "../common/PageImage";
import { useT } from "../../i18n";

interface PageThumbnailProps {
  source: Blob;
  pageNumber: number;
}

export default function PageThumbnail({ source, pageNumber }: PageThumbnailProps) {
  const t = useT("common");
  return (
    <div className="relative">
      <div className="overflow-hidden border border-line bg-surface">
        <PageImage source={source} page={pageNumber} width={280} alt={t("pageN", { n: pageNumber })} />
        <div className="border-t border-line px-2 py-1.5 text-center font-mono text-[11px] uppercase tracking-[0.08em] text-ink-2">
          {t("pageN", { n: pageNumber })}
        </div>
      </div>
    </div>
  );
}
