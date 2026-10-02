// Geometric defects in the pictures word-mermaid-tool draws for pasted Mermaid.
//   node check.js              every ../stress/corpus/*.mmd and ../*.mmd
//   node check.js 004 hw       only files whose name contains one of the args
//   node check.js -v           also list every defect of every diagram
//   TOOL=/path node check.js   another copy of the tool
// Writes worst/NN-name.png for the 12 worst, and report.json with everything.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const TOOL = process.env.TOOL || path.join(__dirname, '..', '..');
const HERE = __dirname;
const args = process.argv.slice(2);
const verbose = args.includes('-v');
const filters = args.filter((a) => a !== '-v');
const sources = [path.join(HERE, '..', 'stress', 'corpus')]
  .flatMap((dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.mmd')).sort().map((f) => path.join(dir, f)))
  .filter((f) => !filters.length || filters.some((x) => path.basename(f).includes(x)));

// Runs in the pane: the tool's own globals (parseMermaid, edgeGeometry, ...).
function analyze(src) {
  const d = parseMermaid(src);
  const geom = edgeGeometry(d);
  const labels = labelBoxes(d, geom);
  const out = [];
  const add = (kind, sev, what) => out.push({ kind, sev: Math.round(sev * 10) / 10, what });
  const blocks = d.nodes.filter((n) => !isPoint(n) && n.w && n.h);
  const name = (b) => (b.label ? JSON.stringify(String(b.label).slice(0, 24)) : b.id);
  const ov = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const ovSides = (a, b) => [Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)];
  const inside = (pts, p) => {
    let c = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) c = !c;
    }
    return c;
  };
  const distSeg = (p, a, b) => {
    const L = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    const k = L ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / L)) : 0;
    return Math.hypot(a.x + (b.x - a.x) * k - p.x, a.y + (b.y - a.y) * k - p.y);
  };
  const distPoly = (pts, p) => Math.min(...pts.map((a, i) => distSeg(p, a, pts[(i + 1) % pts.length])));
  const outline = new Map(blocks.map((b) => [b, outlineOf(b)]));
  const polyOf = (x) => outline.get(x) || [{ x: x.x, y: x.y }, { x: x.x + x.w, y: x.y }, { x: x.x + x.w, y: x.y + x.h }, { x: x.x, y: x.y + x.h }];
  const legLen = (u, v) => Math.hypot(u.x - v.x, u.y - v.y);

  // --- connectors vs blocks: through, skimming
  d.edges.forEach((e, i) => {
    const pts = geom[i];
    if (!pts || pts.length < 2) return;
    const A = endOf(d, e.from), B = endOf(d, e.to);
    const tag = `${e.from}->${e.to}`;
    for (const r of blocks) {
      const poly = outline.get(r);
      const isEnd = r === A || r === B;
      let inLen = 0, depth = 0, skim = 0;
      for (let k = 1; k < pts.length; k++) {
        const u = pts[k - 1], v = pts[k];
        if (Math.max(u.x, v.x) < r.x - 6 || Math.min(u.x, v.x) > r.x + r.w + 6 || Math.max(u.y, v.y) < r.y - 6 || Math.min(u.y, v.y) > r.y + r.h + 6) continue;
        const L = legLen(u, v);
        for (let s = 0.5; s < L; s += 1) {
          const p = { x: u.x + (v.x - u.x) * s / L, y: u.y + (v.y - u.y) * s / L };
          // A connector's own ends sit on its blocks' outlines: only 4px clear of them counts.
          if (isEnd && (legLen(p, pts[0]) < 4 || legLen(p, pts[pts.length - 1]) < 4)) continue;
          const dd = distPoly(poly, p);
          if (inside(poly, p)) { if (dd > 1.5) { inLen++; depth = Math.max(depth, dd); } }
          else if (dd <= 4 && !(isEnd && (k === 1 || k === pts.length - 1))) skim++;
        }
      }
      if (inLen > 2) add(isEnd ? 'through-own-end' : 'through-block', 20 + Math.min(40, inLen * 0.2) + Math.min(20, depth * 0.5),
        `${tag} runs ${Math.round(inLen)}px inside ${name(r)} (${Math.round(depth)}px deep)`);
      if (skim > 10) add('skim', 3 + Math.min(15, skim * 0.05), `${tag} runs ${skim}px along ${name(r)}'s border`);
    }
  });

  // --- connectors on top of each other
  const segs = [];
  geom.forEach((pts, i) => { if (pts) for (let k = 1; k < pts.length; k++) segs.push([i, pts[k - 1], pts[k]]); });
  const pairLen = new Map();
  for (let a = 0; a < segs.length; a++) for (let b = a + 1; b < segs.length; b++) {
    const [i, u, v] = segs[a], [j, p, q] = segs[b];
    if (i === j) continue;
    const ei = d.edges[i], ej = d.edges[j];
    if ([ei.from, ei.to].some((x) => x === ej.from || x === ej.to)) continue;
    const h1 = Math.abs(u.y - v.y) < 0.5, h2 = Math.abs(p.y - q.y) < 0.5;
    const v1 = Math.abs(u.x - v.x) < 0.5, v2 = Math.abs(p.x - q.x) < 0.5;
    let len = 0;
    if (h1 && h2 && Math.abs(u.y - p.y) <= 2) len = Math.min(Math.max(u.x, v.x), Math.max(p.x, q.x)) - Math.max(Math.min(u.x, v.x), Math.min(p.x, q.x));
    else if (v1 && v2 && Math.abs(u.x - p.x) <= 2) len = Math.min(Math.max(u.y, v.y), Math.max(p.y, q.y)) - Math.max(Math.min(u.y, v.y), Math.min(p.y, q.y));
    if (len > 0) pairLen.set(i + ',' + j, (pairLen.get(i + ',' + j) || 0) + len);
  }
  for (const [k, len] of pairLen) {
    if (len <= 10) continue;
    const [i, j] = k.split(',').map(Number);
    add('edge-overlap', 4 + Math.min(30, len * 0.1), `${d.edges[i].from}->${d.edges[i].to} and ${d.edges[j].from}->${d.edges[j].to} share ${Math.round(len)}px`);
  }

  // --- connector text
  labels.forEach((box, i) => {
    if (!box) return;
    const e = d.edges[i];
    const tag = `text "${String(e.label).slice(0, 20)}" (${e.from}->${e.to})`;
    for (const r of blocks) {
      const [sx, sy] = ovSides(box, r);
      if (sx > 1 && sy > 1) add('label-on-block', 10 + Math.min(30, sx * sy / 40), `${tag} covers ${name(r)} by ${Math.round(sx)}x${Math.round(sy)}`);
    }
    labels.forEach((o, j) => {
      if (!o || j <= i) return;
      const [sx, sy] = ovSides(box, o);
      if (sx > 1 && sy > 1) add('label-on-label', 12 + Math.min(30, sx * sy / 40), `${tag} overlaps text "${String(d.edges[j].label).slice(0, 20)}"`);
    });
    geom.forEach((pts, j) => {
      if (j === i || !pts) return;
      for (let k = 1; k < pts.length; k++) if (crossesBox(pts[k - 1], pts[k], box)) { add('label-crossed', 5, `${tag} crossed by ${d.edges[j].from}->${d.edges[j].to}`); break; }
    });
    for (const g of d.groups) {
      if (!g.w) continue;
      const tab = { x: g.x, y: g.y, w: groupTabWidth(g), h: groupTitleH(g) };
      const [sx, sy] = ovSides(box, tab);
      if (sx > 1 && sy > 1) add('label-on-block', 8, `${tag} covers group tab "${g.label}"`);
    }
  });

  // --- block text overflowing its shape
  for (const n of blocks) {
    if (LABELLESS.has(n.shape) || !shownLabel(n)) continue;
    const size = n.fontSize || DEFAULT_FONT_SIZE;
    const area = labelArea(n);
    const lines = wrapLabel(shownLabel(n), area.w - LABEL_PAD_X * 2, size, n.bold);
    const tw = Math.max(...lines.map((l) => textWidth(l, size, n.bold)));
    const th = lines.length * lineH(size);
    const over = Math.max(tw - (area.w - 4), th - (area.h - 2));
    if (over > 0.5) add('text-overflow', 8 + Math.min(30, over * 0.5), `${name(n)} (${n.shape}) text ${Math.round(tw)}x${th} in ${Math.round(area.w)}x${Math.round(area.h)}`);
  }

  // --- blocks and groups
  const groupOf = new Map();
  for (const g of d.groups) for (const id of groupNodeIds(d, g)) { if (!groupOf.has(id)) groupOf.set(id, []); groupOf.get(id).push(g); }
  for (let a = 0; a < blocks.length; a++) for (let b = a + 1; b < blocks.length; b++) {
    const [sx, sy] = ovSides(blocks[a], blocks[b]);
    if (sx > 1 && sy > 1) add('block-overlap', 25 + Math.min(40, sx * sy / 100), `${name(blocks[a])} and ${name(blocks[b])} overlap ${Math.round(sx)}x${Math.round(sy)}`);
  }
  const shown = d.groups.filter((g) => g.w > 0);
  for (const g of shown) {
    const mine = new Set(groupNodeIds(d, g));
    for (const n of blocks) {
      const [sx, sy] = ovSides(n, g);
      const within = n.x >= g.x - 1 && n.y >= g.y - 1 && n.x + n.w <= g.x + g.w + 1 && n.y + n.h <= g.y + g.h + 1;
      if (mine.has(n.id) && !within) add('outside-group', 20, `${name(n)} sticks out of group "${g.label}"`);
      if (!mine.has(n.id) && sx > 1 && sy > 1) add('foreign-in-group', 20, `${name(n)} lies on group "${g.label}" it isn't in`);
    }
    const tab = { x: g.x, y: g.y, w: groupTabWidth(g), h: groupTitleH(g) };
    for (const n of blocks) {
      const [sx, sy] = ovSides(tab, n);
      if (sx > 1 && sy > 1) add('tab-on-block', 10 + Math.min(20, sx * sy / 40), `group "${g.label}" tab covers ${name(n)}`);
    }
    if (tab.w > g.w + 1) add('tab-overhang', 2, `group "${g.label}" tab ${Math.round(tab.w)} wider than box ${Math.round(g.w)}`);
    for (const h of shown) {
      if (h === g) continue;
      const nested = (x, y) => { for (let p = groupById(d, x.parent); p; p = groupById(d, p.parent)) if (p === y) return true; return false; };
      if (nested(h, g)) {
        if (!(h.x >= g.x - 1 && h.y >= g.y - 1 && h.x + h.w <= g.x + g.w + 1 && h.y + h.h <= g.y + g.h + 1)) add('outside-group', 20, `group "${h.label}" sticks out of "${g.label}"`);
        continue;
      }
      if (nested(g, h) || shown.indexOf(h) < shown.indexOf(g)) continue;
      const [sx, sy] = ovSides(g, h);
      if (sx > 1 && sy > 1) add('group-overlap', 25, `groups "${g.label}" and "${h.label}" overlap ${Math.round(sx)}x${Math.round(sy)}`);
    }
  }

  // --- connector ends, detours
  d.edges.forEach((e, i) => {
    const pts = geom[i];
    if (!pts || pts.length < 2) return;
    const A = endOf(d, e.from), B = endOf(d, e.to);
    const tag = `${e.from}->${e.to}`;
    if (A === B) return;
    for (const [end, p, q, head] of [[A, pts[0], pts[1], e.head === 'both'], [B, pts[pts.length - 1], pts[pts.length - 2], e.head === 'end' || e.head === 'both']]) {
      if (!end || !end.w || isPoint(end)) continue;
      const poly = polyOf(end);
      const gap = distPoly(poly, p);
      if (inside(poly, p) && gap > 3) add('end-buried', 8 + Math.min(20, gap * 0.5), `${tag} end ${Math.round(gap)}px inside ${name(end)}`);
      else if (!inside(poly, p) && gap > 3) add('end-gap', 5 + Math.min(20, gap * 0.5), `${tag} stops ${Math.round(gap)}px short of ${name(end)}`);
      if (head && !e.mark) {
        const { len } = arrowSize(e);
        const L = legLen(p, q);
        if (L < len) add('arrow-on-bend', 3, `${tag} last leg ${Math.round(L)}px, shorter than its arrowhead`);
        const base = { x: p.x + (q.x - p.x) / L * len, y: p.y + (q.y - p.y) / L * len };
        if (inside(poly, base) && distPoly(poly, base) > 1.5) add('end-buried', 8, `${tag} arrowhead inside ${name(end)}`);
      }
    }
    let len = 0;
    for (let k = 1; k < pts.length; k++) len += legLen(pts[k - 1], pts[k]);
    const manh = Math.abs(pts[0].x - pts[pts.length - 1].x) + Math.abs(pts[0].y - pts[pts.length - 1].y);
    const ratio = len / Math.max(manh, 60);
    if (ratio > 3) add('detour', 5 + Math.min(20, (ratio - 3) * 4), `${tag} is ${Math.round(len)}px for ${Math.round(manh)}px apart (${ratio.toFixed(1)}x)`);
  });

  // --- the picture in Word
  const bnd = diagramBounds(d);
  const fit = pictureSize(d).fit;
  const ar = bnd.w / bnd.h;
  if (ar > 6 || ar < 0.25) add('aspect', 3 + (1 - fit) * 40, `${Math.round(bnd.w)}x${Math.round(bnd.h)} (${ar.toFixed(2)}:1), text at ${(fit * 11).toFixed(1)}pt in Word`);
  else if (fit < 0.6) add('aspect', 6 + (0.6 - fit) * 30, `${Math.round(bnd.w)}x${Math.round(bnd.h)}: shrunk to ${Math.round(fit * 100)}%, text at ${(fit * 11).toFixed(1)}pt`);
  return { defects: out, nodes: d.nodes.length, edges: d.edges.length, groups: d.groups.length, size: [Math.round(bnd.w), Math.round(bnd.h)], fit };
}

