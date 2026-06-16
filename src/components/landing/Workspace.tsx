import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, Check, Copy, Download, FileText, Loader2 } from "lucide-react";

// react-pdf is heavy; load the preview only when a workspace actually mounts,
// keeping it out of the landing page's initial bundle.
const PdfPreview = lazy(() => import("./PdfPreview"));

interface WorkspaceProps {
  /** Name of the "parsed" document, shown as the source label. */
  fileName: string;
  /** Blob URL of the uploaded PDF, or null for the sample (no real file). */
  pdfUrl: string | null;
  /** Return to the landing / dropzone. */
  onReset: () => void;
}

type Tab = "markdown" | "latex";

// ── Mock extraction output (the real WASM engine will replace this) ──────────
const MOCK_MARKDOWN = `# Attention Is All You Need

## 3.2 Scaled Dot-Product Attention

We compute the attention over a set of queries packed into a matrix $Q$.
The keys and values are packed into matrices $K$ and $V$:

$$
\\mathrm{Attention}(Q, K, V) = \\mathrm{softmax}\\!\\left(
  \\frac{Q K^{\\top}}{\\sqrt{d_k}}
\\right) V
$$

## 4. Physics-Informed Objective

The total training loss combines a **data** term with a **PDE residual**:

$$
\\mathcal{L}_{\\text{PINN}} = \\mathcal{L}_{\\text{data}} + \\lambda \\, \\mathcal{L}_{\\text{PDE}}
$$

| Symbol      | Meaning                    |
| ----------- | -------------------------- |
| $\\lambda$   | PDE regularization weight  |
| $d_k$       | key / query dimension      |
`;

const MOCK_LATEX = `\\documentclass{article}
\\usepackage{amsmath, amssymb}

\\begin{document}

\\section{Scaled Dot-Product Attention}

\\begin{equation}
  \\mathrm{Attention}(Q, K, V)
    = \\mathrm{softmax}\\!\\left(
        \\frac{Q K^{\\top}}{\\sqrt{d_k}}
      \\right) V
\\end{equation}

\\section{Physics-Informed Objective}

\\begin{equation}
  \\mathcal{L}_{\\text{PINN}}
    = \\mathcal{L}_{\\text{data}}
    + \\lambda \\, \\mathcal{L}_{\\text{PDE}}
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

export default function Workspace({ fileName, pdfUrl, onReset }: WorkspaceProps) {
  const [tab, setTab] = useState<Tab>("markdown");
  const [copied, setCopied] = useState(false);

  const content = tab === "markdown" ? MOCK_MARKDOWN : MOCK_LATEX;
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
          </div>
          <span className="max-w-[55%] truncate font-mono text-xs text-zinc-500 dark:text-zinc-400">
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

        {/* Code surface */}
        <div className="min-h-0 flex-1 overflow-auto bg-white font-mono text-[13px] leading-relaxed dark:bg-[#0b0b0b]">
          <div className="py-3">
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
        </div>
      </section>
    </motion.div>
  );
}
