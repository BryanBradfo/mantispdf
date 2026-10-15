import { describe, it, expect } from "vitest";
import { pickNext } from "./priority";
import type { QueuedJob } from "./types";

const job = (p: Partial<QueuedJob> & { seq: number }): QueuedJob => ({
  doc: "d", page: 2, width: 160, visible: false, ...p,
});

describe("pickNext", () => {
  it("prefers a visible job over earlier hidden ones", () => {
    expect(pickNext([job({ seq: 0 }), job({ seq: 1 }), job({ seq: 2, visible: true })])).toBe(2);
  });
  it("prefers first pages among equally visible jobs (Merge covers)", () => {
    expect(pickNext([job({ seq: 0, page: 3 }), job({ seq: 1, page: 1, doc: "e" })])).toBe(1);
  });
  it("prefers smaller widths when visibility and first-page are equal", () => {
    expect(pickNext([job({ seq: 0, width: 280 }), job({ seq: 1, width: 160 })])).toBe(1);
  });
  it("is FIFO among equals", () => {
    expect(pickNext([job({ seq: 4 }), job({ seq: 2 }), job({ seq: 3 })])).toBe(1);
  });
  it("visibility beats first-page", () => {
    expect(pickNext([job({ seq: 0, page: 1 }), job({ seq: 1, page: 9, visible: true })])).toBe(1);
  });
});
