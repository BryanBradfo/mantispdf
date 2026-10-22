import { describe, it, expect } from "vitest";
import { describeError, describeInitError, UserError } from "./describeError";
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
    expect(describeError(new Error("XRef stream entry 7 is odd"), tFr, "fr")).toEqual({
      message: fr.common.errorGeneric,
      details: "XRef stream entry 7 is odd",
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

  it.each([
    ["PDF engine crashed", "Le moteur PDF s’est arrêté. Rechargez la page."],
    ["PDF engine sent an unreadable message", "Le moteur PDF a envoyé une réponse illisible. Rechargez la page."],
    ["Canvas is not available", "Le navigateur ne permet pas de dessiner l’image (canevas indisponible)."],
    ["Image decoding is not supported in this browser", "Ce navigateur ne sait pas décoder cette image."],
    ["Image is too large to decode (limit 100 megapixels)", "Image trop grande pour être décodée (limite de 100\u00a0mégapixels)."],
  ])("translates the engine and browser message %j", (raw, french) => {
    expect(describeError(new Error(raw), tFr, "fr")).toEqual({ message: french, details: null });
    expect(describeError(new Error(raw), tEn, "en")).toEqual({ message: raw, details: null });
  });

  it("lists the unsupported characters in both languages", () => {
    const raw = "Characters not supported by the standard PDF fonts: 日✓";
    expect(describeError(new Error(raw), tEn, "en")).toEqual({ message: raw, details: null });
    expect(describeError(new Error(raw), tFr, "fr")).toEqual({
      message: "Caractères non pris en charge par les polices PDF standard\u00a0: 日✓",
      details: null,
    });
  });

  it.each([
    ["Failed to parse PDF: Invalid file header", "Ce fichier n’est pas un PDF valide, ou il est endommagé.", true],
    ["Failed to parse PDF 2: Invalid file header", "Le PDF 2 n’est pas valide, ou il est endommagé.", true],
    ["Page 9 does not exist (the document has 4 pages)", "La page 9 n’existe pas (le document compte 4\u00a0pages).", false],
    ["Invalid range 3–1 for a 4-page document", "La plage 3-1 n’est pas valide pour un document de 4\u00a0pages.", false],
    ["Invalid edit settings: rect", "Réglages refusés par le moteur PDF.", true],
    ["Redaction verification failed on page 2", "La vérification du caviardage a échoué (page 2). Le fichier n’a pas été enregistré.", false],
    ["OCR engine could not start", "Le moteur OCR n’a pas pu démarrer. Vérifiez votre connexion à ce site et réessayez.", false],
    ["WASM engine not initialized", "Le moteur PDF n’est pas encore prêt. Réessayez dans un instant.", false],
  ])("maps the engine message %j", (raw, french, withDetails) => {
    expect(describeError(new Error(raw), tFr, "fr")).toEqual({ message: french, details: withDetails ? raw : null });
    expect(describeError(new Error(raw), tEn, "en")).toEqual({ message: raw, details: null });
  });
});

describe("describeInitError", () => {
  it("keeps the English alert", () => {
    expect(describeInitError(null, tEn, "en")).toBeNull();
    expect(describeInitError("RuntimeError: unreachable", tEn, "en")).toBe("WASM engine failed to load: RuntimeError: unreachable");
  });

  it("explains a known failure in French, else keeps the raw text as details", () => {
    expect(describeInitError("PDF engine crashed", tFr, "fr")).toEqual({
      message: "Le moteur WASM n’a pas pu se charger\u00a0: Le moteur PDF s’est arrêté. Rechargez la page.",
      details: null,
    });
    expect(describeInitError("RuntimeError: unreachable", tFr, "fr")).toEqual({
      message: "Le moteur PDF n’a pas pu se charger. Rechargez la page.",
      details: "RuntimeError: unreachable",
    });
  });
});
