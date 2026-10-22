import { describe, it, expect } from "vitest";
import { en } from "./locales/en";
import fr from "./locales/fr/fr";
import type { MessageValue } from "./types";

/** Placeholders and tags a message uses, across all its plural forms. */
function tokens(value: MessageValue | undefined): string[] {
  const texts = value === undefined ? [] : typeof value === "string" ? [value] : Object.values(value);
  const found = new Set<string>();
  for (const text of texts) {
    for (const m of (text ?? "").matchAll(/\{\w+\}|<\/?\w+>/g)) found.add(m[0]);
  }
  return [...found].sort();
}

const rows = Object.entries(en).flatMap(([ns, messages]) =>
  Object.entries(messages).map(([key, value]) => {
    const frNs: Record<string, MessageValue> = fr[ns as keyof typeof fr];
    return [`${ns}.${key}`, value as MessageValue, frNs[key]] as const;
  }),
);

describe("French dictionary parity", () => {
  it("has a French message for every English key", () => {
    expect(rows.filter(([, , frValue]) => frValue === undefined).map(([id]) => id)).toEqual([]);
  });

  it.each(rows)("%s uses the same {placeholders} and <tags>", (_id, enValue, frValue) => {
    expect(tokens(frValue)).toEqual(tokens(enValue));
  });
});
