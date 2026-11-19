import type { ReactNode } from "react";
import { PageSEO } from "../components/seo/PageSEO";
import { useT } from "../i18n";
import { sectionNumber, toolById, type ToolId } from "../lib/tools";

interface Props {
  title: string;
  description: string;
  path: string;
  heading: string;
  intro: string;
  children: ReactNode;
  /** The tool this page is: shows its icon and `NN / SECTION` eyebrow above the title (from `lib/tools`). */
  tool?: ToolId;
  /** Wider column for tools with a large workspace (the Edit PDF editor). */
  wide?: boolean;
}

/** The tool's icon and `NN / SECTION` label, in mono, above the page title. */
function ToolEyebrow({ tool }: { tool: ToolId }) {
  const t = useT("home");
  const { section, icon: Icon } = toolById(tool);
  return (
    <p data-testid="tool-eyebrow" className="eyebrow flex items-center gap-2.5">
      <Icon aria-hidden="true" strokeWidth={1.5} className="h-4 w-4 text-ink" />
      <span>
        {sectionNumber(section)} / {t(`sections.${section}`)}
      </span>
    </p>
  );
}

export default function ToolShell({ title, description, path, heading, intro, children, tool, wide = false }: Props) {
  return (
    <div className={`mx-auto px-4 pb-16 pt-8 sm:px-8 sm:pt-12 ${wide ? "max-w-6xl" : "max-w-2xl"}`}>
      <PageSEO title={title} description={description} path={path} />
      {tool && <ToolEyebrow tool={tool} />}
      <h1 className={`font-display text-[2.75rem] font-light leading-[0.95] tracking-[-0.02em] text-ink sm:text-6xl ${tool ? "mt-5" : ""}`}>
        {heading}
      </h1>
      <p className="mt-4 max-w-xl leading-relaxed text-ink-2">{intro}</p>
      {children}
    </div>
  );
}

export const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-paper";
const button =
  "inline-flex h-10 items-center justify-center rounded-none px-5 font-display text-sm font-medium uppercase tracking-wider transition-opacity disabled:pointer-events-none disabled:opacity-40";
export const primaryButton = `${button} bg-ink text-paper hover:opacity-85 ${focusRing}`;
export const secondaryButton = `${button} border border-line-strong bg-transparent text-ink hover:border-ink ${focusRing}`;
export const dangerButton = `${button} border border-danger bg-transparent text-danger hover:bg-danger hover:text-paper ${focusRing}`;
export const inputClass = `mt-1 w-full rounded-none border border-line-strong bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus-visible:border-ink ${focusRing}`;
export const panelClass = `mt-8 rounded-none border border-line bg-surface p-6 ${focusRing}`;
export const noticeClass = `rounded-none border border-line-strong bg-surface px-4 py-3 text-sm text-ink ${focusRing}`;
