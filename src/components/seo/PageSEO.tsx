import { Helmet } from "react-helmet-async";
import { useLocale } from "../../i18n";
import { SITE, seoUrls } from "./seoUrls";

interface PageSEOProps {
  title: string;
  description: string;
  /** The page's English path (`/merge`); the current locale's URL is derived from it. */
  path: string;
  ogImage?: string;
}

export function PageSEO({ title, description, path, ogImage = "/mantispdf.png" }: PageSEOProps) {
  const { canonical: url, alternates, ogLocale } = seoUrls(path, useLocale());
  const image = `${SITE}${ogImage}`;
  return (
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
  );
}

/** `<html lang>` follows the locale on every page. */
export function HtmlLang() {
  return <Helmet htmlAttributes={{ lang: useLocale() }} />;
}
