import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Sparkles } from "lucide-react";
import { PageSEO } from "../components/seo/PageSEO";
import Hero from "../components/landing/Hero";
import Dropzone from "../components/landing/Dropzone";
import ParsingTerminal from "../components/landing/ParsingTerminal";
import FeatureStrip from "../components/landing/FeatureStrip";
import Workspace from "../components/landing/Workspace";
import ToolGrid from "../components/home/ToolGrid";
import LicenseDialog from "../components/license/LicenseDialog";
import { useLicense, CHECKOUT_URL } from "../hooks/useLicense";

type Status = "idle" | "parsing" | "workspace";

/** One recognized math region, mirrors the Rust `MathOut`. */
interface MathOut {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
  latex: string;
}

/** JSON returned by the Rust `extract_document` command (Stage 1→3). */
interface ExtractResponse {
  /** Stage-1 text with recognized LaTeX stitched inline. */
  markdown: string;
  /** Raw Stage-1 text (no LaTeX). */
  text: string;
  /** Every recognized math region. */
  math: MathOut[];
}

function isPdf(file: File): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

// Desktop-only: run the real extraction in the Tauri Rust backend. The PDF is
// sent as raw bytes (a browser-picked/dropped File has no filesystem path)
// straight into LiteParse's PdfInput::Bytes. Throws on failure; the caller
// handles the error/empty states.
async function callExtract(file: File): Promise<ExtractResponse> {
  const buf = await file.arrayBuffer();
  // Plain number[] keeps it simple; for large PDFs switch to a raw IPC body.
  const bytes = Array.from(new Uint8Array(buf));
  const json = await invoke<string>("extract_document", { bytes });
  return JSON.parse(json) as ExtractResponse;
}

export default function HomePage() {
  const license = useLicense();
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [fileName, setFileName] = useState<string>("");
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  // Hidden file input behind the Hero's "Parse a PDF" button (browse-to-upload).
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [runId, setRunId] = useState(0);
  // Real extraction results (desktop/Tauri only). Null on web, where the mock
  // content is shown instead.
  // Integrated Markdown (Stage-1 text + stitched LaTeX) from the Rust backend.
  const [extractedText, setExtractedText] = useState<string | null>(null);
  // The recognized equations, joined, for the LaTeX tab.
  const [mathLatex, setMathLatex] = useState<string | null>(null);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [mathCount, setMathCount] = useState<number | null>(null);
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

  // Parse a user-provided PDF (from the file picker or drag-and-drop): show the
  // rendered PDF, then reveal the workspace once extraction completes.
  const startParse = useCallback(
    (file: File) => {
      revokeUrl();
      const url = URL.createObjectURL(file);
      objUrl.current = url; // track so we revoke exactly this blob URL
      setPdfUrl(url);
      setFileName(file.name);
      setRunId((n) => n + 1);
      setStatus("parsing");
      scrollToExtract();
      if (timer.current) window.clearTimeout(timer.current);

      const reveal = () => {
        setStatus("workspace");
        window.scrollTo({ top: 0, behavior: "auto" });
      };

      if (isTauri()) {
        // Desktop: run the real Rust extraction (Stages 1→3), then reveal.
        setExtractedText(null);
        setMathLatex(null);
        setExtractError(null);
        setMathCount(null);
        callExtract(file)
          .then((res) => {
            if (!res.text?.trim()) {
              setExtractError("No text could be extracted from this document.");
              return;
            }
            // The backend already ran Stages 2+3: detect math, OCR, and stitch
            // the LaTeX into `markdown`. We just render its results.
            setExtractedText(res.markdown);
            setMathLatex(res.math.map((m) => m.latex).join("\n\n"));
            setMathCount(res.math.length);
          })
          .catch((err) => setExtractError(String(err)))
          .finally(reveal);
      } else {
        // Web: no Tauri backend — keep the simulated 2s loading.
        timer.current = window.setTimeout(reveal, 2000);
      }
    },
    [revokeUrl, scrollToExtract],
  );

  const reset = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    revokeUrl();
    setPdfUrl(null);
    setExtractedText(null);
    setMathLatex(null);
    setExtractError(null);
    setMathCount(null);
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
            extractedText={extractedText}
            latex={mathLatex}
            extractError={extractError}
            mathRegionCount={mathCount}
            locked={license.locked}
            onUpgrade={() => setLicenseOpen(true)}
            onReset={reset}
          />
        ) : (
          <motion.div
            key="landing"
            initial={false}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
          >
            {/* Desktop-only license entry point (web is a free demo). */}
            {license.onDesktop && (
              <button
                onClick={() => setLicenseOpen(true)}
                className="absolute right-4 top-4 z-20 inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white/70 px-3 py-1.5 text-xs font-medium text-zinc-700 backdrop-blur transition-colors hover:border-zinc-300 hover:text-zinc-900 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-300 dark:hover:border-white/20 dark:hover:text-white"
              >
                <Sparkles className="h-3.5 w-3.5 text-accent-deep dark:text-accent" />
                {license.isPro ? "Pro" : "Upgrade to Pro"}
              </button>
            )}

            {/* Ambient background layers (non-interactive). */}
            <div className="grid-backdrop pointer-events-none absolute inset-0" aria-hidden />
            <div className="accent-bloom pointer-events-none absolute inset-x-0 top-0 h-[640px]" aria-hidden />

            <div className="relative mx-auto max-w-5xl px-4 pb-28 pt-16 sm:pt-24">
              <Hero onUploadClick={() => fileInputRef.current?.click()} />

              {/* Hidden picker for the Hero "Parse a PDF" button (browse-to-upload). */}
              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf,.pdf"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = ""; // allow re-picking the same file
                  if (file && isPdf(file)) startParse(file);
                }}
              />

              {/* Interactive core: dropzone + live parsing terminal. */}
              <div ref={extractRef} className="mx-auto mt-12 max-w-2xl scroll-mt-24">
                <Dropzone
                  onFile={(file) => startParse(file)}
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

      <LicenseDialog
        open={licenseOpen}
        onClose={() => setLicenseOpen(false)}
        status={license.status}
        onActivate={license.activate}
        onDeactivate={license.deactivate}
        checkoutUrl={CHECKOUT_URL}
      />
    </div>
  );
}
