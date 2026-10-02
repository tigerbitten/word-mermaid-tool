// Mermaid 11.17.2 from npm, served in place of jsDelivr, in headless Chromium.
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path");
const DIST = path.join(__dirname, "node_modules/mermaid/dist");
const BASE = "https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/";
async function withMermaid(fn) {
  const b = await chromium.launch(); const p = await b.newPage();
  await p.route("https://cdn.jsdelivr.net/**", r => {
    const u = r.request().url();
    if (!u.startsWith(BASE)) return r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><body></body>" });
    return r.fulfill({ status: 200, contentType: "text/javascript", body: fs.readFileSync(path.join(DIST, u.slice(BASE.length))) });
  });
  await p.goto(BASE + "../README.md");
  await p.evaluate(u => window.mm = import(u).then(({ default: m }) => { m.initialize({ startOnLoad: false, htmlLabels: false, flowchart: { htmlLabels: false, useMaxWidth: false } }); return m; }), BASE + "mermaid.esm.min.mjs");
  try { return await fn(p); } finally { await b.close(); }
}
module.exports = { withMermaid };
if (require.main === module) withMermaid(async p => {
  for (const code of process.argv.slice(2)) {
    const r = await p.evaluate(async c => { const m = await window.mm; try { const { svg } = await m.render("r" + Math.random().toString(36).slice(2), c);
      const d = new DOMParser().parseFromString(svg, "image/svg+xml"); return [...d.querySelectorAll(".nodeLabel, .label text, text")].map(t => t.textContent).filter(Boolean).join(" / "); } catch (e) { return "ERR " + e.message; } }, code);
    console.log(JSON.stringify(code), "->", r);
  }
});
