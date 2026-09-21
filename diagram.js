// The diagram model, and Mermaid text in/out.
//
// A diagram is a plain object:
//   { direction,
//     nodes: [{id,label,shape,x,y,w,h,fill,fontSize,bold}],
//     edges: [{from,to,label,dash,head,width,color,fontSize,bold,route,
//              fromAnchor,toAnchor,points}],
//     groups: [{id,label,members:[nodeId],x,y,w,h}] }
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
  junction:          { v11: 'sm-circ' },
  sum:               { v11: 'cross-circ' },
  bar:               { v11: 'fork' },
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
  diamond: ['diam', 'diamond', 'decision'],
  hexagon: ['hex', 'hexagon', 'prepare'],
  parallelogram: ['lean-r', 'lean-right', 'in-out'],
  parallelogram_alt: ['lean-l', 'lean-left', 'out-in'],
  trapezoid: ['trap-b', 'trapezoid-bottom', 'priority'],
  trapezoid_alt: ['trap-t', 'trapezoid-top', 'manual'],
  flag: ['flag', 'paper-tape'],
  text: ['text'],
  document: ['doc', 'document'],
  stacked: ['st-rect', 'processes', 'procs', 'stacked-rectangle'],
  queue: ['h-cyl', 'das', 'horizontal-cylinder'],
  buffer: ['tri', 'extract', 'triangle'],
  delay: ['delay', 'half-rounded-rectangle'],
  junction: ['sm-circ', 'small-circle', 'start'],
  sum: ['cross-circ', 'summary', 'crossed-circle'],
  bar: ['fork', 'join'],
};
const SHAPE_BY_V11 = {};
for (const shape in V11_NAMES) for (const name of V11_NAMES[shape]) SHAPE_BY_V11[name] = shape;

// Wiring symbols carry no text: a junction dot, a summing node, a bus bar.
// They get their own natural size instead of a text box's.
const LABELLESS = new Set(['junction', 'sum', 'bar']);
const SHAPE_SIZE = { junction: [14, 14], sum: [40, 40], bar: [10, 80] };

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

