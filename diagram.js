// The diagram model, and Mermaid text in/out.
//
// A diagram is a plain object:
//   { direction,
//     nodes: [{id,label,shape,x,y,w,h,fill,fontSize,bold}],
//     edges: [{from,to,label,dash,head,width,color,fontSize,bold,route,
//              fromAnchor,toAnchor,points}],
//     groups: [{id,label,members:[nodeId],parent,x,y,w,h}] }
//
// A group's members are its own blocks; a group inside another names it as
// `parent`. A connector's end is a block's id or a group's (`B --> G`).
//
// Nodes carry their own geometry because the canvas is the source of truth --
// Mermaid's layout engine is never run. Positions round-trip as `%%` comment
// lines, so the saved text stays a valid Mermaid document that renders
// anywhere and reads natively to an LLM.

// Shapes with a classic bracket form are written that way -- it is the syntax
// LLMs have seen most. The rest use Mermaid 11's `id@{ shape: ... }` form,
// which is the only way standard Mermaid can express them.
const SHAPES = {
  rect:              { open: '[',   close: ']'   },
  round:             { open: '(',   close: ')'   },
  stadium:           { open: '([',  close: '])'  },
  subroutine:        { open: '[[',  close: ']]'  },
  cylinder:          { open: '[(',  close: ')]'  },
  circle:            { open: '((',  close: '))'  },
  doublecircle:      { open: '(((', close: ')))' },
  diamond:           { open: '{',   close: '}'   },
  hexagon:           { open: '{{',  close: '}}'  },
  parallelogram:     { open: '[/',  close: '/]'  },
  parallelogram_alt: { open: '[\\', close: '\\]' },
  trapezoid:         { open: '[/',  close: '\\]' },
  trapezoid_alt:     { open: '[\\', close: '/]'  },
  flag:              { open: '>',   close: ']'   },
  text:              { open: '[',   close: ']'   }, // borderless; marked by its style line
  document:          { v11: 'doc' },
  stacked:           { v11: 'st-rect' },
  queue:             { v11: 'h-cyl' },
  buffer:            { v11: 'tri' },
  delay:             { v11: 'delay' },
  junction:          { v11: 'f-circ' },
  start:             { v11: 'sm-circ' },
  sum:               { v11: 'cross-circ' },
  bar:               { v11: 'fork' },
  // Architecture and the rest of the flowchart set, each Mermaid 11's own name.
  cloud:             { v11: 'cloud' },
  person:            { v11: 'person' },
  browser:           { v11: 'browser' },
  console:           { v11: 'console' },
  bucket:            { v11: 'bucket' },
  folder:            { v11: 'folder' },
  datastore:         { v11: 'datastore' },
  disk:              { v11: 'lin-cyl' },
  storage:           { v11: 'win-pane' },
  stored:            { v11: 'bow-rect' },
  documents:         { v11: 'docs' },
  lined_doc:         { v11: 'lin-doc' },
  tagged_doc:        { v11: 'tag-doc' },
  card:              { v11: 'notch-rect' },
  tagged:            { v11: 'tag-rect' },
  divided:           { v11: 'div-rect' },
  lined:             { v11: 'lin-rect' },
  display:           { v11: 'curv-trap' },
  loop_limit:        { v11: 'notch-pent' },
  collate:           { v11: 'hourglass' },
  manual_file:       { v11: 'flip-tri' },
  manual_input:      { v11: 'sl-rect' },
  stop:              { v11: 'fr-circ' },
  brace:             { v11: 'brace' },
  brace_r:           { v11: 'brace-r' },
  braces:            { v11: 'braces' },
  bolt:              { v11: 'bolt' },
  // The loose end of a free-standing line. Mermaid has no line without a node
  // at each end, so a loose end is an invisible, zero-size, label-less node --
  // written as an empty text node, which Mermaid also draws as nothing.
  point:             { v11: 'text' },
};

// What a symbol means, for the ones whose Mermaid shape doesn't say it: to
// Mermaid a junction is a small circle and a FIFO a horizontal cylinder. Said
// in a comment so an LLM reading the alt text knows what it's looking at.
// Only symbols nothing else uses: a trapezoid or a hexagon in pasted Mermaid
// means whatever its writer meant, so calling it a mux or a bus would be wrong.
const SYMBOL_MEANING = {
  buffer: 'buffer/driver', delay: 'delay element', queue: 'queue/FIFO', sum: 'summing junction',
  junction: 'wire junction', bar: 'bus bar',
};

// Every name Mermaid 11 accepts in `@{ shape: ... }` for a shape we draw,
// aliases included, since an LLM may write any of them.
const V11_NAMES = {
  rect: ['rect', 'rectangle', 'proc', 'process'],
  round: ['rounded', 'event'],
  stadium: ['stadium', 'pill', 'terminal'],
  subroutine: ['subproc', 'subprocess', 'subroutine', 'fr-rect', 'framed-rectangle'],
  cylinder: ['cyl', 'cylinder', 'database', 'db'],
  circle: ['circle', 'circ'],
  doublecircle: ['dbl-circ', 'double-circle'],
  diamond: ['diam', 'diamond', 'decision', 'question'],
  hexagon: ['hex', 'hexagon', 'prepare'],
  parallelogram: ['lean-r', 'lean-right', 'in-out'],
  parallelogram_alt: ['lean-l', 'lean-left', 'out-in'],
  trapezoid: ['trap-b', 'trapezoid-bottom', 'priority', 'trapezoid'],
  trapezoid_alt: ['trap-t', 'trapezoid-top', 'manual', 'inv-trapezoid'],
  flag: ['flag', 'paper-tape', 'odd'],
  text: ['text'],
  document: ['doc', 'document'],
  stacked: ['st-rect', 'processes', 'procs', 'stacked-rectangle'],
  queue: ['h-cyl', 'das', 'horizontal-cylinder'],
  buffer: ['tri', 'extract', 'triangle'],
  delay: ['delay', 'half-rounded-rectangle'],
  junction: ['f-circ', 'filled-circle', 'junction'],
  start: ['sm-circ', 'small-circle', 'start'],
  sum: ['cross-circ', 'summary', 'crossed-circle'],
  bar: ['fork', 'join'],
  cloud: ['cloud'],
  person: ['person'],
  browser: ['browser'],
  console: ['console'],
  bucket: ['bucket'],
  folder: ['folder', 'directory'],
  datastore: ['datastore', 'data-store'],
  disk: ['lin-cyl', 'disk', 'lined-cylinder'],
  storage: ['win-pane', 'internal-storage', 'window-pane'],
  stored: ['bow-rect', 'stored-data', 'bow-tie-rectangle'],
  documents: ['docs', 'documents', 'st-doc', 'stacked-document'],
  lined_doc: ['lin-doc', 'lined-document'],
  tagged_doc: ['tag-doc', 'tagged-document'],
  card: ['notch-rect', 'card', 'notched-rectangle'],
  tagged: ['tag-rect', 'tag-proc', 'tagged-rectangle', 'tagged-process'],
  divided: ['div-rect', 'div-proc', 'divided-rectangle', 'divided-process'],
  lined: ['lin-rect', 'lin-proc', 'lined-rectangle', 'lined-process', 'shaded-process'],
  display: ['curv-trap', 'curved-trapezoid', 'display'],
  loop_limit: ['notch-pent', 'loop-limit', 'notched-pentagon'],
  collate: ['hourglass', 'collate'],
  manual_file: ['flip-tri', 'manual-file', 'flipped-triangle'],
  manual_input: ['sl-rect', 'manual-input', 'sloped-rectangle'],
  stop: ['fr-circ', 'framed-circle', 'stop'],
  brace: ['brace', 'comment', 'brace-l'],
  brace_r: ['brace-r'],
  braces: ['braces'],
  bolt: ['bolt', 'com-link', 'lightning-bolt'],
};
const SHAPE_BY_V11 = {};
for (const shape in V11_NAMES) for (const name of V11_NAMES[shape]) SHAPE_BY_V11[name] = shape;

