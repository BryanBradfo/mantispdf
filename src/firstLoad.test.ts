import { describe, it, expect, vi } from "vitest";
import { APP_ROUTES, isRedirect } from "./routes";
import { PAGE_LOADERS, routeLoaderFor, startFirstLoad } from "./firstLoad";

describe("route preloading", () => {
  it("has a loader for every page route", () => {
    const pages = APP_ROUTES.filter((r) => r.path !== "*" && !isRedirect(r)).map((r) => r.path);
    expect(Object.keys(PAGE_LOADERS).sort()).toEqual([...pages].sort());
  });

  it("finds the page of a localized path", () => {
    expect(routeLoaderFor("/fr/merge")).toBe(PAGE_LOADERS["/merge"]);
    expect(routeLoaderFor("/fr")).toBe(PAGE_LOADERS["/"]);
    expect(routeLoaderFor("/merge?x=1")).toBe(PAGE_LOADERS["/merge"]);
    expect(routeLoaderFor("/fr/nope")).toBeUndefined();
  });

  it("on a localized first load, starts the dictionary and the page chunk together", () => {
    const loadLocale = vi.fn(() => new Promise<never>(() => {}));
    const loadRoute = vi.fn(() => new Promise<never>(() => {}));
    startFirstLoad("/fr/merge", { loadLocale, loadRoute });
    expect(loadLocale).toHaveBeenCalledWith("fr");
    expect(loadRoute).toHaveBeenCalledWith("/fr/merge");
  });

  it("does nothing extra on an English first load", () => {
    const loadLocale = vi.fn(() => Promise.resolve());
    const loadRoute = vi.fn(() => Promise.resolve());
    startFirstLoad("/merge", { loadLocale, loadRoute });
    expect(loadLocale).not.toHaveBeenCalled();
    expect(loadRoute).not.toHaveBeenCalled();
  });
});
