import ToolGrid from "../components/home/ToolGrid";

export default function HomePage() {
  return (
    <div>
      {/* Gradient hero */}
      <div className="hero-gradient">
        <div className="mx-auto max-w-5xl px-4 pb-12 pt-16 text-center">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-mantis-200 bg-mantis-100 px-3 py-1 text-xs font-semibold text-mantis-700 dark:border-[#222] dark:bg-[#141414] dark:text-mantis-400">
            🔒 Zero uploads · WebAssembly powered
          </div>
          <h1 className="gradient-text text-5xl font-black tracking-tight">
            PDF Tools
          </h1>
          <p className="mt-2 text-2xl font-bold text-gray-900 dark:text-[#e5e5e5]">
            100% Private, 100% Fast
          </p>
          <p className="mx-auto mt-4 max-w-lg text-base leading-relaxed text-gray-500 dark:text-[#555]">
            All processing runs directly in your browser via WebAssembly.
            Your files never leave your device — not even for a millisecond.
          </p>
        </div>
      </div>

      {/* Tool grid */}
      <div className="mx-auto max-w-5xl px-4 py-10">
        <ToolGrid />
      </div>
    </div>
  );
}