// Wiring symbols carry no text: a junction dot, a summing node, a bus bar.
// They get their own natural size instead of a text box's.
const LABELLESS = new Set(['junction', 'start', 'sum', 'bar', 'point', 'stop', 'bolt']);
const SHAPE_SIZE = { junction: [14, 14], start: [20, 20], sum: [40, 40], bar: [10, 80], point: [0, 0], stop: [28, 28], bolt: [30, 50],
  person: [100, 90], cloud: [150, 90], collate: [60, 70], manual_file: [130, 70] };

const isPoint = (n) => !!n && n.shape === 'point';

const LAYOUT_HEADER = '%% --- layout (word-mermaid-tool v1; safe to ignore) ---';
const FENCE_OPEN = '```mermaid';

const DEFAULT_W = 140;
const DEFAULT_H = 56;
const DEFAULT_FONT_SIZE = 13;
const DEFAULT_EDGE_W = 1.5;
const DEFAULT_EDGE_FONT = 12;

function newDiagram() {
  return { direction: 'LR', nodes: [], edges: [], groups: [] };
}

function newEdge(from, to) {
  // `route` is 'elbow' (right angles, the default) or 'straight' (one direct
  // line, at whatever angle the two blocks sit).
  return { from, to, label: '', dash: 'solid', head: 'end', width: DEFAULT_EDGE_W, color: null,
           fontSize: DEFAULT_EDGE_FONT, bold: false, route: 'elbow',
           fromAnchor: null, toAnchor: null, points: null };
}

function defaultSize(shape) {
  return SHAPE_SIZE[shape] || [DEFAULT_W, DEFAULT_H];
}

function nodeById(d, id) {
  return d.nodes.find((n) => n.id === id) || null;
}

function groupById(d, id) {
  return d.groups.find((g) => g.id === id) || null;
}

// What a connector's end is attached to: a block, or a whole group.
function endOf(d, id) {
  return nodeById(d, id) || groupById(d, id);
}

function childGroups(d, g) {
  return d.groups.filter((c) => c.parent === g.id);
}

// Every block in a group, its subgroups' included.
function groupNodeIds(d, g) {
  return g.members.concat(...childGroups(d, g).map((c) => groupNodeIds(d, c)));
}

function groupDepth(d, g) {
  let k = 0;
  for (let p = groupById(d, g.parent); p; p = groupById(d, p.parent)) k++;
  return k;
}

// Words Mermaid's grammar claims. A node called `end` in particular ends the
// enclosing subgraph and breaks the whole diagram in every Mermaid renderer.
const RESERVED_IDS = new Set(['end', 'subgraph', 'graph', 'flowchart', 'style', 'linkstyle',
  'classdef', 'class', 'click', 'direction', 'call', 'href', 'default']);

// Mermaid ids must be identifier-ish. Derived from the label once at creation
// and then frozen -- renaming a node must not churn every edge that refers to
// it, and must not break the saved text.
function makeId(label, taken) {
  let base = String(label || '').replace(/[^A-Za-z0-9_]/g, '');
  if (!base || /^[0-9]/.test(base) || RESERVED_IDS.has(base.toLowerCase())) base = 'n' + base;
  base = base.slice(0, 24);
  let id = base;
  let i = 2;
  while (taken.has(id)) id = base + i++;
  return id;
}

