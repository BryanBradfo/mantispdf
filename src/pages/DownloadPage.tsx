import { useEffect, useId, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowUpRight, Check, Copy, Download, Info } from "lucide-react";
import { PageSEO } from "../components/seo/PageSEO";
import PixelIcon from "../components/brand/PixelIcon";
import DecodeText from "../components/common/DecodeText";
import { useT } from "../i18n";
import {
  DESKTOP_OSES,
  DESKTOP_VERSION,
  OS_NAMES,
  RELEASES_URL,
  asDesktopOs,
  assetUrl,
  linuxInstallCommand,
  visitorOs,
  type AssetKind,
  type DesktopOs,
} from "../lib/desktopRelease";
import { listStep } from "../lib/gridNav";
import { PAGE_ICONS } from "../lib/pixelIcons";
import { TOOLS } from "../lib/tools";
import { focusRing, monoLabel, noticeClass, primaryButton, secondaryButton } from "../styles/ui";

/** Per OS: the main installer(s), then the other formats. */
const INSTALLERS: Record<DesktopOs, { primary: AssetKind; secondary: AssetKind[] }> = {
  mac: { primary: "macArm", secondary: ["macIntel"] },
  windows: { primary: "winExe", secondary: ["winMsi"] },
  linux: { primary: "appImage", secondary: ["deb", "rpm"] },
};

/** A download link to a release asset: plain navigation (GitHub serves the file), never a fetch from the page. */
function AssetLink({ kind, primary }: { kind: AssetKind; primary: boolean }) {
  const t = useT("download");
  return (
    <a href={assetUrl(kind)} download className={`${primary ? primaryButton : secondaryButton} h-12 gap-3 px-6`}>
      <Download aria-hidden="true" strokeWidth={1.5} className="h-4 w-4" />
      {t(kind)}
    </a>
  );
}

