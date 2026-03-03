import ToolGrid from "../components/home/ToolGrid";

export default function HomePage() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-12">
      <div className="mb-10 text-center">
        <h1 className="text-4xl font-bold text-gray-900">PDF Tools — 100% Private</h1>
        <p className="mt-3 text-lg text-gray-600">
          All processing runs in your browser via WebAssembly. Your files never leave your device.
        </p>
      </div>
      <ToolGrid />
    </div>
  );
}
