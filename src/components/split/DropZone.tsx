import { useCallback, useState } from "react";

interface DropZoneProps {
  onFile: (file: File) => void;
  error: string | null;
}

export default function DropZone({ onFile, error }: DropZoneProps) {
  const [dragging, setDragging] = useState(false);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) onFile(file);
    },
    [onFile],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) onFile(file);
    },
    [onFile],
  );

  return (
    <div>
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-12 transition ${
          dragging
            ? "border-mantis-500 bg-mantis-50"
            : "border-gray-300 bg-white hover:border-mantis-400 hover:bg-mantis-50/50"
        }`}
      >
        <svg
          className="mb-3 h-12 w-12 text-gray-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 16v-8m0 0-3 3m3-3 3 3M4.5 19.5h15A1.5 1.5 0 0 0 21 18V6a1.5 1.5 0 0 0-1.5-1.5h-15A1.5 1.5 0 0 0 3 6v12a1.5 1.5 0 0 0 1.5 1.5Z"
          />
        </svg>
        <p className="text-lg font-medium text-gray-700">
          Drop your PDF here or <span className="text-mantis-600 underline">browse</span>
        </p>
        <p className="mt-1 text-sm text-gray-500">PDF files up to 100 MB</p>
        <input type="file" accept=".pdf,application/pdf" onChange={handleChange} className="hidden" />
      </label>
      {error && (
        <p className="mt-3 text-center text-sm font-medium text-red-600">{error}</p>
      )}
    </div>
  );
}