/** The Linux one-liner in a mono terminal line, with a copy button (as on the Hermes Agent site). */
function Terminal() {
  const t = useT("download");
  const command = linuxInstallCommand();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = () => {
    void navigator.clipboard
      ?.writeText(command)
      .then(() => {
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => undefined);
  };

  return (
    <div className="mt-3 flex items-stretch border border-line bg-surface" aria-label={t("terminal")} role="group">
      <pre className="min-w-0 flex-1 overflow-x-auto px-4 py-3 font-mono text-xs leading-relaxed text-ink">
        <span aria-hidden="true" className="select-none text-ink-3">
          ${" "}
        </span>
        <code>{command}</code>
      </pre>
      <button
        type="button"
        onClick={copy}
        aria-label={t("copy")}
        className={`flex w-11 shrink-0 items-center justify-center border-l border-line text-ink-2 hover:bg-ink hover:text-paper ${focusRing} focus-visible:ring-inset focus-visible:!ring-offset-0`}
      >
        {copied ? (
          <Check aria-hidden="true" strokeWidth={1.5} className="h-4 w-4" />
        ) : (
          <Copy aria-hidden="true" strokeWidth={1.5} className="h-4 w-4" />
        )}
      </button>
      <span role="status" className="sr-only">
        {copied ? t("copied") : ""}
      </span>
    </div>
  );
}

export default function DownloadPage() {
  const t = useT("download");
  const tc = useT("common");
  // `?os=mac|windows|linux` (the home band's tiles) picks the tab; otherwise the visitor's OS.
  const [params] = useSearchParams();
  const [os, setOs] = useState<DesktopOs>(() => asDesktopOs(params.get("os")) ?? visitorOs());
  const tabs = useRef<Partial<Record<DesktopOs, HTMLButtonElement | null>>>({});
  const id = useId();
  const tabId = (o: DesktopOs) => `${id}-tab-${o}`;
  const panelId = `${id}-panel`;
  const { primary, secondary } = INSTALLERS[os];

  // Tabs pattern: one tab stop; arrows, Home and End move between tabs and select them.
  const onTabKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const next = listStep(DESKTOP_OSES.indexOf(os), e.key, DESKTOP_OSES.length);
    if (next === null) return;
    e.preventDefault();
    const o = DESKTOP_OSES[next];
    setOs(o);
    tabs.current[o]?.focus();
  };

  return (
    <div className="mx-auto max-w-3xl px-4 pb-16 pt-8 sm:px-8 sm:pt-12">
      <PageSEO
        title={t("seoTitle")}
        description={t("seoDescription", { count: TOOLS.length })}
        path="/download"
      />
      <p data-testid="download-eyebrow" className="eyebrow flex items-center gap-2.5">
        <PixelIcon icon={PAGE_ICONS.download} className="h-4 w-4 text-ink" />
        <span>{t("eyebrow")}</span>
      </p>
      <h1 className="mt-5 font-display text-[2.75rem] font-light leading-[0.95] tracking-[-0.02em] text-ink sm:text-6xl">
        <DecodeText text={t("heading")} trigger="mount" />
      </h1>
      <p className="mt-4 max-w-xl leading-relaxed text-ink-2">{t("intro", { count: TOOLS.length })}</p>

      <div className="mt-10 border border-line">
        <div role="tablist" aria-label={t("osTabs")} className="grid grid-cols-3 border-b border-line">
          {DESKTOP_OSES.map((o) => (
            <button
              key={o}
              ref={(el) => {
                tabs.current[o] = el;
              }}
              id={tabId(o)}
              type="button"
              role="tab"
              aria-selected={os === o}
              aria-controls={panelId}
              tabIndex={os === o ? 0 : -1}
              onClick={() => setOs(o)}
              onKeyDown={onTabKey}
              // Edge to edge: the focus ring is inset, in paper on the ink-filled tab.
              className={`h-11 border-r border-line font-display text-[15px] font-normal tracking-[0.06em] last:border-r-0 ${focusRing} focus-visible:ring-inset focus-visible:!ring-offset-0 ${
                os === o ? "bg-ink text-paper focus-visible:!ring-paper" : "text-ink-2 hover:text-ink"
              }`}
            >
              {OS_NAMES[o]}
            </button>
          ))}
        </div>

        <div role="tabpanel" id={panelId} aria-labelledby={tabId(os)} className="p-5 sm:p-8">
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <AssetLink kind={primary} primary />
          </div>
          <p className={`${monoLabel} mt-8`}>{t("otherFormats")}</p>
          <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            {secondary.map((kind) => (
              <AssetLink key={kind} kind={kind} primary={false} />
            ))}
          </div>

          {os === "linux" ? (
            <div className="mt-8">
              <p className="text-sm text-ink-2">{t("noteLinux")}</p>
              <Terminal />
              <p className={`${noticeClass} mt-6 flex items-start gap-3`}>
                <Info aria-hidden="true" strokeWidth={1.5} className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{t("noteDeb", { version: DESKTOP_VERSION })}</span>
              </p>
            </div>
          ) : (
            <p className={`${noticeClass} mt-8 flex items-start gap-3`}>
              <Info aria-hidden="true" strokeWidth={1.5} className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{os === "mac" ? t("noteMac") : t("noteWindows")}</span>
            </p>
          )}
        </div>
      </div>

      <p className={`${monoLabel} mt-6 flex flex-wrap items-center gap-x-6 gap-y-2`}>
        <span>{t("version", { version: DESKTOP_VERSION })}</span>
        <a
          href={RELEASES_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={`inline-flex items-center gap-1.5 text-ink-2 hover:text-ink ${focusRing}`}
        >
          {t("allReleases")}
          <ArrowUpRight aria-hidden="true" strokeWidth={1.5} className="h-3 w-3" />
          <span className="sr-only"> {tc("footerNewTab")}</span>
        </a>
      </p>
    </div>
  );
}
