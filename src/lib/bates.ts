import { createLatest } from "./latest";
import type { NsT } from "../i18n";

/** Longest Bates prefix or suffix the engine accepts (characters). */
export const MAX_BATES_AFFIX = 100;

/** Same format as the Rust engine: prefix + zero-padded counter + suffix. */
export function formatBates(prefix: string, suffix: string, digits: number, value: number): string {
  return `${prefix}${String(value).padStart(digits, "0")}${suffix}`;
}

export interface BatesRange {
  /** First number used by this file. */
  start: number;
  /** Last number used by this file (start - 1 when the file has no pages). */
  end: number;
  first: string;
  last: string;
}

/** Per-file Bates ranges when files are stamped in order, each starting after the previous one. */
export function batesRanges(counts: readonly number[], start: number, digits: number, prefix: string, suffix: string): BatesRange[] {
  let next = start;
  return counts.map((count) => {
    const range: BatesRange = {
      start: next,
      end: next + count - 1,
      first: formatBates(prefix, suffix, digits, next),
      last: formatBates(prefix, suffix, digits, next + count - 1),
    };
    next += count;
    return range;
  });
}

/** "ACME-000001 to ACME-000037" across all files, or null when there are no pages. */
export function describeBatesRange(ranges: readonly BatesRange[], t: NsT<"bates">): string | null {
  const used = ranges.filter((r) => r.end >= r.start);
  if (used.length === 0) return null;
  const first = used[0].first;
  const last = used[used.length - 1].last;
  return first === last ? first : t("range", { first, last });
}

/** Largest value a Bates counter may reach. */
export const MAX_BATES = 2 ** 32;

/** Independent supersede tokens so adding files never cancels a running job (and vice versa). */
export function createBatesTokens() {
  const upload = createLatest();
  const run = createLatest();
  return {
    upload,
    run,
    invalidateAll(): void {
      upload.invalidate();
      run.invalidate();
    },
  };
}
