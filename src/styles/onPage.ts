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
/**
 * Invalid and required-but-empty states of a control on the page: the fixed light-theme danger red
 * (PAGE_MARK_DANGER), not the theme token, which is too light on a white page in the dark theme.
 * Kept in this .ts module: the raw-colour guard scans .tsx only, Tailwind scans both.
 */
export const pageInvalid = "!border-[#c62828] !ring-2 !ring-[#c62828]";
export const pageMissing = "!border-[#c62828]";
/** The selected page of a thumbnail strip: a 2 px black frame drawn inside the thumbnail (white page). */
export const pageSelected = "outline outline-2 outline-black";
/** Square resize handle over a page render. */
export const pageHandle = "border border-white bg-black";