// Everything with a meaning inside a Mermaid label is written as an entity: `"`
// ends the string, `|` ends an edge label, `#` starts an entity, `<`/`>` would
// read as HTML (a literal "<br/>" typed into a label must stay text), and a
// raw newline would end the statement.
function quoteLabel(text) {
  const escaped = String(text == null ? '' : text)
    .replace(/#/g, '#35;')
    .replace(/"/g, '#quot;')
    .replace(/\|/g, '#124;')
    .replace(/</g, '#lt;')
    .replace(/>/g, '#gt;')
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
  if (s.v11) {
    return n.id + '@{ shape: ' + s.v11 + (LABELLESS.has(n.shape) ? '' : ', label: ' + quoteLabel(n.label)) + ' }';
  }
  return n.id + s.open + quoteLabel(n.label) + s.close;
}

// Dash and arrowheads map straight onto Mermaid's link syntax. A heavy edge is
// written with the `==` form so thickness survives in other renderers too;
// `linkStyle` pins down the exact width. A dotted link has no heavy form.
function linkToken(e) {
  const heavy = (e.width || DEFAULT_EDGE_W) >= 3;
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
// when the user picked a port by hand -- otherwise the side is re-derived on
// every render, which is what lets connectors follow blocks as you drag them.
function anchorText(a) {
  return a ? a.side + a.t.toFixed(2) : '-';
}

function toMermaid(d) {
  const lines = ['flowchart ' + d.direction];

  // Nodes are declared inside their subgraph block rather than referenced
  // from it -- that is the idiomatic form, and it leaves no ambiguity about
  // which group a node belongs to.
  const grouped = new Set();
  for (const g of d.groups) {
    lines.push('  subgraph ' + g.id + '[' + quoteLabel(g.label) + ']');
    for (const id of g.members) {
      const n = nodeById(d, id);
      if (!n) continue;
      grouped.add(id);
      lines.push('    ' + nodeDecl(n));
    }
    lines.push('  end');
  }
  for (const n of d.nodes) {
    if (!grouped.has(n.id)) lines.push('  ' + nodeDecl(n));
  }
  for (const e of d.edges) lines.push('  ' + edgeDecl(e));
  for (const n of d.nodes) {
    const s = styleDecl(n);
    if (s) lines.push('  ' + s);
  }
  d.edges.forEach((e, i) => {
    const s = linkStyleDecl(e, i);
    if (s) lines.push('  ' + s);
  });

  // Only nodes are recorded. A group's box is always derived from its members,
  // so storing it would just be data that can go stale.
  lines.push(LAYOUT_HEADER);
  for (const n of d.nodes) lines.push(layoutLine(n));
  d.edges.forEach((e, i) => {
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

function stripFence(raw) {
  const lines = String(raw).replace(/\r\n?/g, '\n').split('\n');
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
const LINK_RE = /^\s*(<-\.-+>|-\.-+>|-\.-+|<=+>|<-{2,}>|=+>|={2,}|<-{2,}|--o|--x|-{2,}>|-{2,})\s*(?:\|([^|]*)\|\s*)?/;

function linkFromToken(token) {
  return {
    dash: token.includes('.') ? 'dotted' : 'solid',
    head: token.startsWith('<') ? 'both' : /[>ox]$/.test(token) ? 'end' : 'none',
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
// reads as a node called `A--`.
function readNodeRef(s, i) {
  while (i < s.length && /\s/.test(s[i])) i++;
  const start = i;
  while (i < s.length && /[A-Za-z0-9_]/.test(s[i])) i++;
  if (i === start) return null;
  const id = s.slice(start, i);

  if (s.startsWith('@{', i)) {
    let j = i + 2;
    while (j < s.length && s[j] !== '}') j = s[j] === '"' ? skipQuoted(s, j) : j + 1;
    const props = readProps(s.slice(i + 2, j));
    return { id, shape: SHAPE_BY_V11[props.shape] || 'rect',
             label: props.label != null ? unquoteLabel(props.label) : null, next: Math.min(j + 1, s.length) };
  }

  for (const [open, close, shape] of BRACKETS) {
    if (!s.startsWith(open, i)) continue;
    let from = i + open.length;
    while (from < s.length && s[from] === ' ') from++;
    if (s[from] === '"') from = skipQuoted(s, from);
    const end = s.indexOf(close, from);
    if (end === -1) continue;
    return { id, shape, label: unquoteLabel(s.slice(i + open.length, end)), next: skipClass(s, end + close.length) };
  }
  return { id, shape: null, label: null, next: skipClass(s, i) };
}

// `A:::hot` attaches a CSS class. We have no use for the class, but it must be
// stepped over, or `A:::hot --> B` loses its edge.
function skipClass(s, i) {
  const m = s.slice(i).match(/^:::[A-Za-z0-9_-]+/);
  return m ? i + m[0].length : i;
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
    .replace(/-\.\s+([^.|]+?)\s+\.-+>?/g, '-.->|$1|');
}

function readAnchor(s) {
  return s === '-' ? null : { side: s[0], t: +s.slice(1) };
}

function parseMermaid(text) {
  const d = newDiagram();
  const layout = {};
  const anchors = {};
  const paths = {};
  const routes = {};
  const linkStyles = {};
  const styles = {};
  let groupStack = [];
  let sawHeader = false;

  const ensureNode = (ref) => {
    let n = nodeById(d, ref.id);
    if (!n) {
      const shape = ref.shape || 'rect';
      const [w, h] = defaultSize(shape);
      n = { id: ref.id, label: ref.label != null ? ref.label : (LABELLESS.has(shape) ? '' : ref.id),
            shape, x: 0, y: 0, w, h, fill: '#ffffff', fontSize: DEFAULT_FONT_SIZE, bold: false };
      d.nodes.push(n);
      if (groupStack.length) groupStack[groupStack.length - 1].members.push(n.id);
    } else {
      if (ref.label != null) n.label = ref.label;
      if (ref.shape) n.shape = ref.shape;
    }
    return n;
  };

  for (const rawLine of stripFence(text).split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const layoutMatch = line.match(/^%%\s+([A-Za-z0-9_-]+)\s+(-?\d+),(-?\d+)\s+(\d+)x(\d+)\s*$/);
    if (layoutMatch) {
      layout[layoutMatch[1]] = {
        x: +layoutMatch[2], y: +layoutMatch[3], w: +layoutMatch[4], h: +layoutMatch[5],
      };
      continue;
    }
    const linkMatch = line.match(/^%%\s+link\s+(\d+)\s+([nesw][\d.]+|-)\s+([nesw][\d.]+|-)\s*$/);
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
    if (line.startsWith('%%')) continue;

    const header = line.match(/^(?:flowchart|graph)(?:\s+(TD|TB|LR|RL|BT))?\s*;?$/i);
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
      const g = { id, label, members: [], x: 0, y: 0, w: 0, h: 0 };
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

    if (/^(direction|classDef|class|click|accTitle|accDescr)\b/.test(line)) continue;

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
      i += link[0].length;
      const next = readNodeList(s, i);
      if (!next) break;
      i = next.next;
      const targets = next.refs.map(ensureNode);
      for (const a of prev) {
        for (const b of targets) {
          const e = Object.assign(newEdge(a.id, b.id), linkFromToken(link[1]));
          e.label = link[2] ? unquoteLabel(link[2]) : '';
          d.edges.push(e);
        }
      }
      prev = targets;
    }
  }

  // The reader is lenient about everything else, which means without this any
  // stray sentence would parse as a block named after its first word. Mermaid
  // itself refuses a diagram with no header, so this refuses the same thing.
  if (!sawHeader) throw new Error('expected a "flowchart LR" (or TD) line at the top');

  for (const n of d.nodes) {
    const decl = styles[n.id] || '';
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

  // Groups own their members, so a node listed in two is a contradiction;
  // first one wins.
  const claimed = new Set();
  for (const g of d.groups) {
    g.members = g.members.filter((id) => nodeById(d, id) && !claimed.has(id));
    g.members.forEach((id) => claimed.add(id));
  }

  applyLayout(d, layout);
  return d;
}

// Anything the `%%` lines didn't place gets an automatic spot. Deliberately
// simple layering -- imports are the secondary workflow and the user nudges
// afterwards, so this only has to be non-stupid, not good.
function applyLayout(d, layout) {
  const unplaced = [];
  for (const n of d.nodes) {
    const l = layout[n.id];
    if (l) Object.assign(n, l); else unplaced.push(n);
  }

  if (unplaced.length) {
    const depth = new Map(d.nodes.map((n) => [n.id, 0]));
    // Longest-path layering. Bounded by node count so a cycle terminates
    // instead of spinning.
    for (let pass = 0; pass < d.nodes.length; pass++) {
      let changed = false;
      for (const e of d.edges) {
        if (e.from === e.to) continue;
        const want = depth.get(e.from) + 1;
        if (depth.has(e.to) && want > depth.get(e.to)) { depth.set(e.to, want); changed = true; }
      }
      if (!changed) break;
    }

    const rows = new Map();
    for (const n of unplaced) {
      const layer = depth.get(n.id) || 0;
      if (!rows.has(layer)) rows.set(layer, []);
      rows.get(layer).push(n);
    }
    const acrossGap = DEFAULT_W + 80;
    const downGap = DEFAULT_H + 50;
    for (const [layer, group] of rows) {
      group.forEach((n, idx) => {
        const along = layer * acrossGap;
        const across = idx * downGap;
        if (d.direction === 'LR' || d.direction === 'RL') { n.x = 40 + along; n.y = 40 + across; }
        else { n.x = 40 + across; n.y = 40 + along; }
      });
    }
  }

  for (const g of d.groups) fitGroup(d, g);
}

// A group's box is derived from its members plus padding, never stored
// independently of them -- so moving a node can't leave the box behind.
const GROUP_PAD = 18;
const GROUP_TITLE_H = 22;

function fitGroup(d, g) {
  const members = g.members.map((id) => nodeById(d, id)).filter(Boolean);
  if (!members.length) { g.w = 0; g.h = 0; return; }
  const x0 = Math.min(...members.map((n) => n.x));
  const y0 = Math.min(...members.map((n) => n.y));
  const x1 = Math.max(...members.map((n) => n.x + n.w));
  const y1 = Math.max(...members.map((n) => n.y + n.h));
  g.x = x0 - GROUP_PAD;
  g.y = y0 - GROUP_PAD - GROUP_TITLE_H;
  g.w = (x1 - x0) + GROUP_PAD * 2;
  g.h = (y1 - y0) + GROUP_PAD * 2 + GROUP_TITLE_H;
}
