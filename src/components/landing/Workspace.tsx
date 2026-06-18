import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { motion } from "framer-motion";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import {
  ArrowLeft,
  Check,
  Code2,
  Copy,
  Download,
  Eye,
  FileText,
  Loader2,
  Sigma,
  TriangleAlert,
} from "lucide-react";

// react-pdf is heavy; load the preview only when a workspace actually mounts,
// keeping it out of the landing page's initial bundle.
const PdfPreview = lazy(() => import("./PdfPreview"));

interface WorkspaceProps {
  /** Name of the "parsed" document, shown as the source label. */
  fileName: string;
  /** Blob URL of the uploaded PDF, or null for the sample (no real file). */
  pdfUrl: string | null;
  /** Integrated Markdown (Stage-1 text + stitched LaTeX). Null → mock content. */
  extractedText?: string | null;
  /** The recognized LaTeX equations, joined, for the LaTeX tab. */
  latex?: string | null;
  /** Error message if extraction failed/returned empty. */
  extractError?: string | null;
  /** Count of math regions flagged by the Stage-2 heuristic (desktop). */
  mathRegionCount?: number | null;
  /** Return to the landing / dropzone. */
  onReset: () => void;
}

type Tab = "markdown" | "latex";
type ViewMode = "code" | "preview";

// ── Placeholder output for the web (non-Tauri) demo ──────────────────────────
// On the web there is no local extraction engine, so the workspace shows this
// sample Markdown/LaTeX. The desktop (Tauri) build replaces it with the real
// integrated `markdown` returned by `extract_document`.
const MOCK_MARKDOWN = `# Physics-Informed Neural Networks for the Poisson Equation

**A. Mantis · B. Chen** — MantisPDF Research

## Abstract

We study physics-informed neural networks (PINNs) for solving the Poisson
equation on a bounded domain $\\Omega \\subset \\mathbb{R}^2$. The network
$u_\\theta$ is trained to satisfy the PDE residual together with the boundary
data, removing the need for a meshed solver.

## 2. Method

We seek $u_\\theta$ approximating the solution of the Poisson problem:

$$
-\\Delta u(x) = f(x), \\quad x \\in \\Omega, \\qquad u(x) = g(x), \\quad x \\in \\partial\\Omega.
$$

The composite training objective combines a data term and a PDE residual:

$$
\\mathcal{L}(\\theta) = \\mathcal{L}_{\\text{data}}(\\theta) + \\lambda \\, \\mathcal{L}_{\\text{pde}}(\\theta),
$$

where the residual is evaluated at $N_r$ collocation points:

$$
\\mathcal{L}_{\\text{pde}}(\\theta) = \\frac{1}{N_r} \\sum_{i=1}^{N_r} \\left| \\Delta u_\\theta(x_i) + f(x_i) \\right|^2 .
$$

Minimizing $\\mathcal{L}(\\theta)$ drives the network toward a solution that is
consistent with both the observed data and the governing equation, while the
weight $\\lambda$ balances the two terms.
`;

const MOCK_LATEX = `\\documentclass{article}
\\usepackage{amsmath, amssymb}

\\title{Physics-Informed Neural Networks for the Poisson Equation}
\\author{A. Mantis \\and B. Chen}

\\begin{document}
\\maketitle

\\begin{abstract}
We study physics-informed neural networks (PINNs) for solving the Poisson
equation on a bounded domain $\\Omega \\subset \\mathbb{R}^2$. The network
$u_\\theta$ is trained to satisfy the PDE residual together with the boundary
data, removing the need for a meshed solver.
\\end{abstract}

\\section{Method}

We seek $u_\\theta$ approximating the solution of the Poisson problem:
\\begin{equation}
  -\\Delta u(x) = f(x), \\quad x \\in \\Omega,
  \\qquad u(x) = g(x), \\quad x \\in \\partial\\Omega.
\\end{equation}

The composite training objective combines a data term and a PDE residual:
\\begin{equation}
  \\mathcal{L}(\\theta) = \\mathcal{L}_{\\text{data}}(\\theta)
    + \\lambda \\, \\mathcal{L}_{\\text{pde}}(\\theta),
\\end{equation}

where the residual is evaluated at $N_r$ collocation points:
\\begin{equation}
  \\mathcal{L}_{\\text{pde}}(\\theta)
    = \\frac{1}{N_r} \\sum_{i=1}^{N_r}
      \\left| \\Delta u_\\theta(x_i) + f(x_i) \\right|^2 .
\\end{equation}

\\end{document}
`;

