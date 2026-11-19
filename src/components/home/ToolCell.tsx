import { ArrowUpRight } from "lucide-react";
import { Link } from "../../i18n";
import PixelIcon from "../brand/PixelIcon";
import DecodeText from "../common/DecodeText";
import type { PixelGlyph } from "../../lib/pixelIcons";

interface ToolCellProps {
  title: string;
  description: string;
  href: string;
  icon: PixelGlyph;
  /** "01", "02", ...: the tool's place in its section. */
  index: string;
}

/**
 * One cell of the hairline tool grid. Cells overlap by 1 px (-ml-px -mt-px) so neighbours share a
 * single line; hover and keyboard focus invert the cell (ink ground, paper text and icon: AA in
 * both themes), with an inset paper ring added for focus so it differs from hover. The title decodes
 * on hover and focus; the pixel icon is drawn at 2x (32 px) so every pixel stays whole.
 */
export default function ToolCell({ title, description, href, icon, index }: ToolCellProps) {
  return (
    <li className="-ml-px -mt-px flex">
      <Link
        to={href}
        className="group relative grid w-full grid-cols-[auto_1fr] gap-x-4 border border-line px-4 py-5 text-ink hover:z-10 hover:border-ink hover:bg-ink hover:text-paper focus-visible:z-10 focus-visible:border-ink focus-visible:bg-ink focus-visible:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-paper sm:flex sm:min-h-[12.5rem] sm:flex-col sm:p-6"
      >
        <span className="flex items-start justify-between sm:w-full">
          <PixelIcon icon={icon} className="h-8 w-8 shrink-0" />
          <span
            aria-hidden="true"
            className="hidden font-mono text-[11px] tracking-[0.08em] text-ink-2 group-hover:text-paper group-focus-visible:text-paper sm:block"
          >
            {index}
          </span>
        </span>
        <span className="min-w-0 sm:pt-12">
          <span className="flex items-center justify-between gap-3">
            <span className="font-display text-xl font-light leading-tight tracking-[-0.005em] sm:text-2xl">
              <DecodeText text={title} trigger="hover" />
            </span>
            <ArrowUpRight
              aria-hidden="true"
              strokeWidth={1.5}
              className="hidden h-4 w-4 shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 sm:block"
            />
          </span>
          <span className="mt-1.5 block text-sm leading-snug text-ink-2 group-hover:text-paper group-focus-visible:text-paper">
            {description}
          </span>
        </span>
      </Link>
    </li>
  );
}
