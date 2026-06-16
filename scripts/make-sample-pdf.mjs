// Generates public/sample-paper.pdf — a one-page mock scientific paper used by
// the landing's "Parse a PDF" demo button. The prose and equations here MUST
// stay in sync with the mock Markdown/LaTeX in
// src/components/landing/Workspace.tsx (SAMPLE_MARKDOWN / SAMPLE_LATEX) so the
// left (rendered PDF) and right (extracted text) panels show the same content.
//
// Run:  node scripts/make-sample-pdf.mjs
import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../public/sample-paper.pdf", import.meta.url));

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  @page { size: 8.5in 11in; margin: 1in 1.05in; }
  * { box-sizing: border-box; }
  body { font-family: Georgia, "Times New Roman", serif; color: #111; font-size: 11pt; line-height: 1.5; margin: 0; }
  h1.title { font-size: 17pt; text-align: center; margin: 0 0 8pt; font-weight: 700; line-height: 1.25; }
  .authors { text-align: center; font-size: 10.5pt; margin-bottom: 1pt; }
  .affil { text-align: center; font-style: italic; font-size: 9.5pt; color: #555; margin-bottom: 20pt; }
  h2 { font-size: 12pt; margin: 18pt 0 7pt; }
  p { text-align: justify; margin: 0 0 9pt; }
  .abstract { font-size: 10pt; margin: 0 26pt 14pt; }
  .abstract .lead { font-variant: small-caps; letter-spacing: .04em; }
  i, .v { font-style: italic; }
  .eq { position: relative; text-align: center; margin: 13pt 0; font-size: 12pt; }
  .eqno { position: absolute; right: 0; top: 50%; transform: translateY(-50%); font-size: 11pt; }
  .frac { display: inline-flex; flex-direction: column; vertical-align: middle; text-align: center; margin: 0 3px; }
  .frac .n { border-bottom: 1px solid #111; padding: 0 5px; line-height: 1.2; }
  .frac .d { padding: 0 5px; line-height: 1.2; }
  .sum { display: inline-flex; flex-direction: column; align-items: center; vertical-align: middle; font-size: 8.5pt; margin: 0 3px; line-height: 1; }
  .sum .b { font-size: 19pt; line-height: .9; }
  sub, sup { font-size: 72%; }
</style>
</head>
<body>
  <h1 class="title">Physics-Informed Neural Networks<br/>for the Poisson Equation</h1>
  <div class="authors">A. Mantis &nbsp;&middot;&nbsp; B. Chen</div>
  <div class="affil">MantisPDF Research</div>

  <p class="abstract"><span class="lead">Abstract.</span>
    We study physics-informed neural networks (PINNs) for solving the Poisson
    equation on a bounded domain <i>&Omega;</i> &sub; &#8477;<sup>2</sup>. The
    network <i>u</i><sub><i>&theta;</i></sub> is trained to satisfy the PDE
    residual together with the boundary data, removing the need for a meshed
    solver.</p>

  <h2>2.&nbsp;&nbsp;Method</h2>

  <p>We seek <i>u</i><sub><i>&theta;</i></sub> approximating the solution of the
    Poisson problem:</p>

  <div class="eq">
    &minus;&Delta;<i>u</i>(<i>x</i>) = <i>f</i>(<i>x</i>),&nbsp;&nbsp;<i>x</i> &isin; <i>&Omega;</i>,
    &emsp; <i>u</i>(<i>x</i>) = <i>g</i>(<i>x</i>),&nbsp;&nbsp;<i>x</i> &isin; &part;<i>&Omega;</i>.
    <span class="eqno">(1)</span>
  </div>

  <p>The composite training objective combines a data term and a PDE residual:</p>

  <div class="eq">
    &#8466;(<i>&theta;</i>) = &#8466;<sub>data</sub>(<i>&theta;</i>) + <i>&lambda;</i>&#8201;&#8466;<sub>pde</sub>(<i>&theta;</i>),
    <span class="eqno">(2)</span>
  </div>

  <p>where the residual is evaluated at <i>N</i><sub><i>r</i></sub> collocation
    points:</p>

  <div class="eq">
    &#8466;<sub>pde</sub>(<i>&theta;</i>) =
    <span class="frac"><span class="n">1</span><span class="d"><i>N</i><sub><i>r</i></sub></span></span>
    <span class="sum"><span><i>N</i><sub><i>r</i></sub></span><span class="b">&Sigma;</span><span><i>i</i>=1</span></span>
    &#8739;&#8201;&Delta;<i>u</i><sub><i>&theta;</i></sub>(<i>x</i><sub><i>i</i></sub>) + <i>f</i>(<i>x</i><sub><i>i</i></sub>)&#8201;&#8739;<sup>2</sup>.
    <span class="eqno">(3)</span>
  </div>

  <p>Minimizing &#8466;(<i>&theta;</i>) drives the network toward a solution that
    is consistent with both the observed data and the governing equation, while
    the weight <i>&lambda;</i> balances the two terms.</p>
</body>
</html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle" });
  await page.pdf({ path: OUT, printBackground: true, preferCSSPageSize: true });
  console.log("Wrote", OUT);
} finally {
  await browser.close();
}
