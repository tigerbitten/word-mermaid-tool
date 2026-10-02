// Stress harness for word-mermaid-tool's Mermaid reader/writer.
//   node run.js                 every corpus/*.mmd
//   node run.js 012 cicd        only files whose name contains one of the args
//   node run.js -v              also print PASS lines' details
//   TOOL=/path/to/word-mermaid-tool node run.js
//   TOOL defaults to ./tool, a snapshot of diagram.js at 71ef36a (the live repo is being edited).
// Oracle: real Mermaid 11.17.2 (../node_modules/mermaid via ../mm.js, headless Chromium).
// Flowcharts: Mermaid's db of the source vs the tool's model, and vs Mermaid's db of toMermaid's output
//   (nodes..direction; styles / group-styles / classes / marks / link-styles; out-* incl. media, click, acc, comments).
// stateDiagram: getData() mapped to the tool's ids (X_start -> start_X, `--` regions folded into their
//   composite): st-states, st-transitions, st-notes, st-composites (members, parent, layout direction), st-styles.
// block-beta: getBlocksFlat() after rendering: bl-blocks, bl-edges, bl-nesting, bl-grid (rows, order, columns, spans), bl-styles.
// For both, out-* compare Mermaid's view of the output with the tool's model, and out-valid wants a flowchart.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { withMermaid } = require(path.join(__dirname, '..', 'mm.js'));

const TOOL = process.env.TOOL || path.join(__dirname, '..', '..');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(TOOL + '/diagram.js', 'utf8') +
  '\nthis.parseMermaid = parseMermaid; this.toMermaid = toMermaid; this.SHAPES = SHAPES; this.cssColor = typeof cssColor === "function" ? cssColor : (x) => x;', ctx);
const { parseMermaid, toMermaid, SHAPES } = ctx;

const args = process.argv.slice(2);
const verbose = args.includes('-v');
const filters = args.filter((a) => a !== '-v');
const dir = path.join(__dirname, 'corpus');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mmd') && (!filters.length || filters.some((x) => f.includes(x)))).sort();

// ---------- normalising, independent of diagram.js ----------
const NAMED = { quot: '"', amp: '&', lt: '<', gt: '>', nbsp: ' ', apos: "'", hellip: '…', copy: '©' };
// Mermaid's db keeps `#quot;` / `#9829;` as placeholders; decode them as the renderer does.
const decode = (s) => String(s)
  .replace(/ﬂ°°(\d+)¶ß/g, (m, n) => String.fromCodePoint(+n))
  .replace(/ﬂ°(\w+)¶ß/g, (m, n) => (n in NAMED ? NAMED[n] : '&' + n + ';'))
  // Mermaid's sanitiser escapes a raw `<` / `&` in label text; the SVG shows them plain.
  .replace(/&(lt|gt|amp|quot);/g, (m, n) => NAMED[n]);
const norm = (s, markdown) => {
  let t = decode(s).replace(/<br\s*\/?>/gi, '\n');
  if (markdown) t = t.replace(/\*\*/g, '').replace(/(^|\W)[*_]([^*_\n]+)[*_](?=\W|$)/g, '$1$2');
  return t.split('\n').map((l) => l.trim().replace(/\s+/g, ' ')).join('\n').trim();
};
// Mermaid's vertex type / v11 shape name -> one canonical name (Mermaid 11 docs' short names).
const ALIAS = {
  square: 'rect', rect: 'rect', proc: 'rect', process: 'rect', rectangle: 'rect',
  round: 'rounded', rounded: 'rounded', event: 'rounded',
  stadium: 'stadium', pill: 'stadium', terminal: 'stadium',
  subroutine: 'fr-rect', 'fr-rect': 'fr-rect', subproc: 'fr-rect', subprocess: 'fr-rect', 'framed-rectangle': 'fr-rect',
  cylinder: 'cyl', cyl: 'cyl', database: 'cyl', db: 'cyl',
  circle: 'circle', circ: 'circle',
  doublecircle: 'dbl-circ', 'dbl-circ': 'dbl-circ', 'double-circle': 'dbl-circ',
  diamond: 'diam', diam: 'diam', decision: 'diam', question: 'diam',
  hexagon: 'hex', hex: 'hex', prepare: 'hex',
  lean_right: 'lean-r', 'lean-r': 'lean-r', 'lean-right': 'lean-r', 'in-out': 'lean-r',
  lean_left: 'lean-l', 'lean-l': 'lean-l', 'lean-left': 'lean-l', 'out-in': 'lean-l',
  trapezoid: 'trap-b', 'trap-b': 'trap-b', 'trapezoid-bottom': 'trap-b', priority: 'trap-b',
  inv_trapezoid: 'trap-t', 'trap-t': 'trap-t', 'trapezoid-top': 'trap-t', manual: 'trap-t', 'inv-trapezoid': 'trap-t',
  odd: 'odd', flag: 'flag', 'paper-tape': 'flag', rect_left_inv_arrow: 'odd', na: 'rect',
  text: 'text', doc: 'doc', document: 'doc',
  'st-rect': 'st-rect', processes: 'st-rect', procs: 'st-rect', 'stacked-rectangle': 'st-rect',
  'h-cyl': 'h-cyl', das: 'h-cyl', 'horizontal-cylinder': 'h-cyl',
  tri: 'tri', extract: 'tri', triangle: 'tri',
  delay: 'delay', 'half-rounded-rectangle': 'delay',
  'sm-circ': 'sm-circ', 'small-circle': 'sm-circ', start: 'sm-circ',
  'cross-circ': 'cross-circ', summary: 'cross-circ', 'crossed-circle': 'cross-circ',
  fork: 'fork', join: 'fork',
  'fr-circ': 'fr-circ', stop: 'fr-circ', 'framed-circle': 'fr-circ',
  'f-circ': 'f-circ', junction: 'f-circ', 'filled-circle': 'f-circ',
  'notch-rect': 'notch-rect', card: 'notch-rect', 'notched-rectangle': 'notch-rect',
  bolt: 'bolt', 'lightning-bolt': 'bolt', 'com-link': 'bolt',
  brace: 'brace', comment: 'brace', 'brace-l': 'brace',
};
const canon = (t) => (t == null ? 'rect' : ALIAS[t] || t);
// The tool's shape names -> what it writes them as (from its own SHAPES table, so new shapes follow).
const BRACKET = { '[]': 'rect', '()': 'rounded', '([])': 'stadium', '[[]]': 'fr-rect', '[()]': 'cyl', '(())': 'circle', '((()))': 'dbl-circ',
  '{}': 'diam', '{{}}': 'hex', '[//]': 'lean-r', '[\\\\]': 'lean-l', '[/\\]': 'trap-b', '[\\/]': 'trap-t', '>]': 'odd' };
