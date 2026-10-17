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
export function describeBatesRange(ranges: readonly BatesRange[]): string | null {
  const used = ranges.filter((r) => r.end >= r.start);
  if (used.length === 0) return null;
  const first = used[0].first;
  const last = used[used.length - 1].last;
  return first === last ? first : `${first} to ${last}`;
}
