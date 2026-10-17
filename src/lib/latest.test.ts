import { describe, expect, it } from "vitest";
import { createLatest } from "./latest";

describe("createLatest", () => {
  it("keeps the newest token current and supersedes older ones", () => {
    const latest = createLatest();
    const a = latest.begin();
    expect(a()).toBe(true);
    const b = latest.begin();
    expect(a()).toBe(false);
    expect(b()).toBe(true);
  });

  it("invalidate makes every outstanding token stale", () => {
    const latest = createLatest();
    const a = latest.begin();
    latest.invalidate();
    expect(a()).toBe(false);
    expect(latest.begin()()).toBe(true);
  });
});
