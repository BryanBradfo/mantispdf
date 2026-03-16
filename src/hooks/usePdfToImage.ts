import { useCallback, useState } from "react";
import { pdfjs } from "react-pdf";

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
  const [error, setError] = useState<string | null>(null);

  const convertPdfToImages = useCallback(
    async (file: File, { format, scale, onProgress }: ConvertOptions): Promise<ImagePart[]> => {
      setConverting(true);
      setError(null);
      try {
        const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
        const parts: ImagePart[] = [];
        const baseName = file.name.replace(/\.pdf$/i, "");
        const ext = format === "png" ? "png" : "jpg";
        const mimeType = format === "png" ? "image/png" : "image/jpeg";

        for (let i = 1; i <= pdf.numPages; i++) {
          onProgress(i - 1, pdf.numPages);
          const page = await pdf.getPage(i);
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          await page.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;
          const blob = await new Promise<Blob>((res, rej) =>
            canvas.toBlob(
              (b) => (b ? res(b) : rej(new Error("toBlob failed"))),
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
        setError(String(err));
        throw err;
      } finally {
        setConverting(false);
      }
    },
    [],
  );

  return { converting, error, setError, convertPdfToImages };
}
