import JSZip from "jszip";
import type { PdfPart } from "../types/pdf";

export async function downloadAsZip(parts: PdfPart[], baseName: string) {
  const zip = new JSZip();
  for (const part of parts) {
    zip.file(part.name, part.bytes);
  }
  const blob = await zip.generateAsync({ type: "blob" });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${baseName}_split.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