// Lightweight display-only highlighter: backslash commands, math delimiters,
// and braces get tinted; markdown headings render bold. Not a real parser —
// just enough color to read as a code editor.
function renderTokens(line: string) {
  const parts = line.split(/(\\[a-zA-Z]+|\$\$|\$|[{}]|\*\*|`)/g);
  return parts.map((p, i) => {
    if (!p) return null;
    let cls = "";
    if (/^\\[a-zA-Z]+$/.test(p)) cls = "text-sky-600 dark:text-sky-300";
    else if (p === "$$" || p === "$") cls = "text-amber-600 dark:text-amber-300";
    else if (p === "{" || p === "}") cls = "text-zinc-400 dark:text-zinc-500";
    else if (p === "**" || p === "`") cls = "text-zinc-400 dark:text-zinc-600";
    return (
      <span key={i} className={cls}>
        {p}
      </span>
    );
  });
}

function renderLine(line: string, lang: Tab) {
  if (lang === "markdown" && /^#{1,6}\s/.test(line)) {
    return (
      <span className="font-semibold text-zinc-900 dark:text-zinc-100">{line}</span>
    );
  }
  return renderTokens(line);
}

function downloadText(name: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function Workspace({
  fileName,
  pdfUrl,
  extractedText,
  latex,
  extractError,
  mathRegionCount,
  onReset,
}: WorkspaceProps) {
  const [tab, setTab] = useState<Tab>("markdown");
  // Default to the rendered Preview so the OCR'd math is visible at a glance;
  // the Code view stays one click away for copy/verification. LaTeX tab is
  // always raw (it's a .tex source, not renderable as a Markdown document).
  const [view, setView] = useState<ViewMode>("preview");
  const [copied, setCopied] = useState(false);

  const showPreview = tab === "markdown" && view === "preview";

  // For a real document the backend returns integrated Markdown (Stage 1 text +
  // stitched LaTeX) and the recognized equations; the sample/web demo falls back
  // to the mock content.
  const hasReal = Boolean(extractedText && extractedText.trim());
  const markdownContent = hasReal ? (extractedText as string) : MOCK_MARKDOWN;
  const latexContent = hasReal
    ? latex && latex.trim()
      ? latex
      : "% No equations were detected in this document."
    : MOCK_LATEX;
  const content = tab === "markdown" ? markdownContent : latexContent;
  const lines = useMemo(() => content.split("\n"), [content]);
  const baseName = fileName.replace(/\.pdf$/i, "") || "document";
  const ext = tab === "markdown" ? ".md" : ".tex";

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (e.g. insecure context) — no-op */
    }
  }, [content]);

  const exportFile = useCallback(() => {
    downloadText(`${baseName}${ext}`, content);
  }, [baseName, ext, content]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="relative z-10 grid grid-cols-1 lg:h-[calc(100vh-4rem)] lg:grid-cols-2"
    >
      {/* ── Left: source document ─────────────────────────────────────────── */}
      <section className="flex h-[55vh] min-h-0 flex-col lg:h-auto">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-2.5 dark:border-white/10">
          <div className="flex items-center gap-2">
            <button
              onClick={onReset}
              aria-label="Parse another document"
              className="flex h-7 w-7 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-500 transition-colors hover:text-zinc-900 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-400 dark:hover:text-white"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-500">
              Source Document
            </span>
            {/* Temporary Stage-2 indicator: how many math blocks the heuristic flagged. */}
            {typeof mathRegionCount === "number" && (
              <span
                title="Potential math regions detected (Stage-2 heuristic)"
                className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 font-mono text-[10px] text-accent-deep dark:text-accent"
              >
                <Sigma className="h-3 w-3" />
                {mathRegionCount} math
              </span>
            )}
          </div>
          <span className="max-w-[45%] truncate font-mono text-xs text-zinc-500 dark:text-zinc-400">
            {fileName}
          </span>
        </div>

        <div className="min-h-0 flex-1">
          {pdfUrl ? (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center bg-zinc-100 dark:bg-black/50">
                  <Loader2 className="h-7 w-7 animate-spin text-accent-deep dark:text-accent" />
                </div>
              }
            >
              <PdfPreview url={pdfUrl} />
            </Suspense>
          ) : (
            // No real file (e.g. the "Parse a PDF" sample) — show an empty state.
            <div className="flex h-full items-center justify-center bg-zinc-100/60 p-6 dark:bg-black/40">
              <div className="flex w-full max-w-sm flex-col items-center gap-3 rounded-xl border border-dashed border-zinc-300 px-6 py-16 text-center dark:border-white/10">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-zinc-200 bg-white text-zinc-400 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-500">
                  <FileText className="h-6 w-6" strokeWidth={1.5} />
                </div>
                <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">
                  No document to preview
                </p>
                <p className="text-xs text-zinc-400 dark:text-zinc-600">
                  Drop a PDF on the home page to see it rendered here.
                </p>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ── Right: extracted code ─────────────────────────────────────────── */}
      <section className="flex h-[70vh] min-h-0 flex-col border-t border-zinc-200 bg-white dark:border-white/10 dark:bg-[#0b0b0b] lg:h-auto lg:border-l lg:border-t-0">
        <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-2 py-1.5 dark:border-white/10">
          {/* Tabs */}
          <div className="flex items-center gap-1">
            {(["markdown", "latex"] as Tab[]).map((t) => {
              const active = tab === t;
              return (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`relative rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    active
                      ? "text-zinc-900 dark:text-zinc-100"
                      : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-500 dark:hover:text-zinc-300"
                  }`}
                >
                  {t === "markdown" ? "Markdown" : "LaTeX"}
                  {active && (
                    <motion.span
                      layoutId="tab-underline"
                      className="absolute inset-x-2 -bottom-[7px] h-0.5 rounded-full bg-accent"
                    />
                  )}
                </button>
              );
            })}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 pr-1">
            {/* Code / Preview toggle — Markdown only (LaTeX stays raw source). */}
            {tab === "markdown" && (
              <div className="flex items-center rounded-md border border-zinc-200 bg-zinc-100/70 p-0.5 dark:border-white/10 dark:bg-white/[0.03]">
                {(
                  [
                    ["preview", "Preview", Eye],
                    ["code", "Code", Code2],
                  ] as [ViewMode, string, typeof Eye][]
                ).map(([mode, label, Icon]) => {
                  const active = view === mode;
                  return (
                    <button
                      key={mode}
                      onClick={() => setView(mode)}
                      aria-pressed={active}
                      className={`relative inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
                        active
                          ? "text-zinc-900 dark:text-zinc-100"
                          : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-500 dark:hover:text-zinc-300"
                      }`}
                    >
                      {active && (
                        <motion.span
                          layoutId="view-toggle-pill"
                          className="absolute inset-0 rounded bg-white shadow-sm dark:bg-white/10"
                          transition={{ type: "spring", stiffness: 400, damping: 32 }}
                        />
                      )}
                      <Icon className="relative z-10 h-3.5 w-3.5" />
                      <span className="relative z-10 hidden sm:inline">{label}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <button
              onClick={copy}
              className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:text-zinc-900 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-300 dark:hover:text-white"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-accent-deep dark:text-accent" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
            </button>
            <button
              onClick={exportFile}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-xs font-semibold text-black shadow-glow transition-all hover:bg-accent-soft hover:shadow-glow-lg"
            >
              <Download className="h-3.5 w-3.5" />
              Export {ext}
            </button>
          </div>
        </div>

        {/* Render surface: error → rendered Preview → raw Code */}
        <div className="min-h-0 flex-1 overflow-auto bg-white dark:bg-[#0b0b0b]">
          {extractError ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center font-sans">
              <TriangleAlert className="h-8 w-8 text-amber-500" strokeWidth={1.5} />
              <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
                Extraction failed
              </p>
              <p className="max-w-sm text-xs text-zinc-500 dark:text-zinc-500">{extractError}</p>
            </div>
          ) : showPreview ? (
            <div className="md-preview px-5 py-4">
              <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
                {markdownContent}
              </ReactMarkdown>
            </div>
          ) : (
          <div className="py-3 font-mono text-[13px] leading-relaxed">
            {lines.map((line, i) => (
              <div
                key={i}
                className="grid grid-cols-[3rem_1fr] hover:bg-zinc-50 dark:hover:bg-white/[0.02]"
              >
                <span className="select-none pr-3 text-right text-zinc-300 dark:text-zinc-700">
                  {i + 1}
                </span>
                <span className="whitespace-pre-wrap break-words pr-4 text-zinc-700 dark:text-zinc-300">
                  {line.length ? renderLine(line, tab) : " "}
                </span>
              </div>
            ))}
          </div>
          )}
        </div>
      </section>
    </motion.div>
  );
}
