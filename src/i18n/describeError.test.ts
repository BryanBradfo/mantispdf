import { describe, it, expect } from "vitest";
import { describeError } from "./describeError";
import { createT } from "./translate";
import { en } from "./locales/en";
import fr from "./locales/fr/fr";

const tEn = createT(en.common, en.common, "en");
const tFr = createT(fr.common, en.common, "fr");

describe("describeError", () => {
  it.each([
    ["Wrong password", "Wrong password"],
    ["This PDF is password-protected. Unlock it first.", "This PDF is password-protected. Unlock it first."],
    ["PDF 2 is password-protected. Unlock it first.", "PDF 2 is password-protected. Unlock it first."],
  ])("keeps the English engine text for %s", (raw, message) => {
    expect(describeError(new Error(raw), tEn)).toEqual({ message, details: null });
  });

  it("translates known engine errors", () => {
    expect(describeError(new Error("Wrong password"), tFr).message).toBe("Mot de passe incorrect");
    expect(describeError("PDF 3 is password-protected. Unlock it first.", tFr).message).toBe(
      "Le PDF 3 est protégé par un mot de passe. Déverrouillez-le d’abord.",
    );
  });

  it("falls back to a generic message with the raw text as details", () => {
    expect(describeError(new Error("Invalid edit settings: rect"), tFr)).toEqual({
      message: fr.common.errorGeneric,
      details: "Invalid edit settings: rect",
    });
    expect(describeError(42, tEn)).toEqual({ message: en.common.errorGeneric, details: "42" });
  });
});