module.exports = { analyze };
if (require.main === module) (async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (r) => {
    const u = new URL(r.request().url());
    if (u.hostname === 'local.test') return r.fulfill({ path: path.join(TOOL, u.pathname) });
    return r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }); // office.js: absent, as in a plain browser
  });
  await page.goto('http://local.test/taskpane.html');
  await page.waitForFunction(() => typeof parseMermaid === 'function' && typeof labelBoxes === 'function');
  await page.addScriptTag({ content: analyze.toString() });

  const results = [];
  for (const f of sources) {
    const src = fs.readFileSync(f, 'utf8');
    const name = path.relative(path.join(HERE, '..'), f);
    try {
      const r = await page.evaluate((s) => analyze(s), src);
      r.file = name; r.path = f;
      r.score = Math.round(r.defects.reduce((s, x) => s + x.sev, 0));
      results.push(r);
    } catch (e) {
      results.push({ file: name, path: f, error: e.message.split('\n')[0], defects: [], score: 0 });
    }
  }

  const kinds = {};
  for (const r of results) for (const x of r.defects) {
    kinds[x.kind] = kinds[x.kind] || { count: 0, diagrams: new Set() };
    kinds[x.kind].count++; kinds[x.kind].diagrams.add(r.file);
  }
  console.log(`${results.length} diagrams, ${results.filter((r) => r.error).length} failed to parse/route\n`);
  console.log('defect class        count  diagrams');
  for (const [k, v] of Object.entries(kinds).sort((a, b) => b[1].count - a[1].count)) console.log(k.padEnd(18), String(v.count).padStart(6), String(v.diagrams.size).padStart(9));

  const ranked = results.filter((r) => !r.error).sort((a, b) => b.score - a.score);
  console.log('\nrank score  n/e/g     size        file   [top defects]');
  ranked.forEach((r, i) => {
    if (i >= 40 && !verbose) return;
    const by = {};
    for (const x of r.defects) by[x.kind] = (by[x.kind] || 0) + 1;
    console.log(String(i + 1).padStart(4), String(r.score).padStart(5), `${r.nodes}/${r.edges}/${r.groups}`.padEnd(9), r.size.join('x').padEnd(11),
      r.file, ' ', Object.entries(by).map(([k, n]) => `${k}:${n}`).join(' '));
    if (verbose) for (const x of r.defects.slice().sort((a, b) => b.sev - a.sev)) console.log('        ', x.sev, x.kind, x.what);
  });
  for (const r of results.filter((r) => r.error)) console.log('ERROR', r.file, r.error);
  if (errors.length) console.log('page errors:', errors.slice(0, 5));

  // Only a full run replaces the worst-12 pictures and report.json.
  if (filters.length) return browser.close();
  const dir = path.join(HERE, 'worst');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  for (const [i, r] of ranked.slice(0, 12).entries()) {
    const png = await page.evaluate(async (s) => (await renderPng(parseMermaid(s))).base64, fs.readFileSync(r.path, 'utf8'));
    fs.writeFileSync(path.join(dir, `${String(i + 1).padStart(2, '0')}-${path.basename(r.file, '.mmd')}.png`), Buffer.from(png, 'base64'));
  }
  fs.writeFileSync(path.join(HERE, 'report.json'), JSON.stringify(ranked.concat(results.filter((r) => r.error)), (k, v) => (v instanceof Set ? [...v] : v), 1));
  await browser.close();
})();
