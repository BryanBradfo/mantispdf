import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

/**
 * Guard: no user-facing English is written straight into the UI. Scans every `src/**\/*.tsx` outside
 * `src/i18n` (tests excluded) for JSX text and for string literals in the props a person reads or
 * hears (aria-label, aria-roledescription, title, placeholder, alt). Text must come from `t()`.
 */
const ROOT = resolve(__dirname, "../..");
const SCANNED_PROPS = new Set(["aria-label", "aria-roledescription", "title", "placeholder", "alt"]);

/**
 * Literal text that is allowed, with the reason. Matched on the exact trimmed text, in the given
 * file (or any file when `file` is "*").
 */
const ALLOWLIST: { file: string; text: string; reason: string }[] = [
  { file: "src/components/layout/Header.tsx", text: "MantisPDF", reason: "brand name (logo alt text), the same in every language" },
  { file: "src/components/desktop/TitleBar.tsx", text: "MantisPDF", reason: "brand name (desktop window title), the same in every language" },
  {
    file: "src/components/license/LicenseDialog.tsx",
    text: "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX",
    reason: "license key format shown as a placeholder, not words",
  },
  { file: "src/pages/BatesPage.tsx", text: "ACME-", reason: "sample Bates prefix (an identifier, not prose), the same in every language" },
];

interface Finding {
  file: string;
  line: number;
  text: string;
}

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return path.endsWith(join("src", "i18n")) ? [] : tsxFiles(path);
    return name.endsWith(".tsx") && !name.includes(".test.") ? [path] : [];
  });
}

/** Has words (two letters in a row) once HTML entities (`&middot;`) are dropped. */
const hasWords = (text: string) => /\p{L}{2}/u.test(text.replace(/&[a-z]+;|&#\d+;/gi, ""));

/** The literal parts of an expression used as a prop value or JSX child. */
function literalTexts(node: ts.Node): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)];
  if (ts.isConditionalExpression(node)) return [...literalTexts(node.whenTrue), ...literalTexts(node.whenFalse)];
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken) return literalTexts(node.right);
  if (ts.isParenthesizedExpression(node)) return literalTexts(node.expression);
  return [];
}

function scan(path: string): Finding[] {
  return scanSource(relative(ROOT, path), readFileSync(path, "utf8"));
}

