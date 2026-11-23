import { Helmet } from "react-helmet-async";
import { useLocale } from "../../i18n";
import { SITE, seoUrls } from "./seoUrls";
import { jsonLdScript, type JsonLd } from "../../seo/structuredData";

interface PageSEOProps {
  title: string;
  description: string;
  /** The page's English path (`/merge`); the current locale's URL is derived from it. */
  path: string;
  ogImage?: string;
  /** The page's structured data (schema.org JSON-LD), rendered as an inline script. */
  jsonLd?: JsonLd;
}

export function PageSEO({ title, description, path, ogImage, jsonLd }: PageSEOProps) {
  const locale = useLocale();
  const { canonical: url, alternates, ogLocale } = seoUrls(path, locale);
  const image = `${SITE}${ogImage ?? `/og-${locale}.png`}`;
  return (
    <>
    <Helmet>
      <title>{title}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={url} />
      {alternates.map((a) => (
        <link key={a.hrefLang} rel="alternate" hrefLang={a.hrefLang} href={a.href} />
      ))}
      <meta property="og:type" content="website" />
      <meta property="og:locale" content={ogLocale} />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={url} />
      <meta property="og:image" content={image} />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={image} />
    </Helmet>
      {/* Not in Helmet: React hoists only title/meta/link. A JSON-LD script is valid anywhere in the page. */}
      {jsonLd && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }} />}
    </>
  );
}

/** `<html lang>` follows the locale on every page. */
export function HtmlLang() {
  return <Helmet htmlAttributes={{ lang: useLocale() }} />;
}