const toolShape = (shape) => {
  if (shape === 'point') return 'text';
  if (shape === 'icon' || shape === 'image') return 'rect';
  const w = SHAPES[shape] || SHAPES.rect;
  return w.v11 ? canon(w.v11) : BRACKET[w.open + w.close];
};
// Shapes Mermaid draws without their label (checked by rendering each one).
const NO_LABEL = new Set(['bolt', 'fr-circ', 'f-circ', 'sm-circ', 'cross-circ', 'fork']);
const edgeKind = (type, stroke) => {
  const head = /^double_/.test(type) ? 'both' : type === 'arrow_open' ? 'none' : 'end';
  const mark = (type.match(/arrow_(point|circle|cross|open)$/) || [])[1];
  return { stroke, head, mark };
};
// The diagram an LLM reply's Mermaid oracle gets: its first fenced block, as Mermaid can't read prose.
const oracleText = (src) => {
  const t = src.replace(/\r\n?/g, '\n');
  const m = t.match(/```[ \t]*(?:mermaid)?[ \t]*\n([\s\S]*?)\n[ \t]*```/);
  return m ? m[1] : src;
};

// The tool writes a solid link wider than 2.5px (linkStyle) as `==>` on purpose (linkToken).
const heavy = (e) => e.stroke === 'normal' && +((e.style || '').match(/stroke-width:\s*([\d.]+)/) || [0, 0])[1] >= 2.5;
const dashed = (e, m) => (m.defaultStyle || []).concat(e.styleList || []).some((st) => /^\s*stroke-dasharray\s*:\s*(?!0\s*$|none)/.test(st));
// What Mermaid sees, reduced to comparable facts.
function fromMermaid(m) {
  const sgIds = new Set(m.sg.map((s) => s.id));
  const verts = m.v.filter((v) => !sgIds.has(v.id));
  const vid = new Set(verts.map((v) => v.id));
  const parentOf = {};
  for (const s of m.sg) for (const n of s.nodes) if (sgIds.has(n)) parentOf[n] = s.id;
  const title = (id) => norm(m.sg.find((s) => s.id === id).title, true);
  return {
    dir: m.dir === 'TD' ? 'TB' : m.dir,
    // `style X fill:none,stroke:none` is the tool's borderless text block.
    nodes: Object.fromEntries(verts.map((v) => [v.id, { label: norm(v.text, v.labelType === 'markdown'), shape: v.borderless ? 'text' : canon(v.type), fill: v.borderless ? null : v.fill }])),
    // A dash pattern from linkStyle draws the link dashed: the tool reads that as dotted (diagram.js keeps no pattern).
    edges: m.e.filter((e) => e.stroke !== 'invisible').map((e) => ({ from: e.s, to: e.t, label: norm(e.text, e.labelType === 'markdown'),
      ...edgeKind(e.type, dashed(e, m) ? 'dotted' : heavy(e) ? 'thick' : e.stroke), length: e.length })),
    groups: m.sg.map((s) => ({ id: s.id, title: title(s.id), members: s.nodes.filter((n) => vid.has(n)).sort(), parent: parentOf[s.id] ? title(parentOf[s.id]) : null, dir: s.dir ? s.dir.replace('TD', 'TB') : null })),
  };
}
// The tool's model, reduced the same way.
function fromTool(d) {
  return {
    dir: d.direction === 'TD' ? 'TB' : d.direction,
    nodes: Object.fromEntries(d.nodes.map((n) => [n.id, { label: norm(n.label, false), shape: n.shape === 'text' ? 'text' : toolShape(n.shape), fill: n.fill }])),
    edges: d.edges.map((e) => ({ from: e.from, to: e.to, label: norm(e.label, false), stroke: e.dash === 'dotted' ? 'dotted' : e.width >= 2.5 ? 'thick' : 'normal', head: e.head })),
    groups: d.groups.map((g) => ({ id: g.id, title: norm(g.label, false), members: g.members.slice().sort(), parent: g.parent ? norm(d.groups.find((p) => p.id === g.parent).label, false) : null, dir: g.direction ? g.direction.replace('TD', 'TB') : null })),
  };
}

// ---------- comparisons; each returns a list of differences ----------
const ekey = (e) => e.from + '>' + e.to + (e.label ? '|' + JSON.stringify(e.label) : '');
function multisetDiff(a, b, la, lb) {
  const count = new Map();
  a.forEach((k) => count.set(k, (count.get(k) || 0) + 1));
  b.forEach((k) => count.set(k, (count.get(k) || 0) - 1));
  const out = [];
  for (const [k, c] of count) if (c > 0) out.push(`only ${la}: ${k}${c > 1 ? ' x' + c : ''}`); else if (c < 0) out.push(`only ${lb}: ${k}${c < -1 ? ' x' + -c : ''}`);
  return out;
}
const cmpNodes = (a, b, la, lb) => multisetDiff(Object.keys(a.nodes), Object.keys(b.nodes), la, lb);
const cmpLabels = (a, b, la, lb) => {
  const out = [];
  for (const id in a.nodes) if (b.nodes[id] && !NO_LABEL.has(a.nodes[id].shape) && a.nodes[id].label !== b.nodes[id].label) out.push(`${id}: ${la} ${JSON.stringify(a.nodes[id].label)} vs ${lb} ${JSON.stringify(b.nodes[id].label)}`);
  return out;
};
const cmpEdges = (a, b, la, lb) => multisetDiff(a.edges.map(ekey), b.edges.map(ekey), la, lb);
const cmpEdgeKinds = (a, b, la, lb) => multisetDiff(a.edges.map((e) => `${e.from}>${e.to}:${e.stroke}/${e.head}`), b.edges.map((e) => `${e.from}>${e.to}:${e.stroke}/${e.head}`), la, lb);
const cmpShapes = (a, b, la, lb) => {
  const out = [];
  for (const id in a.nodes) if (b.nodes[id] && a.nodes[id].shape !== b.nodes[id].shape) out.push(`${id}: ${la} ${a.nodes[id].shape} vs ${lb} ${b.nodes[id].shape}`);
  return out;
};
// Groups matched by title (an id-less `subgraph "X"` gets different ids on each side).
const cmpGroups = (a, b, la, lb) => {
  const out = [];
  const used = new Set();
  for (const g of a.groups) {
    const h = b.groups.find((x, i) => !used.has(i) && x.title === g.title && (used.add(i), true));
    if (!h) { out.push(`group ${JSON.stringify(g.title)} only ${la}`); continue; }
    if (g.members.join() !== h.members.join()) out.push(`group ${JSON.stringify(g.title)} members ${la} [${g.members}] vs ${lb} [${h.members}]`);
    if (g.parent !== h.parent) out.push(`group ${JSON.stringify(g.title)} parent ${la} ${g.parent} vs ${lb} ${h.parent}`);
  }
  for (const h of b.groups) if (!a.groups.some((g) => g.title === h.title)) out.push(`group ${JSON.stringify(h.title)} only ${lb}`);
  return out;
};
const cmpDirs = (a, b, la, lb) => {
  const out = a.dir !== b.dir ? [`direction ${la} ${a.dir} vs ${lb} ${b.dir}`] : [];
  for (const g of a.groups) {
    const h = b.groups.find((x) => x.title === g.title);
    if (h && g.dir !== h.dir) out.push(`group ${JSON.stringify(g.title)} direction ${la} ${g.dir} vs ${lb} ${h.dir}`);
  }
  return out;
};

