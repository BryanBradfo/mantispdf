import { useCallback, useRef, useState } from "react";
import { PageSEO } from "../components/seo/PageSEO";
import Hero from "../components/landing/Hero";
import Dropzone from "../components/landing/Dropzone";
import ParsingTerminal from "../components/landing/ParsingTerminal";
import FeatureStrip from "../components/landing/FeatureStrip";
import ToolGrid from "../components/home/ToolGrid";

export default function HomePage() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [runId, setRunId] = useState(0);
  const extractRef = useRef<HTMLDivElement>(null);

  const scrollToExtract = useCallback(() => {
    extractRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const handleFile = useCallback(
    (file: File) => {
      // Feed the real filename into the terminal and replay the extraction.
      setFileName(file.name);
      setRunId((n) => n + 1);
      scrollToExtract();
    },
    [scrollToExtract],
  );

  return (
    <div className="landing-bg relative min-h-screen overflow-hidden text-zinc-900 dark:text-zinc-100">
      <PageSEO
        title="MantisPDF: PDF to Markdown & LaTeX for LLMs"
        description="The developer-first document parser. Turn complex research papers into clean Markdown and perfect LaTeX, LLM-ready in milliseconds. Runs in your browser."
        path="/"
      />

      {/* Ambient background layers (non-interactive). */}
      <div className="grid-backdrop pointer-events-none absolute inset-0" aria-hidden />
      <div className="accent-bloom pointer-events-none absolute inset-x-0 top-0 h-[640px]" aria-hidden />

      <div className="relative mx-auto max-w-5xl px-4 pb-28 pt-16 sm:pt-24">
        <Hero onUploadClick={scrollToExtract} />

        {/* Interactive core: dropzone + live parsing terminal. */}
        <div ref={extractRef} className="mx-auto mt-12 max-w-2xl scroll-mt-24">
          <Dropzone onFile={handleFile} acceptedName={fileName} />
          <ParsingTerminal
            fileName={fileName ?? undefined}
            runId={runId}
            className="mt-3"
          />
        </div>

        <div className="mt-20">
          <FeatureStrip />
        </div>

        {/* The existing client-side toolkit, kept fully accessible. */}
        <section className="mt-24">
          <div className="max-w-2xl">
            <h2 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
              PDF Tools
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-500">
              The full client-side toolkit. Split, merge, compress, and more,
              still free and still private, running entirely in your browser.
            </p>
          </div>
          <div className="mt-8">
            <ToolGrid />
          </div>
        </section>
      </div>
    </div>
  );
}
