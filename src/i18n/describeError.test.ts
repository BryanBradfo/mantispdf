import { describe, it, expect } from "vitest";
import { describeError, UserError } from "./describeError";
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
    expect(describeError(new Error(raw), tEn, "en")).toEqual({ message, details: null });
  });

  it("translates known engine errors", () => {
    expect(describeError(new Error("Wrong password"), tFr, "fr").message).toBe("Mot de passe incorrect");
    expect(describeError("PDF 3 is password-protected. Unlock it first.", tFr, "fr").message).toBe(
      "Le PDF 3 est protégé par un mot de passe. Déverrouillez-le d’abord.",
    );
  });

  it("in French, falls back to a generic message with the raw text as details", () => {
    expect(describeError(new Error("Invalid edit settings: rect"), tFr, "fr")).toEqual({
      message: fr.common.errorGeneric,
      details: "Invalid edit settings: rect",
    });
  });

  it("in English, shows an unknown engine message as it is (it is already English)", () => {
    expect(describeError(new Error("Invalid edit settings: rect"), tEn, "en")).toEqual({
      message: "Invalid edit settings: rect",
      details: null,
    });
    expect(describeError(42, tEn, "en")).toEqual({ message: "42", details: null });
  });

  it("shows an already translated UserError as it is, in any locale", () => {
    expect(describeError(new UserError("Déjà traduit"), tFr, "fr")).toEqual({ message: "Déjà traduit", details: null });
  });
});
