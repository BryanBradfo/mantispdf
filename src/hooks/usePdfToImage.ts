import { useCallback, useState } from "react";
import { pdfjs } from "../lib/pdf";
import { UserError, useDescribeError, useT, type UiError } from "../i18n";

export type ImageFormat = "png" | "jpeg";
export type RenderScale = 1 | 2 | 3 | 4 | 5;

export interface ImagePart {
  name: string;
  blob: Blob;
}

interface ConvertOptions {
  format: ImageFormat;
  scale: RenderScale;
  onProgress: (current: number, total: number) => void;
}

export function usePdfToImage() {
  const [converting, setConverting] = useState(false);
  const t = useT("pdfToImage");
  const describe = useDescribeError();
  const [error, setError] = useState<UiError | null>(null);

  const convertPdfToImages = useCallback(
    async (file: File, { format, scale, onProgress }: ConvertOptions): Promise<ImagePart[]> => {
      setConverting(true);
      setError(null);
      // Reuse a single canvas across pages (resized per page) instead of leaking
      // one large canvas per page. The pdf.js document is destroyed in finally.
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        setConverting(false);
        throw new UserError(t("noCanvas"));
      }
      let pdf: Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]> | null = null;
      try {
        pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
        const parts: ImagePart[] = [];
        const baseName = file.name.replace(/\.pdf$/i, "");
        const ext = format === "png" ? "png" : "jpg";
        const mimeType = format === "png" ? "image/png" : "image/jpeg";

        for (let i = 1; i <= pdf.numPages; i++) {
          onProgress(i - 1, pdf.numPages);
          const page = await pdf.getPage(i);
          const viewport = page.getViewport({ scale });
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          await page.render({ canvasContext: ctx, viewport }).promise;
          const blob = await new Promise<Blob>((res, rej) =>
            canvas.toBlob(
              (b) => (b ? res(b) : rej(new UserError(t("renderFailed")))),
              mimeType,
              format === "jpeg" ? 0.92 : undefined,
            ),
          );
          parts.push({ name: `${baseName}_page_${i}.${ext}`, blob });
          page.cleanup();
        }

        onProgress(pdf.numPages, pdf.numPages);
        return parts;
      } catch (err) {
        setError(describe(err));
        throw err;
      } finally {
        // Release pdf.js worker-side resources and the canvas backing store.
        await pdf?.destroy();
        canvas.width = 0;
        canvas.height = 0;
        setConverting(false);
      }
    },
    [t, describe],
  );

  return { converting, error, setError, convertPdfToImages };
}
