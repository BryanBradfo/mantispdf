/**
 * Files allowed to carry raw palette classes (see rawColors.ts), each with its reason. The migration
 * to the black and white tokens is complete: only document colours (what ends up on the page) may be
 * listed here, with the reason "document colour". The guard test fails on a dirty file missing here
 * AND on a clean file listed here.
 */
export const RAW_COLOR_ALLOWLIST: Record<string, string> = {};
