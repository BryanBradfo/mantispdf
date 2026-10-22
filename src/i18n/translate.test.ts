import { describe, it, expect } from "vitest";
import { createT, interpolate, selectPlural, splitRich } from "./translate";
import type { Messages, Namespace } from "./types";

const en = {
  title: "Merge PDF",
  greeting: "Hello {name}, you have {n} pages",
  files: { one: "{count} file", other: "{count} files" },
  filesIn: { one: "{count} file in {folder}", other: "{count} files in {folder}" },
  help: "Read <link>the guide</link> first.",
} as const satisfies Namespace;

const fr: Messages<typeof en> = {
  title: "Fusionner PDF",
  greeting: "Bonjour {name}, vous avez {n} pages",
  files: { one: "{count} fichier", other: "{count} fichiers" },
  filesIn: { one: "{count} fichier dans {folder}", other: "{count} fichiers dans {folder}" },
  help: "Lisez d’abord <link>le guide</link>.",
};

describe("interpolate", () => {
  it("replaces every named placeholder", () => {
    expect(interpolate("{a} and {b} and {a}", { a: 1, b: "x" })).toBe("1 and x and 1");
  });

  it("leaves a placeholder visible when its param is missing", () => {
    expect(interpolate("Hello {name}", {})).toBe("Hello {name}");
    expect(interpolate("Hello {name}")).toBe("Hello {name}");
  });
});

describe("selectPlural", () => {
  it("follows the English rules", () => {
    const forms = { one: "one", other: "other" };
    expect(selectPlural(forms, 1, "en")).toBe("one");
    expect(selectPlural(forms, 0, "en")).toBe("other");
    expect(selectPlural(forms, 2, "en")).toBe("other");
  });

  it("follows the French rules (0 and 1 are singular)", () => {
    const forms = { one: "one", other: "other" };
    expect(selectPlural(forms, 0, "fr")).toBe("one");
    expect(selectPlural(forms, 1, "fr")).toBe("one");
    expect(selectPlural(forms, 2, "fr")).toBe("other");
  });

  it("falls back to `other` when the selected category is absent", () => {
    // French selects `many` for 1 000 000; a dictionary with one/other still works.
    expect(selectPlural({ one: "one", other: "other" }, 1_000_000, "fr")).toBe("other");
  });
});

describe("createT", () => {
  const tEn = createT(en, en, "en");
  const tFr = createT(fr, en, "fr");

  it("returns plain strings", () => {
    expect(tEn("title")).toBe("Merge PDF");
    expect(tFr("title")).toBe("Fusionner PDF");
  });

  it("interpolates params", () => {
    expect(tEn("greeting", { name: "Ada", n: 3 })).toBe("Hello Ada, you have 3 pages");
  });

  it("picks the plural form from `count` and interpolates it with the locale's number format", () => {
    expect(tEn("files", { count: 1 })).toBe("1 file");
    expect(tEn("files", { count: 1200 })).toBe("1,200 files");
    expect(tFr("files", { count: 0 })).toBe("0 fichier");
    expect(tFr("files", { count: 1200 })).toBe("1 200 fichiers");
    expect(tFr("filesIn", { count: 2, folder: "A" })).toBe("2 fichiers dans A");
  });

  it("falls back to English when a key is missing at runtime", () => {
    const partial = { title: "Fusionner PDF" } as unknown as Messages<typeof en>;
    expect(createT(partial, en, "fr")("greeting", { name: "Ada", n: 1 })).toBe(
      "Hello Ada, you have 1 pages",
    );
  });

  it("returns the key itself when it exists in no dictionary", () => {
    const loose = tEn as unknown as (key: string) => string;
    expect(loose("nope")).toBe("nope");
  });

  it("type-checks keys and params", () => {
    // These lines are compile-time assertions (checked by `tsc -b`); at runtime they just run.
    // @ts-expect-error unknown key
    tEn("nope");
    // @ts-expect-error missing params for a string with placeholders
    tEn("greeting");
    // @ts-expect-error missing `folder`
    tEn("filesIn", { count: 1 });
    // @ts-expect-error a plural needs `count`
    tEn("files");
    // @ts-expect-error a string without placeholders takes no params
    tEn("title", { x: 1 });
    expect(true).toBe(true);
  });
});

describe("splitRich", () => {
  it("splits a message into text and tagged chunks", () => {
    expect(splitRich("Read <link>the guide</link> first.")).toEqual([
      "Read ",
      { tag: "link", text: "the guide" },
      " first.",
    ]);
  });

  it("returns the text unchanged when there are no tags", () => {
    expect(splitRich("Plain")).toEqual(["Plain"]);
  });
});
