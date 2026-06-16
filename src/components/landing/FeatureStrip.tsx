import { motion, useReducedMotion } from "framer-motion";
import { FileCode2, Sigma, Braces, type LucideIcon } from "lucide-react";

interface Feature {
  icon: LucideIcon;
  title: string;
  body: string;
}

const FEATURES: Feature[] = [
  {
    icon: FileCode2,
    title: "Clean Markdown",
    body: "Headings, tables, and lists preserved — not a wall of stripped text.",
  },
  {
    icon: Sigma,
    title: "Perfect LaTeX",
    body: "Inline and display math recovered as compile-ready LaTeX, not images.",
  },
  {
    icon: Braces,
    title: "LLM-ready JSON",
    body: "Structured blocks with positions, ready to chunk and embed for RAG.",
  },
];

export default function FeatureStrip() {
  const reduceMotion = useReducedMotion();
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {FEATURES.map((f, i) => (
        <motion.div
          key={f.title}
          initial={reduceMotion ? false : { opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-40px" }}
          transition={{ duration: 0.4, delay: i * 0.08 }}
          className="rounded-xl border border-zinc-200 bg-white p-5 transition-colors hover:border-zinc-300 dark:border-white/10 dark:bg-white/[0.02] dark:hover:border-white/20"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 text-accent-deep dark:border-white/10 dark:bg-white/[0.03] dark:text-accent">
            <f.icon className="h-5 w-5" strokeWidth={1.5} />
          </div>
          <h3 className="mt-4 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{f.title}</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-zinc-600 dark:text-zinc-500">{f.body}</p>
        </motion.div>
      ))}
    </div>
  );
}
