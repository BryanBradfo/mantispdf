import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const robots = readFileSync(resolve(__dirname, "../../public/robots.txt"), "utf8");

/** Each `User-agent` group and its rules. */
const groups = robots
  .split(/\n\s*\n/)
  .map((block) => block.split("\n").filter((l) => !l.startsWith("#") && l.trim()))
  .filter((lines) => lines[0]?.startsWith("User-agent:"));

describe("public/robots.txt", () => {
  it("allows everything for every crawler", () => {
    expect(groups.find((g) => g[0] === "User-agent: *")).toEqual(["User-agent: *", "Allow: /"]);
    expect(robots).not.toMatch(/Disallow/);
  });

  it.each([
    "GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "PerplexityBot",
    "Google-Extended", "Applebot", "CCBot",
  ])("allows %s explicitly", (bot) => {
    expect(groups.find((g) => g[0] === `User-agent: ${bot}`)).toEqual([`User-agent: ${bot}`, "Allow: /"]);
  });

  it("points at the sitemap and llms.txt", () => {
    expect(robots).toContain("Sitemap: https://mantispdf.bradfo.me/sitemap.xml");
    expect(robots).toContain("# llms.txt: https://mantispdf.bradfo.me/llms.txt");
  });
});
