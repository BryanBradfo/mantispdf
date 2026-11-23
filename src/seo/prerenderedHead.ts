/**
 * A prerendered page (scripts/prerender.mjs) carries its title, meta, links and JSON-LD in <head>,
 * marked `data-prerender`. PageSEO renders them again once the app mounts (React 19 does not dedupe
 * them), so the static copies go before the first render, except the <title>: the tab keeps it until
 * the app's own title arrives, then it is removed too.
 */
export function dropPrerenderedHead(doc: Document): void {
  for (const el of doc.querySelectorAll("[data-prerender]:not(title)")) el.remove();
  const title = doc.querySelector("title[data-prerender]");
  if (!title) return;
  const appTitle = () => doc.head.querySelector("title:not([data-prerender])");
  if (appTitle()) {
    title.remove();
    return;
  }
  const observer = new MutationObserver(() => {
    if (!appTitle()) return;
    title.remove();
    observer.disconnect();
  });
  observer.observe(doc.head, { childList: true });
}
