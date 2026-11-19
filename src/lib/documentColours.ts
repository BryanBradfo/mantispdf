/**
 * Colours of document content (what ends up on the page), not UI: they stay the same in both
 * themes and are kept out of the .tsx files, where the raw-colour guard only allows theme tokens.
 */

/** Ink of a drawn or typed signature (a dark blue-black, like a pen). */
export const SIGNATURE_INK = "#1f2a44";
/** The "Signed on" caption as the engine prints it (grey 0.2, see signPlacement). */
export const SIGNED_ON_CAPTION = "#333333";
/** A whiteout box. */
export const WHITEOUT = "#ffffff";
