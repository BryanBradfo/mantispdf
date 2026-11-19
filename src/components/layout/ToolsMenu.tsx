import type { ReactNode } from "react";
import { Link, useT } from "../../i18n";
import { SECTIONS, sectionNumber, toolsIn } from "../../lib/tools";
import { focusRing } from "../../pages/ToolShell";

interface Props {
  id: string;
  /** Called when a link is followed (the route change closes the menu too; this covers the current page). */
  onNavigate: () => void;
  /** Extra row shown on phones only (language, GitHub), where the header has no room for them. */
  mobileExtras?: ReactNode;
}

/**
 * The all-tools panel under the header, opened by the TOOLS (desktop) or MENU (phone) button. The
 * header owns the open state, Escape, outside clicks and focus return; this renders the sections.
 */
export default function ToolsMenu({ id, onNavigate, mobileExtras }: Props) {
  const t = useT("common");
  const th = useT("home");
  return (
    <div
      id={id}
      className="absolute inset-x-0 top-full z-50 max-h-[calc(100dvh-4rem)] overflow-y-auto border-b border-line bg-paper"
    >
      {mobileExtras && (
        <div className="mx-4 flex items-center justify-between border-b border-line py-4 sm:hidden">{mobileExtras}</div>
      )}
      <nav aria-label={t("toolsMenu")} className="mx-auto max-w-[1440px] px-4 pb-10 pt-6 sm:px-8 lg:px-12">
        <div className="grid gap-x-8 gap-y-8 sm:grid-cols-3 lg:grid-cols-5">
          {SECTIONS.map((section) => (
            <section key={section} aria-labelledby={`${id}-${section}`}>
              <h2 id={`${id}-${section}`} className="eyebrow border-b border-line pb-3">
                <span aria-hidden="true">{sectionNumber(section)} / </span>
                {th(`sections.${section}`)}
              </h2>
              <ul className="mt-2">
                {toolsIn(section).map(({ id: tool, href, icon: Icon }) => (
                  <li key={tool}>
                    <Link
                      to={href}
                      onClick={onNavigate}
                      className={`group -mx-2 flex items-center gap-3 px-2 py-1.5 text-sm text-ink-2 hover:bg-ink hover:text-paper ${focusRing}`}
                    >
                      <Icon aria-hidden="true" strokeWidth={1.5} className="h-4 w-4 shrink-0" />
                      {th(`${tool}.title`)}
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
