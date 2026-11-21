import { useId } from "react";
import { ArrowUpRight } from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import { Link, useT } from "../../i18n";
import PixelIcon from "../brand/PixelIcon";
import DecodeText from "../common/DecodeText";
import { DESKTOP_OSES, OS_NAMES } from "../../lib/desktopRelease";
import { PAGE_ICONS } from "../../lib/pixelIcons";

/**
 * The home "desktop app" band (Hermes-like): eyebrow, Oswald title and subtitle, then one hairline
 * tile per OS, in the tool grid's cell language (hover/focus inverts, title decodes on hover, 32 px
 * pixel icon). Each tile opens /download on its OS tab (`?os=`). Not shown inside the desktop app.
 */
export default function DesktopBand() {
  const t = useT("home");
  const headingId = useId();
  if (isTauri()) return null;

  return (
    <section aria-labelledby={headingId} className="py-10 lg:py-16">
      <p className="eyebrow flex items-center gap-2.5">
        <PixelIcon icon={PAGE_ICONS.download} className="h-4 w-4 text-ink" />
        <span>{t("desktop.eyebrow")}</span>
      </p>
      <h2
        id={headingId}
        className="mt-5 font-display text-[2.75rem] font-light leading-[0.95] tracking-[-0.02em] text-ink sm:text-6xl lg:text-7xl"
      >
        {t("desktop.title")}
      </h2>
      <p className="mt-4 text-base leading-relaxed text-ink-2 sm:text-lg">{t("desktop.subtitle")}</p>

      <ul className="mt-10 grid grid-cols-1 pl-px pt-px sm:grid-cols-3">
        {DESKTOP_OSES.map((os) => (
          <li key={os} className="-ml-px -mt-px flex">
            <Link
              to={{ pathname: "/download", search: `?os=${os}` }}
              className="group relative flex w-full flex-col border border-line px-4 py-5 text-ink hover:z-10 hover:border-ink hover:bg-ink hover:text-paper focus-visible:z-10 focus-visible:border-ink focus-visible:bg-ink focus-visible:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-paper sm:min-h-[12.5rem] sm:p-6"
            >
              <span className="flex items-start justify-between">
                <PixelIcon icon={PAGE_ICONS[os]} className="h-8 w-8 shrink-0" />
                <ArrowUpRight
                  aria-hidden="true"
                  strokeWidth={1.5}
                  className="h-4 w-4 shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
                />
              </span>
              <span className="mt-8 block font-mono text-[11px] uppercase tracking-[0.08em] text-ink-2 group-hover:text-paper group-focus-visible:text-paper sm:mt-auto sm:pt-12">
                {t(`desktop.${os}`)}
              </span>
              <span className="mt-1.5 block font-display text-2xl font-light leading-tight tracking-[-0.005em] sm:text-3xl">
                <DecodeText text={OS_NAMES[os]} trigger="hover" />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
