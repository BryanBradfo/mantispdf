import { useState } from "react";
import { ArrowDown, Download, Sparkles } from "lucide-react";
import DesktopBand from "../components/home/DesktopBand";
import ToolGrid from "../components/home/ToolGrid";
import { PageSEO } from "../components/seo/PageSEO";
import LicenseDialog from "../components/license/LicenseDialog";
import { MantisMark } from "../components/brand/MantisMark";
import DecodeText from "../components/common/DecodeText";
import { useLicense, CHECKOUT_URL } from "../hooks/useLicense";
import { Link, useT } from "../i18n";
import { primaryButton, secondaryButton } from "../styles/ui";

export default function HomePage() {
  const t = useT("home");
  const tSeo = useT("seo");
  const license = useLicense();
  const [licenseOpen, setLicenseOpen] = useState(false);

  return (
    <div className="relative">
      <PageSEO title={tSeo("homeTitle")} description={tSeo("homeDescription")} path="/" />

      <div className="mx-auto max-w-[1440px] px-4 sm:px-8 lg:px-12">
        {/* Desktop-only license entry point. */}
        {license.onDesktop && (
          <div className="flex justify-end pt-6">
            <button onClick={() => setLicenseOpen(true)} className={`${secondaryButton} h-9 gap-2 px-4 text-xs`}>
              <Sparkles aria-hidden="true" strokeWidth={1.5} className="h-3.5 w-3.5" />
              {license.isPro ? t("pro") : t("upgradeToPro")}
            </button>
          </div>
        )}

        <section className="grid items-center gap-12 pb-16 pt-12 sm:pt-16 lg:grid-cols-12 lg:gap-8 lg:pb-24 lg:pt-20">
          <div className="lg:col-span-7">
            <p className="eyebrow">
              <DecodeText text={t("heroEyebrow")} trigger="mount" />
            </p>
            <h1 className="mt-6 font-display w-min text-[clamp(4.5rem,24vw,8rem)] font-light leading-[0.9] tracking-[-0.02em] text-ink lg:text-[clamp(7rem,10vw,10rem)]">
              {t("heading")}
            </h1>
            <p className="mt-6 font-display text-[clamp(1.5rem,5vw,2.25rem)] font-light leading-tight tracking-[-0.01em] text-ink">
              {t("tagline")}
            </p>
            <p className="mt-5 max-w-md text-base leading-relaxed text-ink-2">{t("intro")}</p>
            <div className="mt-10 flex flex-wrap gap-3">
              <a href="#tools" className={`${primaryButton} h-12 gap-3 px-7`}>
                {t("chooseTool")}
                <ArrowDown aria-hidden="true" strokeWidth={1.5} className="h-4 w-4" />
              </a>
              {/* The desktop app has nothing to download. */}
              {!license.onDesktop && (
                <Link to="/download" className={`${secondaryButton} h-12 gap-3 px-7`}>
                  {t("downloadApp")}
                  <Download aria-hidden="true" strokeWidth={1.5} className="h-4 w-4" />
                </Link>
              )}
            </div>
          </div>
          {/* The drawing is cut on its right and bottom edges: it sits flush in a hairline plate. */}
          <figure className="relative mx-auto aspect-[7/8] w-full max-w-[26rem] overflow-hidden border border-line sm:max-w-[30rem] lg:col-span-5 lg:mr-0 lg:max-w-none">
            <MantisMark className="absolute bottom-0 right-0 h-[90%] w-auto text-ink" />
            <figcaption className="eyebrow absolute left-4 top-4 sm:left-5 sm:top-5">{t("heroFigure")}</figcaption>
          </figure>
        </section>

        {/* Hidden in the desktop app (it checks isTauri itself). */}
        <DesktopBand />

        <div id="tools" className="scroll-mt-4 pb-24">
          <ToolGrid />
        </div>
      </div>

      <LicenseDialog
        open={licenseOpen}
        onClose={() => setLicenseOpen(false)}
        status={license.status}
        onActivate={license.activate}
        onDeactivate={license.deactivate}
        checkoutUrl={CHECKOUT_URL}
      />
    </div>
  );
}
