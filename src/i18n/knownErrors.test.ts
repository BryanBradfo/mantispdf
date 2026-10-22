import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { KNOWN_ERROR_PATTERNS } from "./describeError";

/**
 * Guard: every message describeError translates must still be produced somewhere. Each literal
 * part of a KNOWN pattern (4+ characters) has to appear in the engine (crates/mantis-wasm/src),
 * the desktop shell (src-tauri/src) or the JS sources (src, outside src/i18n and tests). A message
 * reworded in Rust or JS then fails here instead of silently falling back to the generic sentence.
 */
const ROOT = resolve(__dirname, "../..");

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return path.endsWith(join("src", "i18n")) ? [] : files(path, ext);
    return ext.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

const SOURCES = [
  ...files(join(ROOT, "crates/mantis-wasm/src"), /\.rs$/),
  ...files(join(ROOT, "src-tauri/src"), /\.rs$/),
  ...files(join(ROOT, "src"), /\.tsx?$/),
]
  .map((p) => readFileSync(p, "utf8"))
  .join("\n");

/** The literal runs of a regex source: `^Page (\d+) is out of range \(document` -> ["Page ", " is out of range (document"]. */
function literalSegments(source: string): string[] {
  const out: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.trim().length >= 4) out.push(cur);
    cur = "";
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      const next = source[++i];
      if (/[dDsSwWbB]/.test(next)) flush();
      else cur += next;
    } else if (c === "[") {
      flush();
      while (i < source.length && source[i] !== "]") i++;
    } else if ("^$()|+*?{}.".includes(c)) {
      flush();
    } else {
      cur += c;
    }
  }
  flush();
  return out;
}

describe("literalSegments", () => {
  it("splits a pattern into its literal text", () => {
    expect(literalSegments("^Page (\\d+) is out of range \\(document has (\\d+) pages\\)$")).toEqual([
      "Page ",
      " is out of range (document has ",
      " pages)",
    ]);
    expect(literalSegments("^(No catalog|Cannot access (base Pages|Kids array)): ")).toEqual([
      "No catalog",
      "Cannot access ",
      "base Pages",
      "Kids array",
    ]);
  });
});

describe("describeError KNOWN patterns", () => {
  it("guards a reasonable number of patterns", () => {
    expect(KNOWN_ERROR_PATTERNS.length).toBeGreaterThan(30);
  });

  it.each(KNOWN_ERROR_PATTERNS.map((p) => [p.source]))("%s is still produced by the engine or the app", (source) => {
    const missing = literalSegments(source).filter((segment) => !SOURCES.includes(segment));
    expect(missing).toEqual([]);
  });

  it("would catch a message that no longer exists", () => {
    expect(literalSegments("^This message was never written anywhere$").filter((s) => !SOURCES.includes(s))).toHaveLength(1);
  });
});