// Labels are written as typed, so the alt text reads naturally ("Attempts >=
// 3?", "C# client", "a|b"), except what Mermaid would take for something else
// inside a quoted label: `"` ends it, `#name;` is an entity, `<` before a
// letter or `/` opens an HTML tag (a typed "<br/>" must stay text), and a raw
// newline would end the statement. Checked against Mermaid 11's renderer.
function quoteLabel(text) {
  const escaped = String(text == null ? '' : text)
    .replace(/#(?=[A-Za-z0-9]+;)/g, '#35;')
    .replace(/"/g, '#quot;')
    .replace(/<(?=[A-Za-z/!])/g, '#lt;')
    .replace(/\r?\n/g, '<br/>');
  return '"' + escaped + '"';
}

function unquoteLabel(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') s = s.slice(1, -1);
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/#quot;/g, '"')
    .replace(/#124;/g, '|')
    .replace(/#lt;/g, '<')
    .replace(/#gt;/g, '>')
    .replace(/#35;/g, '#');
}

function nodeDecl(n) {
  const s = SHAPES[n.shape] || SHAPES.rect;
  // A single space, not "": Mermaid shows a node's id in place of an empty
  // label, so "" would print "point" wherever the diagram is rendered.
  if (isPoint(n)) return n.id + '@{ shape: text, label: " " }';
  if (s.v11) {
    return n.id + '@{ shape: ' + s.v11 + (LABELLESS.has(n.shape) ? '' : ', label: ' + quoteLabel(n.label)) + ' }';
  }
  return n.id + s.open + quoteLabel(n.label) + s.close;
}

// Dash and arrowheads map straight onto Mermaid's link syntax. A heavy edge is
// written with the `==` form so thickness survives in other renderers too;
// `linkStyle` pins down the exact width. A dotted link has no heavy form.
function linkToken(e) {
  // From the menu's "heavy" up, so a connector drawn heavy reads as thick to
  // an LLM and to any other renderer, not just through its linkStyle.
  const heavy = (e.width || DEFAULT_EDGE_W) >= 2.5;
  if (e.dash === 'dotted') return e.head === 'none' ? '-.-' : e.head === 'both' ? '<-.->' : '-.->';
  if (heavy) return e.head === 'none' ? '===' : e.head === 'both' ? '<==>' : '==>';
  return e.head === 'none' ? '---' : e.head === 'both' ? '<-->' : '-->';
}

function edgeDecl(e) {
  const label = e.label ? '|' + quoteLabel(e.label) + '|' : '';
  return e.from + ' ' + linkToken(e) + label + ' ' + e.to;
}

// Only emitted when it carries information: a borderless text label, a
// non-default fill, text size or weight. All standard Mermaid `style`
// statements, so they survive a round-trip through any other Mermaid tool.
function styleDecl(n) {
  const parts = [];
  if (n.shape === 'text') parts.push('fill:none', 'stroke:none');
  else if (n.fill && n.fill !== '#ffffff') parts.push('fill:' + n.fill, 'stroke:#333');
  if (n.fontSize && n.fontSize !== DEFAULT_FONT_SIZE) parts.push('font-size:' + n.fontSize + 'px');
  if (n.bold) parts.push('font-weight:bold');
  return parts.length ? 'style ' + n.id + ' ' + parts.join(',') : null;
}

function linkStyleDecl(e, i) {
  const parts = [];
  const w = e.width || DEFAULT_EDGE_W;
  if (w !== DEFAULT_EDGE_W) parts.push('stroke-width:' + w + 'px');
  if (e.color) parts.push('stroke:' + e.color, 'color:' + e.color);
  if (e.fontSize && e.fontSize !== DEFAULT_EDGE_FONT) parts.push('font-size:' + e.fontSize + 'px');
  if (e.bold) parts.push('font-weight:bold');
  return parts.length ? 'linkStyle ' + i + ' ' + parts.join(',') : null;
}

function layoutLine(item) {
  return '%% ' + item.id + ' ' + Math.round(item.x) + ',' + Math.round(item.y) +
    ' ' + Math.round(item.w) + 'x' + Math.round(item.h);
}

// Where an edge meets a block: which side, and how far along it. Only written
// when the user attached it somewhere by hand -- otherwise the side is
// re-derived on every render, which is what lets connectors follow blocks as
// you drag them. A side with no position (`e`) keeps the side but lets the
// position float with the fan-out.
function anchorText(a) {
  if (!a) return '-';
  return a.t == null ? a.side : a.side + a.t.toFixed(3);
}

const cx = (n) => n.x + n.w / 2;
const cy = (n) => n.y + n.h / 2;

// Which way the diagram flows, read off the drawing itself: the axis most
// connectors run along, and the way the arrows on that axis mostly point. The
// header is how Mermaid lays a diagram out and how an LLM reads its flow, so
// one drawn top to bottom must not claim to run left to right.
function flowDirection(d) {
  let across = 0;
  let down = 0;
  let sx = 0;
  let sy = 0;
  for (const e of d.edges) {
    const a = endOf(d, e.from);
    const b = endOf(d, e.to);
    if (!a || !b || a === b) continue;
    const dx = cx(b) - cx(a);
    const dy = cy(b) - cy(a);
    // Only a one-way arrow says which way things flow; the rest count for the
    // axis alone.
    const sign = e.head === 'end' ? 1 : 0;
    // A link between blocks that share a column or a row says the axis; a
    // diagonal one (a fan-out to a wide row) only half as surely.
    const sameColumn = a.x < b.x + b.w && b.x < a.x + a.w;
    const sameRow = a.y < b.y + b.h && b.y < a.y + a.h;
    const weight = sameColumn || sameRow ? 1 : 0.5;
    if (sameRow || (!sameColumn && Math.abs(dx) >= Math.abs(dy))) { across += weight; sx += Math.sign(dx) * sign; }
    else { down += weight; sy += Math.sign(dy) * sign; }
  }
  if (!across && !down) return d.direction;
  if (down > across) return sy < 0 ? 'BT' : 'TD';
  return sx < 0 ? 'RL' : 'LR';
}

// The order a reader follows the drawing in, which is also the order Mermaid's
// own layout then tends to keep: along the flow, stage by stage. A diagram
// flowing down (TD) is read row by row, top to bottom, each row left to right;
// one flowing across (LR) column by column, left to right, each column top to
// bottom (BT and RL the other way along). A row or column is everything
// within half a block of its first.
function readingOrder(items, direction) {
  const across = direction === 'LR' || direction === 'RL';
  const back = direction === 'RL' || direction === 'BT' ? -1 : 1;
  const [along, side] = across ? ['x', 'y'] : ['y', 'x'];
  const within = (across ? DEFAULT_W : DEFAULT_H) / 2;
  const sorted = items.slice().sort((p, q) => back * (p[along] - q[along]) || p[side] - q[side]);
  const runs = [];
  for (const it of sorted) {
    const run = runs[runs.length - 1];
    if (run && Math.abs(it[along] - run[0][along]) < within) run.push(it);
    else runs.push([it]);
  }
  return runs.flatMap((run) => run.sort((p, q) => p[side] - q[side]));
}

function toMermaid(d) {
  const direction = flowDirection(d);
  const lines = ['flowchart ' + direction];
  // A title read from front matter goes back the same way; the canvas has no
  // place for one, but it mustn't be lost on a round trip.
  if (d.title) lines.unshift('---', 'title: ' + JSON.stringify(d.title), '---');

  // Groups and loose blocks are declared in reading order, and so are the
  // blocks inside each group. Nodes are declared inside their subgraph rather
  // than referenced from it -- that is the idiomatic form, and it leaves no
  // ambiguity about which group a node belongs to. Loose line ends go last:
  // they are the least interesting thing in the diagram.
  const grouped = new Set(d.groups.flatMap((g) => g.members));
  const hasBlocks = (g) => groupNodeIds(d, g).some((id) => nodeById(d, id));
  const top = d.groups.filter((g) => !g.parent && hasBlocks(g))
    .concat(d.nodes.filter((n) => !grouped.has(n.id) && !isPoint(n)));
  const order = [];                      // every node and group, in the order declared
  const declare = (items, pad) => {
    for (const it of readingOrder(items, direction)) {
      order.push(it);
      if (!it.members) { lines.push(pad + nodeDecl(it)); continue; }
      lines.push(pad + 'subgraph ' + it.id + '[' + quoteLabel(it.label) + ']');
      if (it.direction) lines.push(pad + '  direction ' + it.direction);
      declare(it.members.map((id) => nodeById(d, id)).filter(Boolean)
        .concat(childGroups(d, it).filter(hasBlocks)), pad + '  ');
      lines.push(pad + 'end');
    }
  };
  declare(top, '  ');
  for (const n of d.nodes) if (isPoint(n) && !grouped.has(n.id)) { lines.push('  ' + nodeDecl(n)); order.push(n); }
  const symbols = order.filter((n) => SYMBOL_MEANING[n.shape]).map((n) => n.id + ' is a ' + SYMBOL_MEANING[n.shape]);
  if (symbols.length) lines.splice(lines.indexOf('flowchart ' + direction) + 1, 0, '  %% ' + symbols.join('; '));

  // Connectors grouped by the block they leave, in that same order, so the
  // text reads as the flow does. Everything that refers to a connector by
  // number (linkStyle, and the %% link / path / route lines) numbers it by
  // this order, since that is the order they're read back in.
  const rank = new Map(order.map((n, i) => [n.id, i]));
  const edges = d.edges.slice().sort((p, q) => rank.get(p.from) - rank.get(q.from) || rank.get(p.to) - rank.get(q.to));
  for (const e of edges) lines.push('  ' + edgeDecl(e));
  for (const n of order) {
    const s = !n.members && styleDecl(n);
    if (s) lines.push('  ' + s);
  }
  // A group's title size, as a standard `style` on the subgraph.
  for (const g of d.groups) {
    if (g.fontSize && g.fontSize !== GROUP_FONT_SIZE) lines.push('  style ' + g.id + ' font-size:' + g.fontSize + 'px');
  }
  edges.forEach((e, i) => {
    const s = linkStyleDecl(e, i);
    if (s) lines.push('  ' + s);
  });

  // Only nodes are recorded. A group's box is always derived from its members,
  // so storing it would just be data that can go stale. These lines keep the
  // model's own order -- stacking order -- which reading order would lose.
  lines.push(LAYOUT_HEADER);
  for (const n of d.nodes) lines.push(layoutLine(n));
  edges.forEach((e, i) => {
    if (e.fromAnchor || e.toAnchor) {
      lines.push('%% link ' + i + ' ' + anchorText(e.fromAnchor) + ' ' + anchorText(e.toAnchor));
    }
    // The bends of a connector whose path was dragged by hand. Absent for
    // every connector left on automatic routing.
    if (e.points && e.points.length) {
      lines.push('%% path ' + i + ' ' + e.points.map((p) => Math.round(p.x) + ',' + Math.round(p.y)).join(' '));
    }
    if (e.route === 'straight') lines.push('%% route ' + i + ' straight');
  });

  return lines.join('\n');
}

// The fence is the sentinel. It self-describes, it is what an LLM has seen a
// million times, and it pastes straight into a chat -- so it is worth the 14
// characters. Only the alt-text carries it; the markdown tab edits the bare
// source.
function toAltText(d) {
  return FENCE_OPEN + '\n' + toMermaid(d) + '\n```';
}

function looksLikeOurAltText(raw) {
  return typeof raw === 'string' && raw.trimStart().startsWith(FENCE_OPEN);
}

// The diagram inside a paste: a whole LLM reply ("Here's the diagram:
// ```mermaid ... ``` It shows...") gives its first fenced block, alt text its
// fence; bare Mermaid is taken as it is.
function stripFence(raw) {
  const text = String(raw).replace(/\r\n?/g, '\n');
  const block = text.match(/```[ \t]*(?:mermaid)?[ \t]*\n([\s\S]*?)\n[ \t]*```/);
  if (block && !text.trimStart().startsWith('```')) return block[1];
  const lines = text.split('\n');
  if (lines.length && lines[0].trim().startsWith('```')) lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length && lines[lines.length - 1].trim() === '```') lines.pop();
  return lines.join('\n');
}

// --- parsing ------------------------------------------------------------
//
// A line-based reader for the flowchart subset this tool emits, loosened
// enough to swallow the Mermaid an LLM typically writes: inline node
// declarations on edge lines, chained edges, `-- text -->` labels, and
// whatever indentation it felt like using.

// Longest opener first. `[/` and `[\` each have two possible closers (a
// parallelogram and a trapezoid), so the pair that shares an opener is listed
// with the more common one first and the reader falls through when its closer
// isn't there.
const BRACKETS = [
  ['(((', ')))', 'doublecircle'],
  ['[[', ']]', 'subroutine'],
  ['[(', ')]', 'cylinder'],
  ['((', '))', 'circle'],
  ['([', '])', 'stadium'],
  ['{{', '}}', 'hexagon'],
  ['[/', '/]', 'parallelogram'],
  ['[/', '\\]', 'trapezoid'],
  ['[\\', '\\]', 'parallelogram_alt'],
  ['[\\', '/]', 'trapezoid_alt'],
  ['>', ']', 'flag'],
  ['[',  ']',  'rect'],
  ['(',  ')',  'round'],
  ['{',  '}',  'diamond'],
];

// Dash and equals runs are variable-length in Mermaid -- `A ---> B` means the
// same as `A --> B` but asks dagre for a longer edge, and LLMs emit both.
// A label between pipes may be quoted, and a quoted one may contain a pipe of
// its own (`-->|"a|b"|`), so the quoted form is matched first.
// `~~~` is Mermaid's invisible link, there only to line blocks up: its
// blocks are kept, and it draws nothing.
// A link is a dash, dot or equals run with an optional head at either end
// (`<`/`>` arrow, `o` circle, `x` cross), maybe named first (`e1@-->`).
const LINK_RE = /^\s*(?:[A-Za-z0-9_]+@)?(~{3,}|[<ox]?(?:-\.+-|-{2,}|={2,})[>ox]?)\s*(?:\|\s*("[^"]*"|[^|]*?)\s*\|\s*)?/;

function linkFromToken(token) {
  return {
    dash: token.includes('.') ? 'dotted' : 'solid',
    // Circle and cross heads are drawn as arrows: the direction is what matters.
    head: /^[<ox]/.test(token) && /[>ox]$/.test(token) ? 'both' : /^[<ox]|[>ox]$/.test(token) ? 'end' : 'none',
    width: token.includes('=') ? 3.5 : DEFAULT_EDGE_W,
  };
}

// Index just past the closing quote of a string opening at `i`.
function skipQuoted(s, i) {
  const end = s.indexOf('"', i + 1);
  return end === -1 ? s.length : end + 1;
}

// `shape: doc, label: "Hi, there"` -> { shape: 'doc', label: 'Hi, there' }.
// Commas inside quotes are part of the value.
function readProps(body) {
  const props = {};
  let i = 0;
  while (i < body.length) {
    const colon = body.indexOf(':', i);
    if (colon === -1) break;
    const key = body.slice(i, colon).replace(/[\s,]/g, '');
    let j = colon + 1;
    while (j < body.length && /\s/.test(body[j])) j++;
    let value;
    if (body[j] === '"') { const end = skipQuoted(body, j); value = body.slice(j, end); j = end; }
    else { const end = body.indexOf(',', j); value = body.slice(j, end === -1 ? body.length : end).trim(); j = end === -1 ? body.length : end; }
    props[key] = value;
    i = j + 1;
  }
  return props;
}

// Reads one `ID` optionally followed by a shape. Labels are scanned by hand,
// quote-aware, because hardware labels are full of brackets -- `addr[31:0]`
// inside `A["addr[31:0]"]` must not end the node at its first `]`. `-` is
// deliberately not an id character: without that, the extremely common `A-->B`
// reads as a node called `A--`. A single `-` between id characters is part
// of the id, though: Mermaid reads `user-svc` as one node, and LLMs write
// such ids all the time.
function readNodeRef(s, i) {
  while (i < s.length && /\s/.test(s[i])) i++;
  const start = i;
  while (i < s.length && (/[A-Za-z0-9_]/.test(s[i]) || (s[i] === '-' && i > start && /[A-Za-z0-9_]/.test(s[i + 1] || '')))) i++;
  if (i === start) return null;
  const id = s.slice(start, i);

  if (s.startsWith('@{', i)) {
    let j = i + 2;
    while (j < s.length && s[j] !== '}') j = s[j] === '"' ? skipQuoted(s, j) : j + 1;
    const props = readProps(s.slice(i + 2, j));
    const end = readClass(s, Math.min(j + 1, s.length));
    return { id, shape: props.shape ? SHAPE_BY_V11[props.shape] || 'rect' : null,
             label: props.label != null ? unquoteLabel(props.label) : null, next: end.next, cls: end.cls };
  }

  for (const [open, close, shape] of BRACKETS) {
    if (!s.startsWith(open, i)) continue;
    let from = i + open.length;
    while (from < s.length && s[from] === ' ') from++;
    if (s[from] === '"') from = skipQuoted(s, from);
    const end = s.indexOf(close, from);
    if (end === -1) continue;
    const md = markdownLabel(unquoteLabel(s.slice(i + open.length, end)));
    return Object.assign({ id, shape, label: md.label, bold: md.bold }, readClass(s, end + close.length));
  }
  return Object.assign({ id, shape: null, label: null }, readClass(s, i));
}

// Mermaid's markdown string, "`**bold** text`": the backticks and the bold
// markers are markup, not text. A label that is bold throughout becomes a bold
// block; bold on part of one can't be shown, so only the markers go.
function markdownLabel(label) {
  const m = label.match(/^`([\s\S]*)`$/);
  if (!m) return { label, bold: false };
  const bold = /^\*\*[^*]+\*\*$/.test(m[1].trim());
  return { label: m[1].replace(/\*\*/g, '').trim(), bold };
}

// `A:::hot` attaches a class, whose classDef may colour the block.
function readClass(s, i) {
  const m = s.slice(i).match(/^:::([A-Za-z0-9_-]+)/);
  return m ? { next: i + m[0].length, cls: m[1] } : { next: i, cls: null };
}

// `A & B` -- Mermaid's shorthand for several nodes on one side of a link.
function readNodeList(s, i) {
  const first = readNodeRef(s, i);
  if (!first) return null;
  const refs = [first];
  let next = first.next;
  for (;;) {
    const amp = s.slice(next).match(/^\s*&\s*/);
    if (!amp) break;
    const ref = readNodeRef(s, next + amp[0].length);
    if (!ref) break;
    refs.push(ref);
    next = ref.next;
  }
  return { refs, next };
}

// Rewrites Mermaid's `A -- text --> B` into the `A -->|text| B` form so the
// scanner below only has to know one shape. The trailing arrow is captured
// whole, because dash runs are variable-length (`-- text ---->`).
function normalizeInlineLabels(line) {
  return line
    .replace(/--\s+([^->|]+?)\s+(-{2,}[>ox]?)/g, '$2|$1|')
    .replace(/==\s+([^=>|]+?)\s+(={2,}>?)/g, '$2|$1|')
    .replace(/-\.\s+([^.|]+?)\s+\.(-+>?)/g, '-.$2|$1|');
}

function readAnchor(s) {
  if (s === '-') return null;
  return { side: s[0], t: s.length > 1 ? +s.slice(1) : null };
}

function splitStatements(line) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { i = skipQuoted(line, i) - 1; continue; }
    if ('[({'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) { out.push(line.slice(start, i)); start = i + 1; }
  }
  out.push(line.slice(start));
  return out;
}

// --- other diagram types, read as flowcharts ------------------------------
//
// A state diagram and a block diagram are boxes and arrows too, so they are
// translated into the flowchart text that would draw them and read from that:
// the canvas then edits them like anything else, and the alt text is a
// flowchart that says the same thing.

// The text after a diagram's header (front matter and `%%` lines before it
// skipped), or null when the header isn't `kind`.
function afterHeader(text, kind) {
  const lines = stripFence(text).split('\n');
  let k = 0;
  if (lines[0] && lines[0].trim() === '---') { k = lines.findIndex((l, j) => j > 0 && l.trim() === '---') + 1; }
  const front = lines.slice(0, k);
  while (k < lines.length && (!lines[k].trim() || lines[k].trim().startsWith('%%'))) k++;
  if (!lines[k] || !kind.test(lines[k].trim())) return null;
  return { front, header: lines[k].trim(), body: lines.slice(k + 1) };
}

// stateDiagram(-v2): states are rounded boxes, [*] the start dot and the stop
// circle (one of each per composite state), composites are subgraphs, choice
// a diamond, fork/join a bar, notes a braced note tied on with a dotted line.
function stateToFlowchart(text) {
  const src = afterHeader(text, /^stateDiagram(-v2)?\b/);
  if (!src) return null;
  const names = {};   // id -> display name from `state "Name" as id`
  const descs = {};   // id -> description lines from `id : text`
  const kinds = {};   // id -> choice / fork / join
  const lines = src.body.map((l) => l.trim());
  // Notes span lines until `end note`; folded into one line first.
  const flat = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^note\s+(left|right)\s+of\s+([\w-]+)\s*$/i);
    if (open) {
      const end = lines.findIndex((l, j) => j > i && /^end\s*note$/i.test(l));
      const stop = end === -1 ? lines.length : end;
      flat.push(`note ${open[1]} of ${open[2]} : ${lines.slice(i + 1, stop).join('\n')}`);
      i = stop;
    } else flat.push(lines[i]);
  }
  for (const l of flat) {
    let m;
    if ((m = l.match(/^state\s+"([^"]*)"\s+as\s+([\w-]+)/))) names[m[2]] = m[1];
    else if ((m = l.match(/^state\s+([\w-]+)\s+<<(choice|fork|join)>>/))) kinds[m[1]] = m[2];
    else if ((m = l.match(/^([\w-]+)\s*:\s*(.+)$/)) && !/^(note|state|classDef|class|style|direction)$/.test(m[1])) (descs[m[1]] = descs[m[1]] || []).push(m[2].trim());
  }
  let dir = 'TD';
  const out = [];
  const seen = new Set();
  const scope = [];
  let notes = 0;
  const pad = () => '  '.repeat(scope.length + 1);
  const ref = (token, side) => {
    if (token === '[*]') {
      const id = (side === 'from' ? 'start_' : 'end_') + (scope[scope.length - 1] || 'root');
      if (seen.has(id)) return id;
      seen.add(id);
      return id + (side === 'from' ? '@{ shape: sm-circ }' : '@{ shape: fr-circ }');
    }
    const [id, cls] = token.split(':::');
    if (cls) out.push(pad() + 'class ' + id + ' ' + cls);
    if (seen.has(id)) return id;
    seen.add(id);
    if (kinds[id] === 'choice') return id + '{" "}';
    if (kinds[id]) return id + '@{ shape: fork }';
    // Mermaid shows a described state as its name over its description.
    const label = [names[id] || id].concat(descs[id] || []).join('\n');
    return id + '(' + quoteLabel(label) + ')';
  };
  for (const l of flat) {
    let m;
    if (!l || l.startsWith('%%') || l === '--' || /^(hide|scale|accTitle|accDescr)\b/.test(l)) continue;
    if ((m = l.match(/^direction\s+(TB|TD|BT|LR|RL)\b/i))) {
      if (scope.length) out.push(pad() + 'direction ' + m[1].toUpperCase());
      else dir = m[1].toUpperCase();
      continue;
    }
    if ((m = l.match(/^state\s+(?:"([^"]*)"\s+as\s+)?([\w-]+)\s*\{$/))) {
      out.push(pad() + 'subgraph ' + m[2] + '[' + quoteLabel(m[1] || names[m[2]] || m[2]) + ']');
      scope.push(m[2]);
      seen.add(m[2]);
      continue;
    }
    if (l === '}') { scope.pop(); out.push(pad() + 'end'); continue; }
    if (/^(classDef|class|style)\b/.test(l)) { out.push(pad() + l); continue; }
    if ((m = l.match(/^note\s+(left|right)\s+of\s+([\w-]+)\s*:\s*([\s\S]*)$/i))) {
      const id = 'note' + ++notes;
      out.push(pad() + ref(m[2], 'to') + ' -.- ' + id + '@{ shape: ' + (m[1].toLowerCase() === 'right' ? 'brace' : 'brace-r') +
        ', label: ' + quoteLabel(m[3].trim()) + ' }');
      continue;
    }
    if ((m = l.match(/^(\S+)\s*-->\s*([^:\s]+)\s*(?::\s*(.*))?$/))) {
      const from = ref(m[1], 'from');
      const to = ref(m[2], 'to');
      out.push(pad() + from + (m[3] ? ' -->|' + quoteLabel(m[3].trim()) + '| ' : ' --> ') + to);
      continue;
    }
    if ((m = l.match(/^state\s+(?:"[^"]*"\s+as\s+)?([\w-]+)/)) || (m = l.match(/^([\w-]+(?::::[\w-]+)?)\s*(?::.*)?$/))) {
      const r = ref(m[1], 'to');
      if (r !== m[1].split(':::')[0]) out.push(pad() + r);
    }
  }
  return src.front.concat(['flowchart ' + dir], out).join('\n');
}

// block-beta: rows of blocks in a fixed number of columns, `id:2` spanning
// two, `space` an empty cell, `block:id ... end` a nested grid. The grid is
// exact, so it is written as positions (the layout lines) rather than left
// to the layered layout.
function blockToFlowchart(text) {
  const src = afterHeader(text, /^block(-beta)?\b/);
  if (!src) return null;
  const GAP = 20;
  const ROW_H = 56;
  // Whitespace-separated items, but not inside brackets or quotes.
  const items = (line) => {
    const out = [];
    let depth = 0, start = -1;
    for (let i = 0; i <= line.length; i++) {
      const c = line[i];
      if (c === '"') { if (start < 0) start = i; i = skipQuoted(line, i) - 1; continue; }
      if (c && '[({<'.includes(c)) depth++;
      else if (c && ')]}>'.includes(c)) depth = Math.max(0, depth - 1);
      if ((c === undefined || /\s/.test(c)) && depth === 0) { if (start >= 0) out.push(line.slice(start, i)); start = -1; }
      else if (start < 0) start = i;
    }
    return out;
  };
  const root = { id: null, columns: null, items: [] };
  const stack = [root];
  const links = [];
  let anon = 0;
  for (const raw of src.body) {
    const l = raw.trim();
    if (!l || l.startsWith('%%')) continue;
    const top = stack[stack.length - 1];
    let m;
    if ((m = l.match(/^columns\s+(\d+|auto)\s*$/))) { top.columns = m[1] === 'auto' ? null : +m[1]; continue; }
    if (/^(classDef|class|style|linkStyle)\b/.test(l) || /(-->|---|-\.-|==>|~~~)/.test(l)) { links.push(l); continue; }
    if (l === 'end') { if (stack.length > 1) stack.pop(); continue; }
    for (const tok of items(l)) {
      const blk = tok.match(/^block(?::([\w-]+))?(?::(\d+))?$/);
      if (blk) {
        const c = { id: blk[1] || 'block' + ++anon, columns: null, items: [], span: +(blk[2] || 1) };
        stack[stack.length - 1].items.push(c);
        stack.push(c);
        continue;
      }
      const sp = tok.match(/^space(?::(\d+))?$/);
      if (sp) { stack[stack.length - 1].items.push({ space: true, span: +(sp[1] || 1) }); continue; }
      // `id<["label"]>(right)`, a block arrow: drawn as a plain block.
      const span = tok.match(/:(\d+)$/);
      const decl = (span ? tok.slice(0, span.index) : tok).replace(/<\[([\s\S]*)\]>\([\w,\s]*\)$/, '["$1"]').replace(/\["("[\s\S]*")"\]$/, '[$1]');
      const ref = readNodeRef(decl, 0);
      if (!ref) continue;
      const label = ref.label != null ? ref.label : ref.id;
      const w = Math.max(120, Math.min(260, label.length * 7 + 36));
      stack[stack.length - 1].items.push({ id: ref.id, decl, span: span ? +span[1] : 1, w, h: ROW_H });
    }
  }
  // Natural size of a container: its cells as wide as the widest item per
  // column it spans, rows as tall as their tallest item.
  const titleH = groupTitleH({});
  const measure = (c) => {
    for (const it of c.items) if (it.items) measure(it);
    const cols = c.columns || Math.max(1, c.items.reduce((sum, it) => sum + it.span, 0));
    c.cols = cols;
    const cell = Math.max(60, ...c.items.filter((it) => !it.space).map((it) => (it.w - (it.span - 1) * GAP) / Math.min(it.span, cols)));
    c.cell = cell;
    c.rows = [];
    let col = cols;
    for (const it of c.items) {
      const span = Math.min(it.span, cols);
      if (col + span > cols) { c.rows.push([]); col = 0; }
      c.rows[c.rows.length - 1].push({ it, col, span });
      col += span;
    }
    const rowHs = c.rows.map((r) => Math.max(ROW_H, ...r.filter((x) => !x.it.space).map((x) => x.it.h)));
    c.rowHs = rowHs;
    const inner = { w: cols * cell + (cols - 1) * GAP, h: rowHs.reduce((a, b) => a + b, 0) + Math.max(0, rowHs.length - 1) * GAP };
    c.w = c.id ? inner.w + GROUP_PAD * 2 : inner.w;
    c.h = c.id ? inner.h + GROUP_PAD * 2 + titleH : inner.h;
  };
  measure(root);
  const decls = [];
  const layoutLines = [];
  const place = (c, x, y, depth) => {
    const ox = c.id ? x + GROUP_PAD : x;
    let oy = c.id ? y + GROUP_PAD + titleH : y;
    const pad = '  '.repeat(depth + 1);
    c.rows.forEach((row, r) => {
      for (const { it, col, span } of row) {
        const cx = ox + col * (c.cell + GAP);
        if (it.space) continue;
        if (it.items) {
          decls.push(pad + 'subgraph ' + it.id + '[' + quoteLabel(it.id.replace(/^block\d+$/, ' ')) + ']');
          place(it, cx, oy, depth + 1);
          decls.push(pad + 'end');
        } else {
          decls.push(pad + it.decl);
          layoutLines.push(`%% ${it.id} ${Math.round(cx)},${Math.round(oy)} ${Math.round(span * c.cell + (span - 1) * GAP)}x${it.h}`);
        }
      }
      oy += c.rowHs[r] + GAP;
    });
  };
  place(root, 40, 40, 0);
  return src.front.concat(['flowchart LR'], decls, links.map((l) => '  ' + l), [LAYOUT_HEADER], layoutLines).join('\n');
}

function parseMermaid(text) {
  const state = stateToFlowchart(text);
  const block = state == null ? blockToFlowchart(text) : null;
  if (state != null || block != null) {
    const d = parseMermaid(state != null ? state : block);
    d.from = state != null ? 'state diagram' : 'block diagram';
    return d;
  }
  const d = newDiagram();
  const layout = {};
  const anchors = {};
  const paths = {};
  const routes = {};
  const linkStyles = {};
  const styles = {};
  const classDefs = {};   // classDef name -> its style declaration
  const classOf = {};     // node id -> class names, in the order given
  const edgeIds = new Set();
  const oldJunctions = new Set();
  let groupStack = [];
  let sawHeader = false;
  const invisible = [];   // `A ~~~ B`: [from, to], for the layout only

  const ensureNode = (ref) => {
    let n = nodeById(d, ref.id);
    if (!n) {
      const shape = ref.shape || 'rect';
      const [w, h] = defaultSize(shape);
      n = { id: ref.id, label: ref.label != null ? ref.label : (LABELLESS.has(shape) ? '' : ref.id),
            shape, x: 0, y: 0, w, h, fill: '#ffffff', fontSize: DEFAULT_FONT_SIZE, bold: !!ref.bold };
      d.nodes.push(n);
      if (groupStack.length) groupStack[groupStack.length - 1].members.push(n.id);
    } else {
      if (ref.label != null) n.label = ref.label;
      if (ref.shape) n.shape = ref.shape;
      if (ref.bold) n.bold = true;
    }
    if (ref.cls) (classOf[n.id] = classOf[n.id] || []).push(ref.cls);
    return n;
  };

  // Front matter (`---` / `title: ...` / `---`) before the header: its title
  // is kept and written back; nothing else in it means anything here.
  let lines = stripFence(text).split('\n');
  if (lines.length && lines[0].trim() === '---') {
    const close = lines.findIndex((l, k) => k > 0 && l.trim() === '---');
    if (close === -1) throw new Error('front matter opened with --- is never closed');
    const title = lines.slice(1, close).map((l) => l.match(/^\s*title:\s*(.*?)\s*$/)).find(Boolean);
    if (title && title[1]) d.title = title[1].replace(/^(["'])(.*)\1$/, '$2');
    lines = lines.slice(close + 1);
  }
  // `;` ends a statement just as a newline does (`flowchart LR; A-->B;`), so
  // statements are split there too -- but not inside a quoted label or a
  // shape's brackets, and never in a `%%` line.
  lines = lines.flatMap((l) => l.trim().startsWith('%%') ? [l] : splitStatements(l));

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const layoutMatch = line.match(/^%%\s+([A-Za-z0-9_-]+)\s+(-?\d+),(-?\d+)\s+(\d+)x(\d+)\s*$/);
    if (layoutMatch) {
      layout[layoutMatch[1]] = {
        x: +layoutMatch[2], y: +layoutMatch[3], w: +layoutMatch[4], h: +layoutMatch[5],
      };
      continue;
    }
    const linkMatch = line.match(/^%%\s+link\s+(\d+)\s+([nesw][\d.]*|-)\s+([nesw][\d.]*|-)\s*$/);
    if (linkMatch) {
      anchors[+linkMatch[1]] = [readAnchor(linkMatch[2]), readAnchor(linkMatch[3])];
      continue;
    }
    const pathMatch = line.match(/^%%\s+path\s+(\d+)((?:\s+-?\d+,-?\d+)+)\s*$/);
    if (pathMatch) {
      paths[+pathMatch[1]] = pathMatch[2].trim().split(/\s+/).map((pair) => {
        const [x, y] = pair.split(',').map(Number);
        return { x, y };
      });
      continue;
    }
    const routeMatch = line.match(/^%%\s+route\s+(\d+)\s+(straight|elbow)\s*$/);
    if (routeMatch) { routes[+routeMatch[1]] = routeMatch[2]; continue; }
    // Builds before v27 wrote a wire junction as `sm-circ`, Mermaid's start
    // dot; their symbol comment says which ones were junctions.
    if (line.startsWith('%%')) {
      for (const m of line.matchAll(/([A-Za-z0-9_-]+) is a wire junction/g)) oldJunctions.add(m[1]);
      continue;
    }

    const header = line.match(/^(?:flowchart(?:-elk)?|graph)(?:\s+(TD|TB|LR|RL|BT))?\s*;?$/i);
    if (header) {
      sawHeader = true;
      const dir = (header[1] || 'TD').toUpperCase();
      d.direction = dir === 'TB' ? 'TD' : dir;
      continue;
    }

    // Anything starting with `subgraph` opens a group, even the id-less
    // `subgraph "Name"` form an LLM sometimes writes -- falling through would
    // parse the keyword itself as a block called "subgraph".
    if (/^subgraph\b/.test(line)) {
      const sub = line.match(/^subgraph\s+([A-Za-z0-9_-]+)\s*(?:\[(.*)\])?\s*$/);
      const label = sub ? (sub[2] ? unquoteLabel(sub[2]) : sub[1]) : unquoteLabel(line.slice(9).trim());
      const id = sub ? sub[1] : makeId(label, new Set(d.groups.map((g) => g.id)));
      const g = { id, label, members: [], parent: groupStack.length ? groupStack[groupStack.length - 1].id : null,
                  x: 0, y: 0, w: 0, h: 0 };
      d.groups.push(g);
      groupStack.push(g);
      continue;
    }
    if (/^end$/i.test(line)) { groupStack.pop(); continue; }

    const style = line.match(/^style\s+([A-Za-z0-9_-]+)\s+(.*)$/);
    if (style) { styles[style[1]] = style[2]; continue; }

    // Consumed whatever it says, including `linkStyle default ...`, which
    // names no particular edge but must not be read as a block.
    if (/^linkStyle\b/.test(line)) {
      const ls = line.match(/^linkStyle\s+([\d,\s]+?)\s+(.*)$/);
      if (ls) ls[1].split(',').forEach((i) => { linkStyles[+i.trim()] = ls[2]; });
      continue;
    }

    // Inside a subgraph, `direction LR` lays that group out its own way.
    const dirLine = line.match(/^direction\s+(TB|TD|BT|LR|RL)\b/i);
    if (dirLine) {
      if (groupStack.length) groupStack[groupStack.length - 1].direction = dirLine[1].toUpperCase().replace('TB', 'TD');
      continue;
    }
    const classDef = line.match(/^classDef\s+([A-Za-z0-9_,-]+)\s+(.*)$/);
    if (classDef) { for (const c of classDef[1].split(',')) classDefs[c] = classDef[2]; continue; }
    const classLine = line.match(/^class\s+([A-Za-z0-9_,\s-]+?)\s+([A-Za-z0-9_-]+)\s*$/);
    if (classLine) {
      for (const id of classLine[1].split(',')) (classOf[id.trim()] = classOf[id.trim()] || []).push(classLine[2]);
      continue;
    }
    if (/^(classDef|class|click|accTitle|accDescr)\b/.test(line)) continue;
    // `e1@{ animate: true }` styles the link named e1: nothing to draw.
    const named = line.match(/^([A-Za-z0-9_]+)@\{/);
    if (named && edgeIds.has(named[1])) continue;

    // Anything left is a node declaration or a chain of edges, where either
    // side of a link may be an `A & B` list: every pairing becomes an edge.
    const s = normalizeInlineLabels(line);
    const head = readNodeList(s, 0);
    if (!head) continue;
    let prev = head.refs.map(ensureNode);
    let i = head.next;
    while (i < s.length) {
      const link = s.slice(i).match(LINK_RE);
      if (!link) break;
      const edgeId = link[0].match(/([A-Za-z0-9_]+)@/);
      if (edgeId) edgeIds.add(edgeId[1]);
      i += link[0].length;
      const next = readNodeList(s, i);
      if (!next) break;
      i = next.next;
      const targets = next.refs.map(ensureNode);
      if (link[1].startsWith('~')) {
        for (const a of prev) for (const b of targets) invisible.push([a.id, b.id]);
        prev = targets;
        continue;
      }
      for (const a of prev) {
        for (const b of targets) {
          const e = Object.assign(newEdge(a.id, b.id), linkFromToken(link[1]));
          e.label = link[2] ? markdownLabel(unquoteLabel(link[2])).label : '';
          d.edges.push(e);
        }
      }
      prev = targets;
    }
  }

  // The reader is lenient about everything else, which means without this any
  // stray sentence would parse as a block named after its first word. Mermaid
  // itself refuses a diagram with no header, so this refuses the same thing.
  if (!sawHeader) {
    const other = (stripFence(text).match(/^\s*(sequenceDiagram|classDiagram|erDiagram|gantt|pie|mindmap|timeline|journey|gitGraph|quadrantChart|requirementDiagram|sankey(?:-beta)?|xychart(?:-beta)?|packet(?:-beta)?|architecture(?:-beta)?|kanban|C4\w+)\b/m) || [])[1];
    throw new Error(other ? `that's a ${other}: this tool reads flowcharts, state diagrams and block diagrams (a first line like "flowchart LR")`
      : 'expected a "flowchart LR" (or TD) line at the top');
  }

  for (const n of d.nodes) if (n.shape === 'start' && oldJunctions.has(n.id)) n.shape = 'junction';
  for (const n of d.nodes) {
    // A style line wins over the classes, a later class over an earlier one:
    // the winner goes first, where the first match below finds it.
    const decl = [styles[n.id]].concat((classOf[n.id] || []).map((c) => classDefs[c]).reverse(), classDefs.default)
      .filter(Boolean).join(',');
    if (/fill:\s*none/.test(decl) && /stroke:\s*none/.test(decl)) n.shape = 'text';
    const fill = decl.match(/fill:\s*(#[0-9a-fA-F]{3,8})/);
    if (fill) n.fill = fill[1];
    const size = decl.match(/font-size:\s*([\d.]+)/);
    if (size) n.fontSize = +size[1];
    if (/font-weight:\s*(bold|[6-9]00)/.test(decl)) n.bold = true;
  }
  d.edges.forEach((e, i) => {
    const decl = linkStyles[i] || '';
    const w = decl.match(/stroke-width:\s*([\d.]+)/);
    if (w) e.width = +w[1];
    const color = decl.match(/(?:^|,)\s*stroke:\s*(#[0-9a-fA-F]{3,8})/);
    if (color) e.color = color[1];
    const size = decl.match(/font-size:\s*([\d.]+)/);
    if (size) e.fontSize = +size[1];
    if (/font-weight:\s*(bold|[6-9]00)/.test(decl)) e.bold = true;
    if (anchors[i]) { e.fromAnchor = anchors[i][0]; e.toAnchor = anchors[i][1]; }
    if (paths[i]) e.points = paths[i];
    if (routes[i]) e.route = routes[i];
  });

  // Node order is stacking order (front to back is what Bring to front
  // changes), but declarations come out grouped by subgraph. The layout lines
  // are written in the real order, so they put it back -- otherwise a block
  // brought to the front could sink behind others on the way through Word.
  const order = Object.keys(layout);
  if (order.length) {
    const rank = (n) => { const r = order.indexOf(n.id); return r === -1 ? Infinity : r; };
    d.nodes.sort((p, q) => rank(p) - rank(q));
  }

  for (const g of d.groups) {
    const size = (styles[g.id] || '').match(/font-size:\s*([\d.]+)/);
    if (size) g.fontSize = +size[1];
  }

  // `B --> G` with G a subgraph connects to the whole group, as in Mermaid:
  // the reference made a block named G, which goes again.
  const groupIds = new Set(d.groups.map((g) => g.id));
  d.nodes = d.nodes.filter((n) => !groupIds.has(n.id));

  // Groups own their members, so a node listed in two is a contradiction;
  // first one wins.
  const claimed = new Set();
  for (const g of d.groups) {
    g.members = g.members.filter((id) => nodeById(d, id) && !claimed.has(id));
    g.members.forEach((id) => claimed.add(id));
  }

  applyLayout(d, layout, invisible);

  // A zero-size empty text node is a loose line end (see SHAPES.point). An
  // ordinary text label never has zero size, so this can't catch one.
  for (const n of d.nodes) {
    if (n.shape === 'text' && n.w === 0 && n.h === 0 && !n.label.trim()) { n.shape = 'point'; n.label = ''; }
  }
  return d;
}

// Anything the `%%` lines didn't place gets an automatic spot. Pasted-in
// Mermaid (no `%%` lines at all) is laid out whole, group by group; a few
// blocks added to a drawn diagram by editing the text go in rows below it.
function applyLayout(d, layout, invisible) {
  const unplaced = [];
  for (const n of d.nodes) {
    const l = layout[n.id];
    if (l) Object.assign(n, l); else unplaced.push(n);
  }
  // Sized to their text where text can be measured (render.js, in the pane;
  // not in `node test.js`, which keeps the default size).
  if (typeof sizeForLabel === 'function') unplaced.forEach(sizeForLabel);
  if (unplaced.length === d.nodes.length) {
    const grouped = new Set(d.groups.flatMap((g) => g.members));
    const links = d.edges.map((e) => [e.from, e.to]).concat(invisible);
    layoutBlock(d, d.groups.filter((g) => !g.parent).concat(d.nodes.filter((n) => !grouped.has(n.id))), 40, 40, d.direction, links);
  } else if (unplaced.length) {
    const placed = d.nodes.filter((n) => !unplaced.includes(n));
    const bottom = Math.max(...placed.map((n) => n.y + n.h)) + 60;
    const left = Math.min(...placed.map((n) => n.x));
    const ids = new Map(unplaced.map((n, i) => [n.id, i]));
    const pairs = d.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => [ids.get(e.from), ids.get(e.to)]);
    layerItems(unplaced, pairs).forEach((layer, k) => layer.forEach((n, i) => {
      n.x = left + i * (DEFAULT_W + 80);
      n.y = bottom + k * (DEFAULT_H + 50);
    }));
  }
  fitGroups(d);
}

// `items` in layers along the flow, each after everything that points to it
// -- except along a connector that closes a loop, which would otherwise push
// the loop round forever and fling it thousands of pixels out. `items` come in
// the order they were written, and people write a flow in the order it runs,
// so a loop is cut at a connector pointing back up the text ("show error -->
// enter credentials"), the longest jump back first (on a tie, the one written
// later: the "go back" arrow comes after the step it leaves), and only while it still
// closes a loop: `MUX --> ALU` written just after ALU is a forward step, not
// feedback, once `ALU --> PC` has been cut. Within a layer, items sit near what
// they connect to (barycentre sweeps), so connectors cross as little as
// possible. `pairs` are [from, to] indexes into `items`, optionally with how
// far across each end sits inside its item (-0.5 to 0.5): a connector to a
// block at the left of a group pulls its other end left.
function layerItems(items, pairs) {
  const n = items.length;
  const links = pairs.filter(([a, b]) => a !== b);
  const cut = new Set();
  const reaches = (from, to) => {
    const seen = new Set([from]);
    const stack = [from];
    while (stack.length) {
      const a = stack.pop();
      if (a === to) return true;
      links.forEach((l, k) => { if (!cut.has(k) && l[0] === a && !seen.has(l[1])) { seen.add(l[1]); stack.push(l[1]); } });
    }
    return false;
  };
  links.map((l, k) => k).filter((k) => links[k][1] < links[k][0])
    .sort((k, j) => (links[j][0] - links[j][1]) - (links[k][0] - links[k][1]) || j - k)
    .forEach((k) => { if (reaches(links[k][1], links[k][0])) cut.add(k); });
  const forward = items.map(() => []);
  links.forEach(([a, b], k) => { if (!cut.has(k)) forward[a].push(b); });

  const depth = new Array(n).fill(0);
  const indeg = new Array(n).fill(0);
  forward.forEach((bs) => bs.forEach((b) => indeg[b]++));
  const queue = [];
  for (let i = 0; i < n; i++) if (!indeg[i]) queue.push(i);
  while (queue.length) {
    const a = queue.shift();
    for (const b of forward[a]) {
      depth[b] = Math.max(depth[b], depth[a] + 1);
      if (!--indeg[b]) queue.push(b);
    }
  }
  const layers = [];
  for (let i = 0; i < n; i++) (layers[depth[i]] = layers[depth[i]] || []).push(i);
  const dense = layers.filter(Boolean);

  const near = items.map(() => []);
  for (const [a, b, offA = 0, offB = 0] of links) { near[a].push([b, offB]); near[b].push([a, offA]); }
  const pos = new Array(n);
  dense.forEach((l) => l.forEach((i, k) => { pos[i] = k - (l.length - 1) / 2; }));
  for (let sweep = 0; sweep < 4; sweep++) {
    for (const l of sweep % 2 ? dense.slice().reverse() : dense) {
      const centre = (i) => {
        const ns = near[i].filter(([j]) => depth[j] !== depth[i]);
        return ns.length ? ns.reduce((sum, [j, off]) => sum + pos[j] + off, 0) / ns.length : pos[i];
      };
      const want = new Map(l.map((i) => [i, centre(i)]));
      l.sort((x, y) => want.get(x) - want.get(y) || pos[x] - pos[y]);
      l.forEach((i, k) => { pos[i] = k - (l.length - 1) / 2; });
    }
  }
  return dense.map((l) => l.map((i) => items[i]));
}

// Lays `items` (blocks and groups) out in layers along the diagram's
// direction, the way the connectors between them run, with its top-left at
// x0,y0; a group's own contents are laid out first, inside it. Each layer is
// centred across the flow. Returns the size taken.
// `links` are [from, to] ids: the connectors, and invisible `~~~` links,
// which order blocks just the same.
function layoutBlock(d, items, x0, y0, direction, links) {
  // In the order written: a group where its first block was written.
  const written = (it) => Math.min(...(it.members ? groupNodeIds(d, it) : [it.id]).map((id) => d.nodes.findIndex((m) => m.id === id)));
  items = items.slice().sort((p, q) => written(p) - written(q));
  const across = direction === 'LR' || direction === 'RL';
  const GAP_ALONG = across ? 80 : 60;
  const GAP_ACROSS = across ? 40 : 60;
  const sizes = new Map();
  for (const it of items) {
    if (!it.members) { sizes.set(it, { w: it.w, h: it.h }); continue; }
    const inner = layoutBlock(d, it.members.map((id) => nodeById(d, id)).filter(Boolean).concat(childGroups(d, it)), 0, 0,
      it.direction || direction, links);
    sizes.set(it, { w: Math.max(inner.w, groupTabWidthEstimate(it)) + GROUP_PAD * 2, h: inner.h + GROUP_PAD * 2 + groupTitleH(it) });
  }
  // Which item each block or group id sits in, so a connector between two
  // things inside different items orders those items.
  const home = new Map();
  items.forEach((it, i) => {
    home.set(it.id, i);
    if (!it.members) return;
    for (const id of groupNodeIds(d, it)) home.set(id, i);
    for (const g of d.groups) for (let p = g; p; p = groupById(d, p.parent)) if (p === it) home.set(g.id, i);
  });
  // Where a block sits across its group, as a fraction of the group's width
  // (its contents are laid out by now, from 0,0).
  const across_ = (id, i) => {
    const it = items[i];
    const n = nodeById(d, id);
    if (!it.members || !n) return 0;
    const span = across ? sizes.get(it).h : sizes.get(it).w;
    return ((across ? n.y + n.h / 2 : n.x + n.w / 2) + GROUP_PAD) / span - 0.5;
  };
  const pairs = links.filter(([a, b]) => home.has(a) && home.has(b))
    .map(([a, b]) => [home.get(a), home.get(b), across_(a, home.get(a)), across_(b, home.get(b))]);
  const layers = layerItems(items, pairs);
  if (direction === 'RL' || direction === 'BT') layers.reverse();

  const span = (layer) => layer.reduce((sum, it) => sum + (across ? sizes.get(it).h : sizes.get(it).w), 0) + GAP_ACROSS * (layer.length - 1);
  const widest = Math.max(0, ...layers.map(span));
  let along = 0;
  for (const layer of layers) {
    let side = (widest - span(layer)) / 2;
    const thick = Math.max(...layer.map((it) => (across ? sizes.get(it).w : sizes.get(it).h)));
    for (const it of layer) {
      const sz = sizes.get(it);
      // Centred in the layer's thickness too, so a short block lines up with a tall one's middle.
      const inset = (thick - (across ? sz.w : sz.h)) / 2;
      const x = Math.round(across ? x0 + along + inset : x0 + side);
      const y = Math.round(across ? y0 + side : y0 + along + inset);
      if (it.members) {
        const dx = x + GROUP_PAD;
        const dy = y + GROUP_PAD + groupTitleH(it);
        for (const id of groupNodeIds(d, it)) { const n = nodeById(d, id); if (n) { n.x += dx; n.y += dy; } }
      } else { it.x = x; it.y = y; }
      side += (across ? sz.h : sz.w) + GAP_ACROSS;
    }
    along += thick + GAP_ALONG;
  }
  along = Math.max(0, along - GAP_ALONG);
  return across ? { w: along, h: widest } : { w: widest, h: along };
}

// A group's title tab must fit across its box. render.js measures text
// properly; this is the layout's estimate, about 0.6em a character in bold.
function groupTabWidthEstimate(g) {
  const size = g.fontSize || GROUP_FONT_SIZE;
  return String(g.label || '').length * size * 0.62 + size * 1.6;
}

// A group's box is derived from its members plus padding, never stored
// independently of them -- so moving a node can't leave the box behind.
const GROUP_PAD = 18;
const GROUP_TITLE_H = 22;
const GROUP_FONT_SIZE = 12;

// The title tab grows with the title's text size, and the box with it.
function groupTitleH(g) {
  return Math.max(GROUP_TITLE_H, Math.round((g.fontSize || GROUP_FONT_SIZE) * 1.8));
}

// Innermost first, since a group's box takes in its subgroups' boxes. A
// parent that no longer exists (deleted, ungrouped) leaves its subgroup on top.
function fitGroups(d) {
  for (const g of d.groups) if (g.parent && !groupById(d, g.parent)) g.parent = null;
  for (const g of d.groups.slice().sort((p, q) => groupDepth(d, q) - groupDepth(d, p))) fitGroup(d, g);
}

function fitGroup(d, g) {
  const members = g.members.map((id) => nodeById(d, id)).filter(Boolean)
    .concat(childGroups(d, g).filter((c) => c.w > 0));
  if (!members.length) { g.w = 0; g.h = 0; return; }
  const x0 = Math.min(...members.map((n) => n.x));
  const y0 = Math.min(...members.map((n) => n.y));
  const x1 = Math.max(...members.map((n) => n.x + n.w));
  const y1 = Math.max(...members.map((n) => n.y + n.h));
  g.x = x0 - GROUP_PAD;
  g.y = y0 - GROUP_PAD - groupTitleH(g);
  g.w = (x1 - x0) + GROUP_PAD * 2;
  g.h = (y1 - y0) + GROUP_PAD * 2 + groupTitleH(g);
}
