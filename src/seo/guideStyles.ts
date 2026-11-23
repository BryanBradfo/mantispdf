/**
 * Class strings of the "How it works" guide and the FAQ lists, shared by the React components
 * (ToolGuide, HomeFaq) and the prerendered static pages (staticPage.ts), so the page a crawler or a
 * visitor sees before the app starts looks like the one the app draws.
 */
export const guide = {
  section: "mt-20 max-w-3xl border-t border-line pt-10",
  eyebrow: "eyebrow",
  title: "mt-4 font-display text-3xl font-light leading-tight tracking-[-0.01em] text-ink sm:text-4xl",
  lead: "mt-4 max-w-xl leading-relaxed text-ink-2",
  steps: "mt-8 border-t border-line",
  step: "grid grid-cols-[3rem_1fr] items-baseline gap-2 border-b border-line py-4",
  stepNumber: "font-mono text-[11px] uppercase tracking-[0.08em] text-ink-2",
  stepText: "leading-relaxed text-ink",
  subTitle: "mt-12 font-display text-xl font-light uppercase tracking-[0.06em] text-ink",
  faqList: "mt-4 border-t border-line",
  faqItem: "group border-b border-line",
  faqSummary:
    "flex cursor-pointer list-none items-center justify-between gap-4 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink [&::-webkit-details-marker]:hidden",
  faqQuestion: "text-base font-medium leading-snug text-ink",
  faqChevron: "h-4 w-4 shrink-0 text-ink-2 transition-transform duration-150 group-open:rotate-180 motion-reduce:transition-none",
  faqAnswer: "max-w-xl pb-5 leading-relaxed text-ink-2",
  related: "mt-4 grid grid-cols-1 border-l border-t border-line sm:grid-cols-2",
  relatedItem: "border-b border-r border-line",
  relatedLink:
    "flex items-center gap-3 px-4 py-3 text-sm text-ink hover:bg-ink hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink",
} as const;
