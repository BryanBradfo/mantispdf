export function validatePdfFile(file: File): string | null {
  if (file.type !== "application/pdf") {
    return "Please upload a PDF file.";
  }
  return null;
}

export function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
      } else {
        reject(new Error("Failed to read file: unexpected result type"));
      }
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.onabort = () => reject(new Error("File read was aborted"));
    reader.readAsArrayBuffer(file);
  });
}

export function readFileAsUint8Array(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(new Uint8Array(reader.result));
      } else {
        reject(new Error("Failed to read file: unexpected result type"));
      }
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.onabort = () => reject(new Error("File read was aborted"));
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
