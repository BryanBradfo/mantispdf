import PageImage from "../common/PageImage";

interface PageThumbnailProps {
  source: Blob;
  pageNumber: number;
}

export default function PageThumbnail({ source, pageNumber }: PageThumbnailProps) {
  return (
    <div className="relative">
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm dark:border-[#222] dark:bg-[#141414]">
        <PageImage source={source} page={pageNumber} width={280} alt={`Page ${pageNumber}`} />
        <div className="border-t border-gray-100 px-2 py-1 text-center text-xs text-gray-500 dark:border-[#222] dark:text-[#555]">
          Page {pageNumber}
        </div>
      </div>
    </div>
  );
}
