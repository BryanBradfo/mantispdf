import { Helmet } from "react-helmet-async";

interface PageSEOProps {
  title: string;
  description: string;
  path: string;
  ogImage?: string;
}

const SITE = "https://mantispdf.vercel.app";

export function PageSEO({ title, description, path, ogImage = "/mantispdf.png" }: PageSEOProps) {
  const url = `${SITE}${path}`;
  const image = `${SITE}${ogImage}`;
  return (
    <Helmet>
      <title>{title}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={url} />
      <meta property="og:type" content="website" />
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
