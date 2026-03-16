const MAX_SIZE = 100 * 1024 * 1024; // 100 MB

export function validatePdfFile(file: File): string | null {
  if (file.type !== "application/pdf") {
    return "Please upload a PDF file.";
  }
  if (file.size > MAX_SIZE) {
    return `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 100 MB.`;
  }
  return null;
}

export function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsArrayBuffer(file);
  });
}

export function readFileAsUint8Array(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsArrayBuffer(file);
  });
}

export function downloadBlob(bytes: Uint8Array, fileName: string) {
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
