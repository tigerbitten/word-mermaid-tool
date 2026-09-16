// The diagram model, and Mermaid text in/out.
//
// A diagram is a plain object:
//   { direction, nodes: [{id,label,shape,x,y,w,h,fill}],
//     edges: [{from,to,label,style}],
//     groups: [{id,label,members:[nodeId],x,y,w,h}] }
//
// Nodes carry their own geometry because the canvas is the source of truth --
// Mermaid's layout engine is never run. Positions round-trip as `%%` comment
// lines, so the saved text stays a valid Mermaid document that renders
// anywhere and reads natively to an LLM.

const SHAPES = {
  rect:          { open: '[',  close: ']'  },
  round:         { open: '(',  close: ')'  },
  stadium:       { open: '([', close: '])' },
  subroutine:    { open: '[[', close: ']]' },
  cylinder:      { open: '[(', close: ')]' },
  circle:        { open: '((', close: '))' },
  diamond:       { open: '{',  close: '}'  },
  hexagon:       { open: '{{', close: '}}' },
  parallelogram: { open: '[/', close: '/]' },
  text:          { open: '[',  close: ']'  }, // borderless; marked by its style line
};

const EDGE_STYLES = {
  arrow:  '-->',
  line:   '---',
  thick:  '==>',
  dotted: '-.->',
  bidir:  '<-->',
};

const LAYOUT_HEADER = '%% --- layout (word-mermaid-tool v1; safe to ignore) ---';
const FENCE_OPEN = '```mermaid';

const DEFAULT_W = 140;
const DEFAULT_H = 56;

function newDiagram() {
  return { direction: 'LR', nodes: [], edges: [], groups: [] };
}

function nodeById(d, id) {
  return d.nodes.find((n) => n.id === id) || null;
}

// Mermaid ids must be identifier-ish. Derived from the label once at creation
// and then frozen -- renaming a node must not churn every edge that refers to
// it, and must not break the saved text.
function makeId(label, taken) {
  let base = String(label || '').replace(/[^A-Za-z0-9_]/g, '');
  if (!base || /^[0-9]/.test(base)) base = 'n' + base;
  base = base.slice(0, 24);
  let id = base;
  let i = 2;
  while (taken.has(id)) id = base + i++;
  return id;
}

