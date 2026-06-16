import { motion } from "framer-motion";
import { ArrowDown, Star } from "lucide-react";

interface HeroProps {
  /** Scrolls to / focuses the dropzone. */
  onUploadClick?: () => void;
}

const fade = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0 },
};

export default function Hero({ onUploadClick }: HeroProps) {
  return (
    <motion.div
      initial="hidden"
      animate="show"
      transition={{ staggerChildren: 0.09 }}
      className="mx-auto flex max-w-3xl flex-col items-center text-center"
    >
      <motion.h1
        variants={fade}
        transition={{ duration: 0.5 }}
        className="headline-gradient text-balance text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-[3.5rem]"
      >
        Extract clean Markdown &amp; perfect LaTeX from any PDF.
      </motion.h1>

      <motion.p
        variants={fade}
        transition={{ duration: 0.5 }}
        className="mt-5 max-w-xl text-pretty text-base leading-relaxed text-zinc-600 dark:text-zinc-400 sm:text-lg"
      >
        The developer-first document parser. Turn complex research papers into
        LLM-ready data in milliseconds.
      </motion.p>

      <motion.div
        variants={fade}
        transition={{ duration: 0.5 }}
        className="mt-7 flex flex-col items-center gap-2.5 sm:flex-row"
      >
        <button
          onClick={onUploadClick}
          className="group inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[13px] font-semibold text-black shadow-glow transition-all hover:bg-accent-soft hover:shadow-glow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-[#0a0a0a]"
        >
          Parse a PDF
          <ArrowDown className="h-3.5 w-3.5 transition-transform group-hover:translate-y-0.5" />
        </button>
        <a
          href="https://github.com/BryanBradfo/mantispdf"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-4 py-2 text-[13px] font-medium text-zinc-700 transition-colors hover:border-zinc-300 hover:text-zinc-900 dark:border-white/10 dark:bg-white/[0.02] dark:text-zinc-300 dark:hover:border-white/20 dark:hover:text-white"
        >
          <Star className="h-3.5 w-3.5" />
          Star on GitHub
        </a>
      </motion.div>
    </motion.div>
  );
}
