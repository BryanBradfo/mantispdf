import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { BANNED_COLOR_PATTERN } from "./rawColors";
import { RAW_COLOR_ALLOWLIST } from "./rawColorsAllowlist";

const root = process.cwd();
const srcDir = join(root, "src");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".tsx") ? [join(dir, e.name)] : [],
  );
}
const dirty = walk(srcDir)
  .filter((f) => BANNED_COLOR_PATTERN.test(readFileSync(f, "utf8")))
  .map((f) => relative(root, f));

describe("raw colour guard", () => {
  it("no file outside the allowlist uses a raw palette class", () => {
    expect(dirty.filter((f) => !(f in RAW_COLOR_ALLOWLIST))).toEqual([]);
  });
  it("no allowlisted file is clean (the list only shrinks)", () => {
    expect(Object.keys(RAW_COLOR_ALLOWLIST).filter((f) => !dirty.includes(f))).toEqual([]);
  });
});
