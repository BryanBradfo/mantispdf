// Types of scripts/check-pwa.mjs for the unit test (src/pwa/checkPwa.test.ts).
export const SW_KILL_ENV: "MANTIS_SW_KILL";
export function isSelfDestroyingSw(sw: string): boolean;
export function checkPwa(dist: string, options?: { kill?: boolean; root?: string }): { problems: string[]; summary: string };