// `"` and `#` both have meaning inside a Mermaid label, and a literal newline
// would end the statement.
function quoteLabel(text) {
  const escaped = String(text == null ? '' : text)
    .replace(/#/g, '#35;')
    .replace(/"/g, '#quot;')
    .replace(/\r?\n/g, '<br/>');
  return '"' + escaped + '"';
}

function unquoteLabel(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') s = s.slice(1, -1);
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/#quot;/g, '"')
    .replace(/#35;/g, '#');
}

function nodeDecl(n) {
  const s = SHAPES[n.shape] || SHAPES.rect;
  return n.id + s.open + quoteLabel(n.label) + s.close;
}

function edgeDecl(e) {
  const link = EDGE_STYLES[e.style] || EDGE_STYLES.arrow;
  const label = e.label ? '|' + quoteLabel(e.label) + '|' : '';
  return e.from + ' ' + link + label + ' ' + e.to;
}

// Only emitted when it carries information: a borderless text label, or a
// non-default fill. Both are standard Mermaid `style` statements, so colors
// survive a round-trip through any other Mermaid tool.
function styleDecl(n) {
  if (n.shape === 'text') return 'style ' + n.id + ' fill:none,stroke:none';
  if (n.fill && n.fill !== '#ffffff') return 'style ' + n.id + ' fill:' + n.fill + ',stroke:#333';
  return null;
}

function layoutLine(item) {
  return '%% ' + item.id + ' ' + Math.round(item.x) + ',' + Math.round(item.y) +
    ' ' + Math.round(item.w) + 'x' + Math.round(item.h);
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

  // Only nodes are recorded. A group's box is always derived from its members,
  // so storing it would just be data that can go stale.
  lines.push(LAYOUT_HEADER);
  for (const n of d.nodes) lines.push(layoutLine(n));

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
  const lines = String(raw).replace(/\r\n/g, '\n').split('\n');
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

const BRACKETS = [
  ['[[', ']]', 'subroutine'],
  ['[(', ')]', 'cylinder'],
  ['((', '))', 'circle'],
  ['([', '])', 'stadium'],
  ['{{', '}}', 'hexagon'],
  ['[/', '/]', 'parallelogram'],
  ['[',  ']',  'rect'],
  ['(',  ')',  'round'],
  ['{',  '}',  'diamond'],
];

// Dash and equals runs are variable-length in Mermaid -- `A ---> B` means the
// same as `A --> B` but asks dagre for a longer edge, and LLMs emit both.
const LINK_RE = /^\s*(<-\.-+>|-\.-+>|-\.-+|<=+>|<-{2,}>|=+>|={2,}|<-{2,}|--o|--x|-{2,}>|-{2,})\s*(?:\|([^|]*)\|\s*)?/;

function linkStyleOf(token) {
  if (token.includes('.')) return 'dotted';
  if (token.startsWith('<')) return 'bidir';
  if (token.includes('=')) return 'thick';
  return /[>ox]$/.test(token) ? 'arrow' : 'line';
}

// Reads one `ID` optionally followed by a shape bracket. Bracket contents are
// scanned by hand rather than by regex because labels legitimately contain
// brackets of their own.
function readNodeRef(s, i) {
  while (i < s.length && /\s/.test(s[i])) i++;
  const start = i;
  while (i < s.length && /[A-Za-z0-9_-]/.test(s[i])) i++;
  if (i === start) return null;
  const id = s.slice(start, i);

  for (const [open, close, shape] of BRACKETS) {
    if (s.startsWith(open, i)) {
      const end = s.indexOf(close, i + open.length);
      if (end === -1) continue;
      return { id, shape, label: unquoteLabel(s.slice(i + open.length, end)), next: end + close.length };
    }
  }
  return { id, shape: null, label: null, next: i };
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

function parseMermaid(text) {
  const d = newDiagram();
  const layout = {};
  const styles = {};
  const seen = new Set();
  let groupStack = [];

  const ensureNode = (ref) => {
    let n = nodeById(d, ref.id);
    if (!n) {
      n = { id: ref.id, label: ref.label != null ? ref.label : ref.id,
            shape: ref.shape || 'rect', x: 0, y: 0, w: DEFAULT_W, h: DEFAULT_H, fill: '#ffffff' };
      d.nodes.push(n);
      seen.add(n.id);
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
    if (line.startsWith('%%')) continue;

    const header = line.match(/^(?:flowchart|graph)\s+(TD|TB|LR|RL|BT)\s*$/i);
    if (header) { d.direction = header[1].toUpperCase() === 'TB' ? 'TD' : header[1].toUpperCase(); continue; }

    const sub = line.match(/^subgraph\s+([A-Za-z0-9_-]+)\s*(?:\[(.*)\])?\s*$/);
    if (sub) {
      const g = { id: sub[1], label: sub[2] ? unquoteLabel(sub[2]) : sub[1],
                  members: [], x: 0, y: 0, w: 0, h: 0 };
      d.groups.push(g);
      groupStack.push(g);
      continue;
    }
    if (line === 'end') { groupStack.pop(); continue; }

    const style = line.match(/^style\s+([A-Za-z0-9_-]+)\s+(.*)$/);
    if (style) { styles[style[1]] = style[2]; continue; }

    if (/^(direction|classDef|class|linkStyle|click)\b/.test(line)) continue;

    // Anything left is a node declaration or a chain of edges.
    const s = normalizeInlineLabels(line);
    let ref = readNodeRef(s, 0);
    if (!ref) continue;
    let prev = ensureNode(ref);
    let i = ref.next;
    while (i < s.length) {
      const link = s.slice(i).match(LINK_RE);
      if (!link) break;
      i += link[0].length;
      const next = readNodeRef(s, i);
      if (!next) break;
      i = next.next;
      const target = ensureNode(next);
      d.edges.push({
        from: prev.id, to: target.id,
        label: link[2] ? unquoteLabel(link[2]) : '',
        style: linkStyleOf(link[1]),
      });
      prev = target;
    }
  }

  for (const n of d.nodes) {
    const decl = styles[n.id] || '';
    if (/fill:\s*none/.test(decl) && /stroke:\s*none/.test(decl)) n.shape = 'text';
    const fill = decl.match(/fill:\s*(#[0-9a-fA-F]{3,8})/);
    if (fill) n.fill = fill[1];
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
  const placed = [];
  const unplaced = [];
  for (const n of d.nodes) {
    const l = layout[n.id];
    if (l) { Object.assign(n, l); placed.push(n); } else { unplaced.push(n); }
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
