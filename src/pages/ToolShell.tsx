import type { ReactNode } from "react";
import { PageSEO } from "../components/seo/PageSEO";
import PixelIcon from "../components/brand/PixelIcon";
import DecodeText from "../components/common/DecodeText";
import ToolGuide from "../components/guide/ToolGuide";
import { useDictionary, useLocale, useT } from "../i18n";
import { toolJsonLd } from "../seo/structuredData";
import { sectionNumber, toolById, type ToolId } from "../lib/tools";

interface Props {
  title: string;
  description: string;
  path: string;
  heading: string;
  intro: string;
  children: ReactNode;
  /** The tool this page is: shows its icon and `NN / SECTION` eyebrow above the title (from `lib/tools`). */
  tool: ToolId;
  /** Wider column for tools with a large workspace (the Edit PDF editor). */
  wide?: boolean;
}

/** The tool's pixel icon and `NN / SECTION` label, in mono, above the page title. */
function ToolEyebrow({ tool }: { tool: ToolId }) {
  const t = useT("home");
  const { section, pixel } = toolById(tool);
  return (
    <p data-testid="tool-eyebrow" className="eyebrow flex items-center gap-2.5">
      <PixelIcon icon={pixel} className="h-4 w-4 text-ink" />
      <span>
        {sectionNumber(section)} / {t(`sections.${section}`)}
      </span>
    </p>
  );
}

export default function ToolShell({ title, description, path, heading, intro, children, tool, wide = false }: Props) {
  const jsonLd = toolJsonLd(useDictionary(), useLocale(), tool);
  return (
    <div className={`mx-auto px-4 pb-16 pt-8 sm:px-8 sm:pt-12 ${wide ? "max-w-6xl" : "max-w-2xl"}`}>
      <PageSEO title={title} description={description} path={path} jsonLd={jsonLd} />
      <ToolEyebrow tool={tool} />
      <h1 className="mt-5 font-display text-[2.75rem] font-light leading-[0.95] tracking-[-0.02em] text-ink sm:text-6xl">
        <DecodeText text={heading} trigger="mount" />
      </h1>
      <p className="mt-4 max-w-xl leading-relaxed text-ink-2">{intro}</p>
      {children}
      <ToolGuide tool={tool} />
    </div>
  );
}
