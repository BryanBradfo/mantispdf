import { useEffect, useRef, type ReactNode } from "react";
import { Link, useT } from "../../i18n";
import { SECTIONS, sectionNumber, toolsIn } from "../../lib/tools";
import { focusRing } from "../../styles/ui";
import PixelIcon from "../brand/PixelIcon";
import DecodeText from "../common/DecodeText";

interface Props {
  id: string;
  /** Called when a link is followed (the route change closes the menu too; this covers the current page). */
  onNavigate: () => void;
  /** Extra row shown on phones only (language, GitHub), where the header has no room for them. */
  mobileExtras?: ReactNode;
  /** Up to which breakpoint the extras row shows: `sm` (phones) or `lg` (also tablets, for the header's DOWNLOAD box). */
  extrasUntil?: "sm" | "lg";
}

/**
 * The all-tools panel under the header, opened by the TOOLS (desktop) or MENU (phone) button. The
 * header owns the open state, Escape, outside clicks and focus return; this renders the sections.
 */
export default function ToolsMenu({ id, onNavigate, mobileExtras, extrasUntil = "sm" }: Props) {
  const t = useT("common");
  const th = useT("home");
  const navRef = useRef<HTMLElement>(null);

  // Opening moves focus to the first tool, so Tab walks the menu next (keyboard or click alike).
  useEffect(() => {
    navRef.current?.querySelector<HTMLAnchorElement>("a")?.focus();
  }, []);

  return (
    <div
      id={id}
      className="absolute inset-x-0 top-full z-50 max-h-[calc(100dvh-4rem)] overflow-y-auto border-b border-line bg-paper"
    >
      {mobileExtras && (
        <div
          className={`mx-4 flex items-center justify-between gap-4 border-b border-line py-4 sm:mx-8 lg:mx-12 ${extrasUntil === "lg" ? "lg:hidden" : "sm:hidden"}`}
        >
          {mobileExtras}
        </div>
      )}
      <nav ref={navRef} aria-label={t("toolsMenu")} className="mx-auto max-w-[1440px] px-4 pb-10 pt-6 sm:px-8 lg:px-12">
        <div className="grid gap-x-8 gap-y-8 sm:grid-cols-3 lg:grid-cols-5">
          {SECTIONS.map((section) => (
            <section key={section} aria-labelledby={`${id}-${section}`}>
              <h2 id={`${id}-${section}`} className="eyebrow border-b border-line pb-3">
                <span aria-hidden="true">{sectionNumber(section)} / </span>
                {th(`sections.${section}`)}
              </h2>
              <ul className="mt-2">
                {toolsIn(section).map(({ id: tool, href, pixel }) => (
                  <li key={tool}>
                    <Link
                      to={href}
                      onClick={onNavigate}
                      className={`group -mx-2 flex items-center gap-3 px-2 py-1.5 text-sm text-ink-2 hover:bg-ink hover:text-paper ${focusRing}`}
                    >
                      <PixelIcon icon={pixel} className="h-4 w-4 shrink-0" />
                      <DecodeText text={th(`${tool}.title`)} trigger="hover" />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </nav>
    </div>
  );
}
