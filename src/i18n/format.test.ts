import { describe, it, expect } from "vitest";
import { formatBytes, formatNumber } from "./format";

describe("formatNumber", () => {
  it("groups digits per locale", () => {
    expect(formatNumber(1234.5, "en")).toBe("1,234.5");
    expect(formatNumber(1234.5, "fr")).toBe("1 234,5");
  });

  it("passes Intl options through", () => {
    expect(formatNumber(0.25, "fr", { style: "percent" })).toBe("25 %");
  });
});

describe("formatBytes", () => {
  // English output is byte-for-byte what CompressPdfPage printed before i18n.
  it("prints KB below 1 MB and MB with one decimal above, in English", () => {
    expect(formatBytes(512, "en")).toBe("1 KB");
    expect(formatBytes(10 * 1024, "en")).toBe("10 KB");
    expect(formatBytes(2 * 1024 * 1024, "en")).toBe("2.0 MB");
    expect(formatBytes(1.55 * 1024 * 1024, "en")).toBe("1.6 MB");
    expect(formatBytes(1536 * 1024 * 1024, "en")).toBe("1536.0 MB");
  });

  it("uses French units, decimal comma and a non-breaking space", () => {
    expect(formatBytes(10 * 1024, "fr")).toBe("10 Ko");
    expect(formatBytes(2.5 * 1024 * 1024, "fr")).toBe("2,5 Mo");
  });
});
