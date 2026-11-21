import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Guard: the interface never uses the middle dot (U+00B7) as a separator, in the locales or in the
 * templates. Separate facts sit in spaced spans (`MetaItems`), a count after a label goes in
 * parentheses, running text uses commas.
 */
const SRC = resolve(__dirname, "..");
const ROOT = resolve(SRC, "..");
const DOT = /·|&middot;|&centerdot;|&#183;|&#xb7;/i;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function offenders(files: string[]): string[] {
  return files.flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line, i) => (DOT.test(line) ? [`${relative(ROOT, path)}:${i + 1}`] : [])),
  );
}

const MESSAGE = (hits: string[]) =>
  `The middle dot is banned as a separator in the UI. Use a comma, parentheses, or spaced spans (MetaItems). Found at:\n${hits.join("\n")}`;

describe("no middle dot in the interface", () => {
  it("is absent from every locale file", () => {
    const hits = offenders(walk(join(SRC, "i18n/locales")).filter((p) => p.endsWith(".ts")));
    expect(hits, MESSAGE(hits)).toEqual([]);
  });

  it("is absent from every template (.tsx, tests excluded)", () => {
    const hits = offenders(walk(SRC).filter((p) => p.endsWith(".tsx") && !p.includes(".test.")));
    expect(hits, MESSAGE(hits)).toEqual([]);
  });
});
