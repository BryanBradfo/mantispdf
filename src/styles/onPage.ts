/**
 * Marks drawn over a page render (selection frames and handles, the text being edited, placed
 * signatures and form fields, warnings). A page is white whatever the theme, so these marks use
 * fixed black and white pairs that contrast with the page, not the theme tokens (like the crop box).
 */
export const PAGE_MARK_DARK = "#000000";
export const PAGE_MARK_LIGHT = "#ffffff";
/** A problem on the page (characters no font has): the light theme's danger red, legible on a white page in both themes. */
export const PAGE_MARK_DANGER = "#c62828";

/** HTML frame over a page render: a 1 px black ring and a 1 px white outline just outside it, visible on white and dark content. */
export const pageFrame = "outline outline-1 outline-offset-1 outline-white ring-1 ring-black";
/** A badge on a page thumbnail (the check of the shown page). */
export const pageBadge = "bg-black text-white";
/** A status dot on a page thumbnail (page edited, page has fields). */
export const pageDot = "bg-black ring-2 ring-white";
/** Square resize handle over a page render. */
export const pageHandle = "border border-white bg-black";
