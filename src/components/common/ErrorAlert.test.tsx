import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ErrorAlert from "./ErrorAlert";

describe("ErrorAlert", () => {
  it("shows a plain message", () => {
    expect(renderToStaticMarkup(<ErrorAlert error="Nope" />)).toContain(">Nope<");
  });

  it("shows a described error with its raw details folded away", () => {
    const html = renderToStaticMarkup(<ErrorAlert error={{ message: "Generic", details: "raw engine text" }} />);
    expect(html).toContain("Generic");
    expect(html).toMatch(/<details[^>]*><summary[^>]*>Details<\/summary>[^<]*raw engine text/);
  });
});
