import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { PageSEO } from "../components/seo/PageSEO";
import Hero from "../components/landing/Hero";
import Dropzone from "../components/landing/Dropzone";
import ParsingTerminal from "../components/landing/ParsingTerminal";
import FeatureStrip from "../components/landing/FeatureStrip";
import Workspace from "../components/landing/Workspace";
import ToolGrid from "../components/home/ToolGrid";

type Status = "idle" | "parsing" | "workspace";

// Used when the user hits "Parse a PDF" without dropping their own file. Served
// statically from public/ (see scripts/make-sample-pdf.mjs); its content
// mirrors the mock Markdown/LaTeX in Workspace for a seamless demo.
const SAMPLE_DOC = "poisson-pinns.pdf";
const SAMPLE_URL = "/sample-paper.pdf";

export default function HomePage() {
  const [status, setStatus] = useState<Status>("idle");
  const [fileName, setFileName] = useState<string>(SAMPLE_DOC);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [runId, setRunId] = useState(0);
  const extractRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  // Track the live object URL so we can revoke exactly one (avoids leaks when
  // a second file is dropped before the first workspace is closed).
  const objUrl = useRef<string | null>(null);

  const revokeUrl = useCallback(() => {
    if (objUrl.current) {
      URL.revokeObjectURL(objUrl.current);
      objUrl.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
      revokeUrl();
    };
  }, [revokeUrl]);

  const scrollToExtract = useCallback(() => {
    extractRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  // Simulated extraction: replay the terminal logs, then reveal the workspace.
  // The 2s stub stands in for the Rust/WASM engine that's still in development.
  // `source` is a dropped File (blob URL, revoked on cleanup) or a static URL
  // string for the bundled sample (must NOT be revoked).
  const startParse = useCallback(
    (name: string, source?: File | string) => {
      revokeUrl();
      let url: string | null = null;
      if (source instanceof File) {
        url = URL.createObjectURL(source);
        objUrl.current = url; // track so we revoke exactly this blob URL
      } else if (typeof source === "string") {
        url = source; // static asset from public/, not an object URL
      }
      setPdfUrl(url);
      setFileName(name);
      setRunId((n) => n + 1);
      setStatus("parsing");
      scrollToExtract();
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        setStatus("workspace");
        window.scrollTo({ top: 0, behavior: "auto" });
      }, 2000);
    },
    [revokeUrl, scrollToExtract],
  );

  const reset = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    revokeUrl();
    setPdfUrl(null);
    setStatus("idle");
  }, [revokeUrl]);

  return (
    <div className="landing-bg relative min-h-screen overflow-hidden text-zinc-900 dark:text-zinc-100">
      <PageSEO
        title="MantisPDF: PDF to Markdown & LaTeX for LLMs"
        description="The developer-first document parser. Turn complex research papers into clean Markdown and perfect LaTeX, LLM-ready in milliseconds. Runs in your browser."
        path="/"
      />

      <AnimatePresence mode="wait">
        {status === "workspace" ? (
          <Workspace
            key="workspace"
            fileName={fileName}
            pdfUrl={pdfUrl}
            onReset={reset}
          />
        ) : (
          <motion.div
            key="landing"
            initial={false}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
          >
            {/* Ambient background layers (non-interactive). */}
            <div className="grid-backdrop pointer-events-none absolute inset-0" aria-hidden />
            <div className="accent-bloom pointer-events-none absolute inset-x-0 top-0 h-[640px]" aria-hidden />

            <div className="relative mx-auto max-w-5xl px-4 pb-28 pt-16 sm:pt-24">
              <Hero onUploadClick={() => startParse(SAMPLE_DOC, SAMPLE_URL)} />

              {/* Interactive core: dropzone + live parsing terminal. */}
              <div ref={extractRef} className="mx-auto mt-12 max-w-2xl scroll-mt-24">
                <Dropzone
                  onFile={(file) => startParse(file.name, file)}
                  acceptedName={status === "parsing" ? fileName : null}
                  isParsing={status === "parsing"}
                />
                <ParsingTerminal fileName={fileName} runId={runId} className="mt-3" />
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
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