function scanSource(file: string, code: string): Finding[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Finding[] = [];
  const add = (node: ts.Node, text: string) => {
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (!hasWords(trimmed)) return;
    if (ALLOWLIST.some((a) => (a.file === "*" || a.file === file) && a.text === trimmed)) return;
    out.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: trimmed });
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) add(node, node.text);
    if (node.parent && ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      for (const text of literalTexts(node.expression)) add(node, text);
    }
    if (ts.isJsxAttribute(node) && SCANNED_PROPS.has(node.name.getText(source)) && node.initializer) {
      const init = node.initializer;
      if (ts.isStringLiteral(init)) add(init, init.text);
      else if (ts.isJsxExpression(init) && init.expression) for (const text of literalTexts(init.expression)) add(init, text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

describe("the scanner", () => {
  const texts = (code: string) => scanSource("src/sample.tsx", code).map((f) => f.text);

  it("catches JSX text, literal children, and the read props", () => {
    expect(texts(`const a = <p>Hello there</p>;`)).toEqual(["Hello there"]);
    expect(texts(`const a = <>{"Saving…"}</>;`)).toEqual(["Saving…"]);
    expect(texts(`const a = <p>{busy ? "Saving…" : "Save"}</p>;`)).toEqual(["Saving…", "Save"]);
    expect(texts(`const a = <img alt="A photo" />;`)).toEqual(["A photo"]);
    expect(texts(`const a = <b aria-label={\`Page \${n} editor\`} />;`)).toEqual(["Page", "editor"]);
    expect(texts(`const a = <input placeholder={"Your name"} title='Name' />;`)).toEqual(["Your name", "Name"]);
    expect(texts(`const a = <g aria-roledescription="page editor" />;`)).toEqual(["page editor"]);
  });

  it("lets translated text, symbols, numbers and other props through", () => {
    expect(texts(`const a = <p title={t("x")}>{t("y")} · {n} / 12 &middot; ↺</p>;`)).toEqual([]);
    expect(texts(`const a = <p className="mt-2 text-sm" data-testid="hf-preview" />;`)).toEqual([]);
  });
});

describe("hardcoded user-facing text", () => {
  const files = tsxFiles(join(ROOT, "src"));

  it("scans the app's components and pages", () => {
    expect(files.length).toBeGreaterThan(60);
  });

  it("finds no literal text in JSX or in aria-label, aria-roledescription, title, placeholder, alt", () => {
    const findings = files.flatMap(scan).map((f) => `${f.file}:${f.line}: ${JSON.stringify(f.text)}`);
    expect(findings).toEqual([]);
  });

  it("keeps a reason for every allowlisted text", () => {
    expect(ALLOWLIST.filter((a) => a.reason.trim().length < 10)).toEqual([]);
  });
});

/**
 * Library code (src/lib) builds no user-facing sentences either: a string literal shaped like a
 * sentence (three or more words, the first capitalised) must come from `t()`. Not counted: the
 * argument of `throw new Error(...)` (engine-style messages, mapped by describeError), comments,
 * and the allowlist below.
 */
const LIB_ALLOWLIST: { file: string; text: string; reason: string }[] = [
  {
    file: "src/lib/editor/afm.ts",
    text: "Characters not supported by the standard PDF fonts: {x}",
    reason: "engine-identical error text (crates/mantis-wasm stamp fonts) thrown by encodeWinAnsi; describeError translates it",
  },
  {
    file: "src/lib/editor/model.ts",
    text: "Noto Sans Mono",
    reason: "font family name (fonts.json, FontFace), the same in every language",
  },
  {
    file: "src/lib/editor/unicodeText.ts",
    text: "Noto Sans Mono",
    reason: "font family name (fonts.json, FontFace), the same in every language",
  },
  {
    file: "src/lib/fonts/select.ts",
    text: "Noto Sans Arabic",
    reason: "font family name (fonts.json, FontFace), the same in every language",
  },
  {
    file: "src/lib/fonts/select.ts",
    text: "Noto Sans Hebrew",
    reason: "font family name (fonts.json, FontFace), the same in every language",
  },
  {
    file: "src/lib/fonts/select.ts",
    text: "Noto Sans Devanagari",
    reason: "font family name (fonts.json, FontFace), the same in every language",
  },
  {
    file: "src/lib/fonts/select.ts",
    text: "Noto Sans Thai",
    reason: "font family name (fonts.json, FontFace), the same in every language",
  },
  {
    file: "src/lib/fonts/select.ts",
    text: "Noto Sans {x}",
    reason: "font family name (fonts.json, FontFace), the same in every language",
  },
  {
    file: "src/lib/editor/unicodeText.ts",
    text: "No font can show these characters: {x} (text box on page {x}).",
    reason: "engine-style error thrown into Edit PDF's download path (noFontError); describeError translates it",
  },
  {
    file: "src/lib/fonts/fontStore.ts",
    text: "Invalid edit settings: font",
    reason: "the wasm FontStore's own error text, matched to tell a full store from a failed fetch; never shown",
  },
  {
    file: "src/lib/ocr/pipeline.ts",
    text: "The OCR engine stopped",
    reason: "internal failure reason of a pipeline page; the OCR page shows failedLine() instead, never this text",
  },
];

const isSentence = (text: string) => /^\p{Lu}\p{Ll}*(?:[\s,]+\S+){2,}/u.test(text.trim());

function libTsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return libTsFiles(path);
    return name.endsWith(".ts") && !name.includes(".test.") && !name.endsWith(".d.ts") ? [path] : [];
  });
}

function insideThrownError(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && /Error$/.test(n.expression.text)) return true;
    if (ts.isBlock(n) || ts.isSourceFile(n)) return false;
  }
  return false;
}

function scanLibSource(file: string, code: string): Finding[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: Finding[] = [];
  const visit = (node: ts.Node) => {
    const texts =
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
        ? [node.text]
        : ts.isTemplateExpression(node)
          ? [node.head.text + node.templateSpans.map((span) => "{x}" + span.literal.text).join("")]
          : [];
    for (const text of texts) {
      if (!isSentence(text) || insideThrownError(node)) continue;
      const trimmed = text.replace(/\s+/g, " ").trim();
      if (LIB_ALLOWLIST.some((a) => a.file === file && a.text === trimmed)) continue;
      out.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: trimmed });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

describe("sentence-shaped literals in src/lib", () => {
  const texts = (code: string) => scanLibSource("src/lib/sample.ts", code).map((f) => f.text);

  it("the scanner catches sentences and skips thrown errors, comments and code-like strings", () => {
    expect(texts(`export const a = "Select at least one page.";`)).toEqual(["Select at least one page."]);
    expect(texts("export const b = (n: number) => `Page ${n} has no text`;")).toEqual(["Page {x} has no text"]);
    expect(texts(`throw new Error("Could not read the file today");`)).toEqual([]);
    expect(texts(`// A comment with Several Words in it\nconst c = "image/png";`)).toEqual([]);
    expect(texts(`const d = "Helvetica";`)).toEqual([]);
  });

  it("finds none outside the allowlist", () => {
    const findings = libTsFiles(join(ROOT, "src/lib"))
      .flatMap((p) => scanLibSource(relative(ROOT, p), readFileSync(p, "utf8")))
      .map((f) => `${f.file}:${f.line}: ${JSON.stringify(f.text)}`);
    expect(findings).toEqual([]);
  });

  it("keeps a reason for every allowlisted literal", () => {
    expect(LIB_ALLOWLIST.filter((a) => a.reason.trim().length < 10)).toEqual([]);
  });
});