// Full model of the tool, for its own round trip.
const toolFacts = (d) => ({
  title: d.title || null, direction: d.direction,
  nodes: d.nodes.map((n) => [n.id, n.label, n.shape, n.fill, n.bold, n.fontSize, n.x, n.y, n.w, n.h].join('|')),
  edges: d.edges.map((e) => [e.from, e.to, e.label, e.dash, e.head, e.width, e.color].join('|')),
  groups: d.groups.map((g) => [g.id, g.label, g.parent, g.members.slice().sort().join(','), g.direction || '', g.x, g.y, g.w, g.h].join('|')),
});
function cmpToolFacts(a, b) {
  const out = [];
  if (a.title !== b.title) out.push(`title ${a.title} vs ${b.title}`);
  for (const k of ['nodes', 'edges', 'groups']) out.push(...multisetDiff(a[k], b[k], 'parse(x)', 'parse(out)').map((s) => k + ' ' + s));
  return out;
}

// Layout sanity on parse(x).
function layoutProblems(d) {
  const out = [];
  const boxes = d.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h }));
  for (const b of boxes.concat(d.groups)) if (![b.x, b.y, b.w, b.h].every(Number.isFinite)) out.push(`${b.id} not finite: ${[b.x, b.y, b.w, b.h]}`);
  const overlap = (p, q) => p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
  const inside = (p, q) => p.x >= q.x && p.y >= q.y && p.x + p.w <= q.x + q.w && p.y + p.h <= q.y + q.h;
  const grouped = new Set(d.groups.flatMap((g) => g.members));
  const siblings = (items, where) => {
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      if (overlap(items[i], items[j])) out.push(`${where}: ${items[i].id} overlaps ${items[j].id}`);
    }
  };
  const real = (g) => g.w > 0 && g.h > 0;
  siblings(d.nodes.filter((n) => !grouped.has(n.id) && n.w > 0).concat(d.groups.filter((g) => !g.parent && real(g))), 'top level');
  for (const g of d.groups.filter(real)) {
    const kids = g.members.map((id) => d.nodes.find((n) => n.id === id)).filter((n) => n && n.w > 0).concat(d.groups.filter((c) => c.parent === g.id && real(c)));
    for (const k of kids) if (!inside(k, g)) out.push(`${k.id} not inside group ${g.id}`);
    siblings(kids, 'in ' + g.id);
  }
  return out;
}

