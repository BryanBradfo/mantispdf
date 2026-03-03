import { useState } from "react";
import { Thumbnail } from "react-pdf";

interface PageThumbnailProps {
  pageNumber: number;
}

export default function PageThumbnail({ pageNumber }: PageThumbnailProps) {
  const [loaded, setLoaded] = useState(false);

  return (
    <div className="relative">
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        <div className="relative aspect-[8.5/11] w-full bg-gray-100">
          <Thumbnail
            pageNumber={pageNumber}
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
        <div className="border-t border-gray-100 px-2 py-1 text-center text-xs text-gray-500">
          Page {pageNumber}
        </div>
      </div>

    </div>
  );
}