// Features in the source that the output has no trace of (regex audit, independent of the oracle).
const FEATURES = [
  ['click/href', (s) => /^\s*click\s/m.test(s), (o) => /^\s*click\s/m.test(o)],
  ['%%{init}%% directive', (s) => /%%\{\s*init/.test(s), (o) => /%%\{/.test(o)],
  ['front-matter config', (s) => /^---\n[\s\S]*?^config:/m.test(s.replace(/\r/g, '')), (o) => /^config:/m.test(o)],
  ['classDef names', (s) => /^\s*classDef\s/m.test(s), (o) => /classDef/.test(o)],
  ['edge ids / edge @{...} (animate, curve)', (s) => /\w+@(?:[-=.<ox~])/.test(s), (o) => /\w+@(?:[-=.<ox~])/.test(o)],
  ['circle/cross arrowheads', (s, m) => m.edges.some((e) => /circle|cross/.test(e.mark)), (o, m) => m.edges.some((e) => /circle|cross/.test(e.mark))],
  ['long links (---> length > 1)', (s, m) => m.edges.some((e) => e.length > 1), (o, m) => m.edges.some((e) => e.length > 1)],
  ['%% comments', (s) => /^\s*%%(?!\{)/m.test(s.replace(/^%%.*\b(link|path|route)\b.*$/gm, '')), (o) => /^\s*%%(?!\{| ---|\s\S+ -?\d+,-?\d+ \d+x\d+| link | path | route |.* is a )/m.test(o)],
  ['icon:/img: shape data', (s) => /@\{[^}]*\b(icon|img)\s*:/.test(s), (o) => /\b(icon|img)\s*:/.test(o)],
  ['accTitle/accDescr', (s) => /^\s*acc(Title|Descr)\b/m.test(s), (o) => /acc(Title|Descr)/.test(o)],
  ['style stroke/color/dasharray', (s) => /^\s*(style|classDef)\s.*\b(stroke|color|stroke-dasharray)\s*:/m.test(s), (o) => /^\s*(style|classDef)\s.*\b(stroke:(?!#333)|color:|stroke-dasharray)/m.test(o)],
  ['linkStyle default / interpolate', (s) => /linkStyle\s+default|interpolate/.test(s), (o) => /linkStyle\s+default|interpolate/.test(o)],
  ['italic / partial-bold markdown', (s) => /"`[^`]*(\*[^*\s][^*]*\*|_[^_]+_)[^`]*`"/.test(s) || /"`[^`]*\S[^`]*\*\*[^*]+\*\*[^`]*`"/.test(s), (o) => /"`/.test(o)],
  ['subgraph style (fill)', (s) => /^\s*style\s+(\S+)\s+.*fill/m.test(s) && [...s.matchAll(/^\s*subgraph\s+([A-Za-z0-9_-]+)/gm)].some((m) => new RegExp('^\\s*style\\s+' + m[1] + '\\s+.*fill', 'm').test(s)), (o) => [...o.matchAll(/^\s*subgraph\s+([A-Za-z0-9_-]+)/gm)].some((m) => new RegExp('^\\s*style\\s+' + m[1] + '\\s+.*fill', 'm').test(o))],
];

// ---------- styles, independent of diagram.js ----------
// Mermaid style declarations -> {fill, stroke, strokeWidth, dash, color}; later wins, as in CSS.
// Colours stay raw here and are normalised by the browser (canvas fillStyle) afterwards.
function lookOf(decls) {
  const look = {};
  for (const d of decls.flatMap((s) => String(s).split(/[,;](?![^(]*\))/))) {
    const k = d.indexOf(':');
    if (k < 0) continue;
    const key = d.slice(0, k).trim();
    const v = d.slice(k + 1).replace(/!important/, '').trim();
    if (key === 'fill') look.fill = /^(none|transparent)$/.test(v) ? 'none' : { c: v };
    if (key === 'stroke') look.stroke = v === 'none' ? 'none' : { c: v };
    if (key === 'stroke-width') look.strokeWidth = parseFloat(v);
    if (key === 'stroke-dasharray') look.dash = !/^(0|none)$/.test(v);
    if (key === 'color') look.color = { c: v };
  }
  return look;
}
// The tool's model of a block / group / connector, in the same terms.
const toolLook = (n) => {
  if (n.shape === 'text') return { fill: 'none', stroke: 'none', strokeWidth: n.strokeWidth, dash: !!n.dash, color: n.color && { c: n.color } };
  return { fill: n.fill && { c: n.fill }, stroke: n.stroke && { c: n.stroke }, strokeWidth: n.strokeWidth, dash: !!n.dash, color: n.color && { c: n.color } };
};
const LOOK_KEYS = ['fill', 'stroke', 'strokeWidth', 'dash', 'color'];
const colorCache = new Map();
const lv = (v) => (v && typeof v === 'object' ? colorCache.get(v.c) || v.c : v);
// Every property `want` sets must be the same in `got` (`got` may add more: e.g. the dark border the tool gives a filled block).
function cmpLook(want, got, keys = LOOK_KEYS) {
  const out = [];
  for (const k of keys) if (k in want && want[k] !== undefined) {
    const a = lv(want[k]);
    const b = k === 'dash' ? !!got[k] : lv(got[k]);
    if (String(a) !== String(b)) out.push(`${k} ${a} vs ${b == null ? '(none)' : b}`);
  }
  return out;
}
const collectColors = (x, acc) => {
  if (x && typeof x === 'object') { if (typeof x.c === 'string') acc.add(x.c); else Object.values(x).forEach((v) => collectColors(v, acc)); }
  return acc;
};
const SKIP_CLASSES = /^(default|clickable|statediagram.*|)$/;
const classList = (c) => (Array.isArray(c) ? c : String(c || '').split(/\s+/)).filter((x) => !SKIP_CLASSES.test(x));

// Flowchart: Mermaid's view of looks, classes, links and extras.
function flowExtras(m) {
  const looks = {}, classes = {}, groupLooks = {}, clicks = {};
  for (const n of m.data) {
    if (n.isGroup) groupLooks[norm((m.sg.find((g) => g.id === n.id) || { title: n.id }).title, true)] = lookOf(n.styles);
    else { looks[n.id] = lookOf(n.styles); classes[n.id] = classList(n.classes).sort(); }
  }
  for (const v of m.v) if (v.click.link || v.click.tooltip || v.click.clickable) clicks[v.id] = v.click;
  const edges = m.e.filter((e) => e.stroke !== 'invisible').map((e) => {
    const own = (e.styleList || []).filter((s) => !/^fill:\s*none$/.test(s));
    const k = edgeKind(e.type, e.stroke);
    const dottedKind = e.stroke === 'dotted';
    const text = norm(e.text, e.labelType === 'markdown');
    // arrow_open is a plain line: no end mark at all.
    return { key: e.s + '>' + e.t + (text ? '|' + JSON.stringify(text) : ''), mark: k.mark === 'point' ? 'arrow' : k.head === 'none' || k.mark === 'open' ? 'none' : k.mark || 'none', length: e.length || 1,
      // Mermaid 11.17.2 applies `linkStyle default` and then a link's own linkStyle on top (checked in its SVG).
      look: Object.assign(lookOf((m.defaultStyle || []).concat(own)), dottedKind ? { dash: true } : {}) };
  });
  const classDefs = {};
  for (const [name, c] of Object.entries(m.classes || {})) classDefs[name] = lookOf(c.styles || []);
  return { looks, classes, groupLooks, clicks, edges, classDefs, acc: m.acc };
}

// State diagram: Mermaid ids -> the tool's, regions (`--`) folded into their composite.
function stateFacts(m) {
  const byId = Object.fromEntries(m.data.nodes.map((n) => [n.id, n]));
  const isRegion = (n) => n && n.shape === 'divider';
  const owner = (id) => { let n = byId[id]; while (n && isRegion(n)) n = byId[n.parentId]; return n ? n.id : 'root'; };
  const map = (id) => {
    const n = byId[id];
    if (n && n.shape === 'stateStart') return 'start_' + owner(id.replace(/_start$/, '') === 'root' ? 'root' : id.replace(/_start$/, ''));
    if (n && n.shape === 'stateEnd') return 'end_' + owner(id.replace(/_end$/, '') === 'root' ? 'root' : id.replace(/_end$/, ''));
    return id;
  };
  const parentOf = (n) => { let p = byId[n.parentId]; while (p && isRegion(p)) p = byId[p.parentId]; return p && p.shape !== 'noteGroup' ? p.id : null; };
  const SHAPE = { rect: 'round', rectWithTitle: 'round', choice: 'diamond', fork: 'bar', join: 'bar', stateStart: 'start', stateEnd: 'stop' };
  const nodes = {}, groups = {}, notes = [];
  for (const n of m.data.nodes) {
    if (n.shape === 'note') { notes.push({ of: n.id.split('----')[0], text: norm(n.label) }); continue; }
    if (isRegion(n) || n.shape === 'noteGroup') continue;
    if (n.isGroup) { groups[n.id] = { label: norm(n.label), parent: parentOf(n), members: [], dir: n.dir }; continue; }
    const id = map(n.id);
    nodes[id] = { label: norm([n.label].concat(n.description || []).join('\n')), shape: SHAPE[n.shape] || n.shape, parent: parentOf(n),
      classes: classList(n.cssClasses), look: lookOf(classList(n.cssClasses).flatMap((c) => (m.classes[c] && m.classes[c].styles) || []).concat(n.cssStyles || [])) };
  }
  for (const [id, n] of Object.entries(nodes)) if (n.parent && groups[n.parent] && !groups[n.parent].members.includes(id)) groups[n.parent].members.push(id);
  for (const g of Object.values(groups)) g.members.sort();
  const edges = m.data.edges.filter((e) => !/note-edge/.test(e.classes || '')).map((e) => ({ from: map(e.s), to: map(e.t), label: norm(e.label || '') }));
  return { nodes, groups, notes, edges, dir: m.data.dir === 'TD' ? 'TB' : m.data.dir };
}
function checkState(S, d, check, src) {
  const T = fromTool(d);
  const tn = Object.fromEntries(d.nodes.map((n) => [n.id, n]));
  const SH = { round: 'round', diamond: 'diamond', bar: 'bar', start: 'start', stop: 'stop' };
  check('st-states', Object.entries(S.nodes).flatMap(([id, n]) => {
    const t = tn[id];
    if (!t) return [`state ${id} missing`];
    const out = [];
    if (!['start', 'stop', 'diamond', 'bar'].includes(n.shape) && norm(t.label) !== n.label) out.push(`${id}: label mermaid ${JSON.stringify(n.label)} vs tool ${JSON.stringify(norm(t.label))}`);
    if ((SH[n.shape] || n.shape) !== t.shape) out.push(`${id}: shape mermaid ${n.shape} vs tool ${t.shape}`);
    return out;
  }).concat(d.nodes.filter((n) => !S.nodes[n.id] && !/^note\d+$/.test(n.id)).map((n) => `tool has a state Mermaid doesn't: ${n.id}`)));
  check('st-transitions', multisetDiff(S.edges.map(ekey), d.edges.filter((e) => !/^note\d+$/.test(e.to)).map((e) => ekey({ from: e.from, to: e.to, label: norm(e.label) })), 'mermaid', 'tool'));
  check('st-notes', S.notes.flatMap((nt) => {
    const t = d.nodes.find((n) => /^note\d+$/.test(n.id) && norm(n.label) === nt.text && d.edges.some((e) => e.from === nt.of && e.to === n.id));
    return t ? [] : [`note on ${nt.of} ${JSON.stringify(nt.text)} missing`];
  }).concat(d.nodes.filter((n) => /^note\d+$/.test(n.id)).length !== S.notes.length ? [`notes: mermaid ${S.notes.length} vs tool ${d.nodes.filter((n) => /^note\d+$/.test(n.id)).length}`] : []));
  check('st-composites', Object.entries(S.groups).flatMap(([id, g]) => {
    const t = d.groups.find((x) => x.id === id);
    if (!t) return [`composite ${id} not a group`];
    const out = [];
    const tm = t.members.filter((m) => !/^note\d+$/.test(m)).sort();
    if (tm.join() !== g.members.join()) out.push(`${id} members mermaid [${g.members}] vs tool [${tm}]`);
    if ((t.parent || null) !== g.parent) out.push(`${id} parent mermaid ${g.parent} vs tool ${t.parent}`);
    if (norm(t.label) !== g.label) out.push(`${id} label mermaid ${JSON.stringify(g.label)} vs tool ${JSON.stringify(t.label)}`);
    // Mermaid lays a composite out TB unless it says otherwise, whatever the diagram's direction
    // (checked in its SVG); a subgraph without `direction` inherits the enclosing one.
    const eff = (x) => (x.direction || (x.parent ? eff(d.groups.find((p) => p.id === x.parent)) : d.direction)).replace('TD', 'TB');
    if (g.dir && eff(t) !== g.dir.replace('TD', 'TB')) out.push(`${id} lays out mermaid ${g.dir} vs tool ${eff(t)}`);
    return out;
  }).concat(d.groups.filter((g) => !S.groups[g.id]).map((g) => `tool group ${g.id} not a composite`)));
  check('st-direction', S.dir === T.dir ? [] : [`direction mermaid ${S.dir} vs tool ${T.dir}`]);
  check('st-styles', Object.entries(S.nodes).flatMap(([id, n]) => {
    const t = tn[id];
    if (!t) return [];
    const out = cmpLook(n.look, toolLook(t)).map((s) => id + ': ' + s);
    const tc = (t.classes || []).slice().sort().join();
    if (n.classes.slice().sort().join() !== tc) out.push(`${id}: classes mermaid [${n.classes}] vs tool [${tc}]`);
    return out;
  }));
}

// Block diagram: blocks, edges, nested blocks and the grid.
function blockFacts(m) {
  const all = m.blocks;
  const byId = Object.fromEntries(all.map((b) => [b.id, b]));
  const parent = {};
  for (const b of all) for (const c of b.children) parent[c] = b.id;
  const blocks = {}, groups = {};
  for (const b of all) {
    if (b.id === 'root' || b.type === 'space') continue;
    const look = lookOf((b.classes || []).flatMap((c) => (m.classes[c] && m.classes[c].styles) || []).concat(b.styles || []));
    if (b.type === 'composite') groups[b.id] = { parent: parent[b.id] === 'root' ? null : parent[b.id], members: b.children.filter((c) => byId[c] && byId[c].type !== 'space' && byId[c].type !== 'composite').sort(), size: b.size, span: b.widthInColumns || 1 };
    else blocks[b.id] = { label: norm(b.label), shape: canon(b.type === 'na' ? 'rect' : b.type === 'rect_left_inv_arrow' ? 'odd' : b.type === 'block_arrow' ? 'block-arrow' : b.type), size: b.size, span: b.widthInColumns || 1, parent: parent[b.id], look, classes: classList(b.classes || []) };
  }
  const containers = all.filter((b) => b.type === 'composite' || b.id === 'root').map((b) => ({ id: b.id, kids: b.children.filter((c) => byId[c] && byId[c].type !== 'space' && byId[c].size) }));
  return { blocks, groups, containers, byId, edges: m.blockEdges.map((e) => ({ from: e.s, to: e.t, label: norm(e.label || '') })) };
}
function checkBlock(B, d, check) {
  const tn = Object.fromEntries(d.nodes.map((n) => [n.id, n]));
  check('bl-blocks', Object.entries(B.blocks).flatMap(([id, b]) => {
    const t = tn[id];
    if (!t) return [`block ${id} missing`];
    const out = [];
    if (norm(t.label) !== b.label) out.push(`${id}: label mermaid ${JSON.stringify(b.label)} vs tool ${JSON.stringify(norm(t.label))}`);
    if (b.shape !== toolShape(t.shape)) out.push(`${id}: shape mermaid ${b.shape} vs tool ${toolShape(t.shape)}`);
    return out;
  }).concat(d.nodes.filter((n) => !B.blocks[n.id]).map((n) => `tool has a block Mermaid doesn't: ${n.id}`)));
  check('bl-edges', multisetDiff(B.edges.map(ekey), d.edges.map((e) => ekey({ from: e.from, to: e.to, label: norm(e.label) })), 'mermaid', 'tool'));
  // Nested blocks: by id, or (an anonymous `block`) by members.
  const used = new Set();
  const match = (id, g) => d.groups.find((x) => x.id === id) || d.groups.find((x) => !used.has(x.id) && x.members.slice().sort().join() === g.members.join() && g.members.length);
  const gid = {};
  for (const [id, g] of Object.entries(B.groups)) { const t = match(id, g); if (t) { used.add(t.id); gid[id] = t.id; } }
  check('bl-nesting', Object.entries(B.groups).flatMap(([id, g]) => {
    const t = d.groups.find((x) => x.id === gid[id]);
    if (!t) return [`nested block ${id} not a group`];
    const out = [];
    if (t.members.slice().sort().join() !== g.members.join()) out.push(`${id} members mermaid [${g.members}] vs tool [${t.members.slice().sort()}]`);
    if ((t.parent || null) !== (g.parent ? gid[g.parent] : null)) out.push(`${id} parent mermaid ${g.parent} vs tool ${t.parent}`);
    return out;
  }).concat(d.groups.filter((g) => !Object.values(gid).includes(g.id)).map((g) => `tool group ${g.id} not a nested block`)));
  // The grid, per container: Mermaid's rows (same centre y) share the tool's top y,
  // order along a row is the same, a column (same left x) lines up, and a wider span is wider.
  const box = (id) => { const t = tn[id] || d.groups.find((g) => g.id === (gid[id] || id)); return t && { x: t.x, y: t.y, w: t.w, h: t.h }; };
  const mbox = (id) => { const s = B.byId[id].size; return { x: s.x - s.width / 2, y: s.y, w: s.width }; };
  const grid = [];
  const r1 = (v) => Math.round(v);
  for (const c of B.containers) {
    const kids = c.kids.filter((k) => box(k));
    for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
      const [a, b] = [kids[i], kids[j]];
      const [ma, mb, ta, tb] = [mbox(a), mbox(b), box(a), box(b)];
      const sameRowM = r1(ma.y) === r1(mb.y), sameRowT = r1(ta.y) === r1(tb.y);
      if (sameRowM !== sameRowT) grid.push(`${a},${b}: same row in mermaid ${sameRowM}, tool ${sameRowT}`);
      if (sameRowM && sameRowT && Math.sign(ma.x - mb.x) !== Math.sign(ta.x - tb.x)) grid.push(`${a},${b}: row order differs`);
      if (!sameRowM && Math.sign(ma.y - mb.y) !== Math.sign(ta.y - tb.y)) grid.push(`${a},${b}: row order (y) differs`);
      const sameColM = r1(ma.x) === r1(mb.x), sameColT = r1(ta.x) === r1(tb.x);
      if (sameColM !== sameColT) grid.push(`${a},${b}: same column in mermaid ${sameColM}, tool ${sameColT}`);
      const sa = (B.blocks[a] || B.groups[a]).span, sb = (B.blocks[b] || B.groups[b]).span;
      if (sa !== sb && Math.sign(sa - sb) !== Math.sign(ta.w - tb.w)) grid.push(`${a} (span ${sa}, w ${ta.w}) vs ${b} (span ${sb}, w ${tb.w}): wider span not wider`);
    }
  }
  check('bl-grid', grid);
  check('bl-styles', Object.entries(B.blocks).flatMap(([id, b]) => {
    const t = tn[id];
    if (!t) return [];
    const out = cmpLook(b.look, toolLook(t)).map((s) => id + ': ' + s);
    if (b.classes.slice().sort().join() !== (t.classes || []).slice().sort().join()) out.push(`${id}: classes mermaid [${b.classes}] vs tool [${t.classes || []}]`);
    return out;
  }));
}

// ---------- run ----------
(async () => {
  const work = files.map((f) => {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const r = { f, src, oracle: oracleText(src) };
    try {
      r.d = parseMermaid(src);
      r.out = toMermaid(r.d);
      r.d2 = parseMermaid(r.out);
      r.out2 = toMermaid(r.d2);
    } catch (e) { r.err = e.stack.split('\n').slice(0, 3).join(' | '); }
    return r;
  });

  await withMermaid(async (p) => {
    // img: shapes load their picture to size it; any URL gets a 1x1 PNG (the page is offline).
    await p.route(/^https:\/\/(?!cdn\.jsdelivr\.net)/, (rt) => rt.fulfill({ status: 200, contentType: 'image/png',
      body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64') }));
    const ask = (code) => p.evaluate(async (c) => {
      const m = await window.mm;
      try {
        const dg = await m.mermaidAPI.getDiagramFromText(c);
        const db = dg.db;
        const classes = db.getClasses ? db.getClasses() : {};
        const cls = classes instanceof Map ? Object.fromEntries(classes) : classes;
        const res = { type: dg.type, classes: Object.fromEntries(Object.entries(cls).map(([k, v]) => [k, { styles: v.styles || [] }])),
          acc: [db.getAccTitle ? db.getAccTitle() : '', db.getAccDescription ? db.getAccDescription() : ''] };
        if (/^flowchart/.test(dg.type)) {
          const fillOf = (v) => {
            let fill = null;
            for (const name of ['default'].concat(v.classes || [])) for (const st of (cls[name] && cls[name].styles) || []) { const x = st.match(/^\s*fill\s*:\s*(.*?)\s*$/); if (x) fill = x[1]; }
            for (const st of v.styles || []) { const x = st.match(/^\s*fill\s*:\s*(.*?)\s*$/); if (x) fill = x[1]; }
            return fill;
          };
          const borderless = (v) => { const st = (v.classes || []).flatMap((n) => (cls[n] && cls[n].styles) || []).concat(v.styles || []).join(','); return /fill:\s*none/.test(st) && /stroke:\s*none/.test(st); };
          const es = db.getEdges();
          Object.assign(res, {
            dir: db.getDirection(),
            v: [...db.getVertices().values()].map((x) => ({ id: x.id, text: x.text, type: x.type || null, labelType: x.labelType, fill: fillOf(x), borderless: borderless(x),
              media: (x.icon || x.img) ? { icon: x.icon || null, img: x.img || null, form: x.form || null, pos: x.pos || null, w: x.assetWidth || null, h: x.assetHeight || null, constraint: x.constraint || null } : null,
              click: { link: x.link || null, target: x.linkTarget || null, tooltip: (db.getTooltip && db.getTooltip(x.id)) || null, clickable: (x.classes || []).includes('clickable') } })),
            e: es.map((e) => ({ s: e.start, t: e.end, text: e.text, labelType: e.labelType, type: e.type, stroke: e.stroke, length: e.length, style: (e.style || []).join(','), styleList: e.style || [] })),
            defaultStyle: es.defaultStyle || null,
            sg: db.getSubGraphs().map((s) => ({ id: s.id, title: s.title, nodes: s.nodes, dir: s.dir || null })),
            data: db.getData().nodes.map((n) => ({ id: n.id, isGroup: !!n.isGroup, styles: (n.cssCompiledStyles || []).concat(n.cssStyles || []), classes: n.cssClasses })),
          });
        } else if (/^state/.test(dg.type)) {
          const g = db.getData();
          res.data = { dir: g.direction || null,
            nodes: g.nodes.map((n) => ({ id: n.id, label: n.label, description: n.description, shape: n.shape, isGroup: !!n.isGroup, parentId: n.parentId, cssClasses: n.cssClasses, cssStyles: n.cssStyles, dir: n.dir })),
            edges: g.edges.map((e) => ({ s: e.start, t: e.end, label: e.label, classes: e.classes })) };
        }
        await m.render('r' + Math.random().toString(36).slice(2), c);
        // A block diagram's db is shared and only sized by rendering: read it afterwards.
        if (dg.type === 'block') {
          res.blocks = db.getBlocksFlat().map((b) => ({ id: b.id, label: b.label, type: b.type, widthInColumns: b.widthInColumns, children: (b.children || []).map((x) => x.id),
            size: b.size ? { x: b.size.x, y: b.size.y, width: b.size.width, height: b.size.height } : null, styles: b.styles || [], classes: b.classes || [] }));
          res.blockEdges = db.getEdges().map((e) => ({ s: e.start, t: e.end, label: e.label }));
        }
        return res;
      } catch (e) { return { error: String(e.message || e).split('\n').slice(0, 3).join(' ') }; }
    }, code);
    for (const r of work) {
      r.mSrc = await ask(r.oracle);
      if (r.out) r.mOut = await ask(r.out);
    }
    // Every colour anyone wrote, as the browser reads it (independent of diagram.js's colour table).
    const colors = new Set();
    for (const r of work) {
      collectColors([r.mSrc, r.mOut].map((m) => m && !m.error && m.data && m.data.nodes ? m.data.nodes.map((n) => lookOf(n.cssStyles || [])) : null), colors);
      for (const m of [r.mSrc, r.mOut]) if (m && !m.error) {
        const decls = [].concat(...Object.values(m.classes || {}).map((c) => c.styles), ...(Array.isArray(m.data) ? m.data.map((n) => n.styles) : []), ...(m.e || []).map((e) => e.styleList), m.defaultStyle || [], ...(m.blocks || []).map((b) => b.styles));
        collectColors(lookOf(decls.map((s) => s)), colors);
        for (const s of decls) collectColors(lookOf([s]), colors);
      }
      if (r.d) for (const x of r.d.nodes.concat(r.d.groups)) collectColors({ a: x.fill && { c: x.fill }, b: x.stroke && { c: x.stroke }, c: x.color && { c: x.color } }, colors);
      if (r.d) for (const e of r.d.edges) if (e.color) colors.add(e.color);
    }
    const list = [...colors];
    const normed = await p.evaluate((cs) => {
      const ctx = document.createElement('canvas').getContext('2d');
      return cs.map((c) => { ctx.fillStyle = '#010203'; ctx.fillStyle = c; const a = ctx.fillStyle; ctx.fillStyle = '#030201'; ctx.fillStyle = c; return a === ctx.fillStyle ? a : 'invalid(' + c + ')'; });
    }, list);
    list.forEach((c, i) => colorCache.set(c, normed[i]));
  });

  const tally = {};
  const failures = [];
  const lost = {};
  for (const r of work) {
    const res = [];
    const check = (name, problems) => {
      const ok = !problems.length;
      res.push([name, ok, problems]);
      (tally[name] = tally[name] || { pass: 0, fail: 0, skip: 0, files: [] })[ok ? 'pass' : 'fail']++;
      if (!ok) tally[name].files.push(r.f.slice(0, 3));
    };
    const skip = (name) => { res.push([name, null]); (tally[name] = tally[name] || { pass: 0, fail: 0, skip: 0, files: [] }).skip++; };

    check('source-valid', r.mSrc.error ? ['Mermaid rejects the corpus file: ' + r.mSrc.error] : []);
    check('parse', r.err ? [r.err] : []);
    if (r.err || r.mSrc.error) { print(r, res); continue; }
    const kind = /^flowchart/.test(r.mSrc.type) ? 'flow' : /^state/.test(r.mSrc.type) ? 'state' : r.mSrc.type === 'block' ? 'block' : r.mSrc.type;
    const T = fromTool(r.d);
    let M;
    if (kind === 'flow') {
      M = fromMermaid(r.mSrc);
      check('nodes', cmpNodes(M, T, 'mermaid', 'tool'));
      check('edges', cmpEdges(M, T, 'mermaid', 'tool'));
      check('labels', cmpLabels(M, T, 'mermaid', 'tool'));
      check('edge-kinds', cmpEdgeKinds(M, T, 'mermaid', 'tool'));
      check('shapes', cmpShapes(M, T, 'mermaid', 'tool'));
      check('fills', Object.keys(M.nodes).filter((id) => T.nodes[id] && (colorCache.get(M.nodes[id].fill) || M.nodes[id].fill || '#ffffff').toLowerCase() !== (colorCache.get(T.nodes[id].fill) || T.nodes[id].fill).toLowerCase())
        .map((id) => `${id}: mermaid fill ${M.nodes[id].fill} vs tool ${T.nodes[id].fill}`));
      check('groups', cmpGroups(M, T, 'mermaid', 'tool'));
      check('direction', cmpDirs(M, T, 'mermaid', 'tool'));
      // Newer features, Mermaid's view of the source vs the tool's model.
      const X = flowExtras(r.mSrc);
      const tn = Object.fromEntries(r.d.nodes.map((n) => [n.id, n]));
      check('styles', Object.entries(X.looks).flatMap(([id, l]) => (tn[id] ? cmpLook(l, toolLook(tn[id])).map((s) => id + ': ' + s) : [])));
      check('group-styles', Object.entries(X.groupLooks).flatMap(([id, l]) => {
        const g = r.d.groups.find((x) => norm(x.label) === id);
        return g ? cmpLook(l, { fill: g.fill && { c: g.fill }, stroke: g.stroke && { c: g.stroke }, color: g.color && { c: g.color }, strokeWidth: g.strokeWidth, dash: g.dash }).map((s) => id + ': ' + s) : [];
      }));
      check('classes', Object.entries(X.classes).flatMap(([id, c]) => (tn[id] && c.join() !== (tn[id].classes || []).slice().sort().join() ? [`${id}: mermaid [${c}] vs tool [${tn[id].classes || []}]`] : [])));
      check('marks', multisetDiff(X.edges.map((e) => `${e.key}:${e.mark}:${e.length}`),
        r.d.edges.map((e) => `${ekey({ from: e.from, to: e.to, label: norm(e.label) })}:${e.head === 'none' ? 'none' : e.mark || 'arrow'}:${e.length || 1}`), 'mermaid', 'tool'));
      check('link-styles', multisetDiff(X.edges.map((e) => `${e.key}:${lv(e.look.stroke) || '-'}:${e.look.strokeWidth || '-'}`),
        r.d.edges.map((e) => {
          const want = X.edges.find((x) => x.key === ekey({ from: e.from, to: e.to, label: norm(e.label) }));
          return `${ekey({ from: e.from, to: e.to, label: norm(e.label) })}:${want && want.look.stroke ? lv({ c: e.color }) : '-'}:${want && want.look.strokeWidth ? e.width : '-'}`;
        }), 'mermaid', 'tool'));
    } else if (kind === 'state') {
      checkState(stateFacts(r.mSrc), r.d, check, r.oracle);
    } else if (kind === 'block') {
      checkBlock(blockFacts(r.mSrc), r.d, check);
    }
    check('from', (kind === 'state' ? r.d.from === 'state diagram' : kind === 'block' ? r.d.from === 'block diagram' : !r.d.from) ? [] : [`d.from ${r.d.from} for ${kind}`]);
    check('idempotent', r.out === r.out2 ? [] : [firstDiff(r.out, r.out2)]);
    check('rt-model', cmpToolFacts(toolFacts(r.d), toolFacts(r.d2)));
    check('out-valid', r.mOut.error ? ['Mermaid rejects toMermaid output: ' + r.mOut.error] : !/^flowchart/.test(r.mOut.type) ? ['output is a ' + r.mOut.type] : []);
    if (!r.mOut.error) {
      const O = fromMermaid(r.mOut);
      // A state / block source is compared through the tool's model: Mermaid's own db for those is not a flowchart's.
      const [A, la] = kind === 'flow' ? [M, 'src'] : [T, 'tool'];
      check('out-nodes', cmpNodes(A, O, la, 'out'));
      check('out-edges', cmpEdges(A, O, la, 'out'));
      check('out-labels', cmpLabels(A, O, la, 'out'));
      check('out-edge-kinds', cmpEdgeKinds(A, O, la, 'out'));
      check('out-shapes', cmpShapes(A, O, la, 'out'));
      check('out-groups', cmpGroups(A, O, la, 'out'));
      // A block diagram's direction is whatever its drawing says (toMermaid's flowDirection); nothing to compare.
      if (kind !== 'block') check('out-direction', cmpDirs(A, O, la, 'out'));
      // Mermaid's view of the output against its view of the source: looks, classes, links, extras.
      const XS = kind === 'flow' ? flowExtras(r.mSrc) : null;
      const XO = flowExtras(r.mOut);
      if (XS) {
        check('out-styles', Object.entries(XS.looks).flatMap(([id, l]) => (XO.looks[id] ? cmpLook(l, XO.looks[id]).map((s) => id + ': ' + s) : [])));
        check('out-group-styles', Object.entries(XS.groupLooks).flatMap(([id, l]) => (XO.groupLooks[id] ? cmpLook(l, XO.groupLooks[id]).map((s) => id + ': ' + s) : [`${id}: group gone`])));
        check('out-classes', Object.entries(XS.classes).flatMap(([id, c]) => (XO.classes[id] && c.join() !== XO.classes[id].join() ? [`${id}: src [${c}] vs out [${XO.classes[id]}]`] : []))
          .concat([...new Set(Object.values(XS.classes).flat())].flatMap((c) => (!XO.classDefs[c] ? (XS.classDefs[c] ? [`classDef ${c} gone`] : []) : cmpLook(XS.classDefs[c], XO.classDefs[c]).map((s) => `classDef ${c}: ${s}`)))));
        check('out-marks', multisetDiff(XS.edges.map((e) => `${e.key}:${e.mark}:${e.length}`), XO.edges.map((e) => `${e.key}:${e.mark}:${e.length}`), 'src', 'out'));
        check('out-link-styles', multisetDiff(XS.edges.map((e) => `${e.key}:${lv(e.look.stroke) || '-'}:${e.look.strokeWidth || '-'}:${!!e.look.dash}`),
          XO.edges.map((e) => {
            const w = XS.edges.find((x) => x.key === e.key) || { look: {} };
            return `${e.key}:${w.look.stroke ? lv(e.look.stroke) || '-' : '-'}:${w.look.strokeWidth ? e.look.strokeWidth || '-' : '-'}:${!!e.look.dash}`;
          }), 'src', 'out'));
        const media = (m) => Object.fromEntries(m.v.filter((v) => v.media).map((v) => [v.id, JSON.stringify(v.media)]));
        const ms = media(r.mSrc), mo = media(r.mOut);
        check('out-media', Object.keys(ms).filter((id) => ms[id] !== mo[id]).map((id) => `${id}: src ${ms[id]} vs out ${mo[id]}`));
        check('out-click', Object.entries(XS.clicks).flatMap(([id, c]) => (JSON.stringify(c) !== JSON.stringify(XO.clicks[id] || null) ? [`${id}: src ${JSON.stringify(c)} vs out ${JSON.stringify(XO.clicks[id] || null)}`] : [])));
      }
      check('out-acc', JSON.stringify(r.mSrc.acc) === JSON.stringify(r.mOut.acc) ? [] : [`acc src ${JSON.stringify(r.mSrc.acc)} vs out ${JSON.stringify(r.mOut.acc)}`]);
      // Text Mermaid doesn't keep in its db: comments, directives, front-matter config.
      const outLines = new Set(r.out.split('\n').map((l) => l.trim()));
      const srcLines = r.oracle.replace(/\r/g, '').split('\n').map((l) => l.trim());
      const fm = r.oracle.replace(/\r/g, '').match(/^---\n([\s\S]*?)\n---/);
      check('out-comments', srcLines.filter((l) => /^%%/.test(l) && !outLines.has(l)).map((l) => 'lost: ' + l)
        .concat(fm ? fm[1].split('\n').filter((l) => l.trim() && !/^\s*title:/.test(l) && !r.out.includes(l)).map((l) => 'front matter lost: ' + l) : []));
      // Mermaid's view of the tool's own model (state / block): classes and looks it carries.
      if (kind !== 'flow') {
        const on = Object.fromEntries(r.d.nodes.map((n) => [n.id, n]));
        check('out-styles', Object.entries(XO.looks).flatMap(([id, l]) => (on[id] ? cmpLook(toolLook(on[id]), l, ['fill', 'strokeWidth', 'dash', 'color']).filter((s) => !/^fill #ffffff vs/.test(s)).map((s) => id + ': ' + s) : [])));
      }
      for (const [name, has, kept] of FEATURES) {
        if (has(r.oracle, kind === 'flow' ? M : T) && !kept(r.out, O)) (lost[name] = lost[name] || []).push(r.f.slice(0, 3));
      }
    }
    check('layout', layoutProblems(r.d));
    print(r, res);
  }

  function print(r, res) {
    const bad = res.filter(([, ok]) => ok === false);
    console.log(`${bad.length ? 'FAIL' : 'PASS'} ${r.f}  ` + res.map(([n, ok]) => (ok === null ? '-' : ok ? '' : '!') + (ok ? '' : n)).filter((s) => s && s !== '-').join(' '));
    for (const [n, ok, probs] of res) {
      if (ok === false || (verbose && ok)) console.log(`   ${ok ? 'PASS' : 'FAIL'} ${n}${probs && probs.length ? ': ' + probs.slice(0, 6).join('; ') + (probs.length > 6 ? ` (+${probs.length - 6} more)` : '') : ''}`);
    }
    if (bad.length) failures.push(r.f);
  }

  console.log('\n== summary (' + work.length + ' files, ' + failures.length + ' with a failure) ==');
  for (const [n, t] of Object.entries(tally)) console.log(`${n.padEnd(17)} pass ${String(t.pass).padStart(3)}  fail ${String(t.fail).padStart(3)}${t.files.length ? '   ' + t.files.join(' ') : ''}`);
  console.log('\n== source features with no trace in toMermaid output ==');
  for (const [n, fs_] of Object.entries(lost)) console.log(`${n.padEnd(42)} ${fs_.length} files: ${fs_.join(' ')}`);
  process.exitCode = failures.length ? 1 : 0;
})();

function firstDiff(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return `line ${i + 1}: ${JSON.stringify(x[i])} vs ${JSON.stringify(y[i])}`;
  return 'same';
}
