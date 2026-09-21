// Model -> SVG.
//
// The one and only drawing code. The canvas you edit and the picture that
// lands in Word come out of these same functions, so what you see is literally
// what you get.
//
// Everything here is constrained by the rasterization path
// (SVG -> data: URL -> <img> -> canvas -> PNG). That path ignores external CSS,
// never loads webfonts, and taints the canvas if the SVG contains a
// <foreignObject>. So: styles live in a <style> block inside the SVG, fonts are
// system-only, labels are real <text>, and arrowheads are drawn paths rather
// than <marker> elements.

const FONT_STACK = 'Calibri, "Segoe UI", Helvetica, Arial, sans-serif';
const LABEL_PAD_X = 14;
const LABEL_PAD_Y = 12;
const CORNER_R = 8;
const EXPORT_PAD = 24;
const EDGE_COLOR = '#555555';
// How far a connector runs straight out of a block before it is allowed to
// turn. Without it, edges leaving adjacent ports would kink immediately and
// read as one smudge rather than as separate signals.
const STUB = 16;

const SVG_NS = 'http://www.w3.org/2000/svg';

const SVG_STYLE = `
  .wm-shape { fill: #ffffff; stroke: #333333; stroke-width: 1.5; }
  .wm-solid { fill: #333333; }
  .wm-label { font-family: ${FONT_STACK}; font-size: ${DEFAULT_FONT_SIZE}px; fill: #111111;
              text-anchor: middle; dominant-baseline: middle; }
  .wm-edge  { fill: none; stroke: ${EDGE_COLOR}; stroke-width: ${DEFAULT_EDGE_W}; stroke-linejoin: round;
              stroke-linecap: round; }
  .wm-edge-dotted { stroke-dasharray: 5 4; }
  .wm-arrow { fill: ${EDGE_COLOR}; stroke: none; }
  .wm-edge-label { font-family: ${FONT_STACK}; font-size: ${DEFAULT_EDGE_FONT}px; fill: #333333;
                   text-anchor: middle; dominant-baseline: middle; }
  .wm-edge-label-bg { fill: #ffffff; stroke: none; }
  .wm-group { fill: #f4f6fb; stroke: #6b7fb3; stroke-width: 1.5; stroke-dasharray: 8 4; }
  .wm-group-tab { fill: #6b7fb3; stroke: none; }
  .wm-group-title { font-family: ${FONT_STACK}; font-size: 12px; fill: #ffffff;
                    text-anchor: start; dominant-baseline: middle; font-weight: bold; }
`;

function el(tag, attrs, parent) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) node.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(node);
  return node;
}

// Text measurement via a 2D context -- synchronous, and matches what the SVG
// will do closely enough for wrapping decisions. Bold is measured as bold:
// it runs about 10% wider, which is the difference between fitting and not.
let measureCtx = null;
function textWidth(s, size, bold) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = (bold ? 'bold ' : '') + (size || DEFAULT_FONT_SIZE) + 'px ' + FONT_STACK;
  return measureCtx.measureText(s).width;
}

function lineH(size) { return Math.round((size || DEFAULT_FONT_SIZE) * 1.25); }

function wrapLabel(label, maxWidth, size, bold) {
  const out = [];
  for (const para of String(label || '').split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const candidate = line + ' ' + words[i];
      if (textWidth(candidate, size, bold) <= maxWidth) line = candidate;
      else { out.push(line); line = words[i]; }
    }
    out.push(line);
  }
  return out;
}

// The part of a shape the label actually sits in. Most shapes centre it in
// their box; the ones whose outline eats into the box shift it clear.
function labelArea(n) {
  const { x, y, w, h } = n;
  if (n.shape === 'cylinder') { const r = Math.min(12, h / 4); return { x, y: y + r, w, h: h - r }; }
  if (n.shape === 'document') { const a = Math.min(8, h * 0.15); return { x, y, w, h: h - a }; }
  if (n.shape === 'stacked') return { x, y: y + 8, w: w - 8, h: h - 8 };
  if (n.shape === 'queue') { const r = Math.min(12, w / 6); return { x, y, w: w - r * 1.5, h }; }
  if (n.shape === 'buffer') return { x, y: y + h * 0.2, w: w * 0.65, h: h * 0.6 };
  return n;
}

// Grows a node to fit its label. Never shrinks below what the user dragged it
// to -- resizing is theirs to control, this only prevents clipped text.
function fitNodeSize(n) {
  if (LABELLESS.has(n.shape)) return;
  const size = n.fontSize || DEFAULT_FONT_SIZE;
  const area = labelArea(n);
  // Extra room the shape's own outline takes out of the box, added back on.
  const slackW = n.w - area.w;
  const slackH = n.h - area.h;
  const lines = wrapLabel(n.label, Math.max(60, area.w - LABEL_PAD_X * 2), size, n.bold);
  const needW = Math.ceil(Math.max(...lines.map((l) => textWidth(l, size, n.bold)), 0)) + LABEL_PAD_X * 2 + slackW;
  const needH = lines.length * lineH(size) + LABEL_PAD_Y * 2 + slackH;
  n.w = Math.max(n.w, needW, 60);
  n.h = Math.max(n.h, needH, 36);
}

// Returns the shape's elements in drawing order. Anything marked data-line is
// detail linework (a cylinder's rim, a subroutine's bars) and is never filled;
// everything else takes the node's fill.
function shapeElement(n) {
  const { x, y, w, h } = n;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const slant = Math.min(20, w * 0.2);
  const line = (d) => el('path', { d, class: 'wm-shape', 'data-line': '1' });
  switch (n.shape) {
    case 'round':
      return [el('rect', { x, y, width: w, height: h, rx: 12, class: 'wm-shape' })];
    case 'stadium':
      return [el('rect', { x, y, width: w, height: h, rx: h / 2, class: 'wm-shape' })];
    case 'subroutine':
      return [
        el('rect', { x, y, width: w, height: h, class: 'wm-shape' }),
        line(`M${x + 8} ${y}V${y + h}M${x + w - 8} ${y}V${y + h}`),
      ];
    case 'cylinder': {
      const ry = Math.min(12, h / 4);
      return [
        el('path', {
          d: `M${x} ${y + ry}A${w / 2} ${ry} 0 0 1 ${x + w} ${y + ry}` +
             `V${y + h - ry}A${w / 2} ${ry} 0 0 1 ${x} ${y + h - ry}Z`,
          class: 'wm-shape',
        }),
        line(`M${x} ${y + ry}A${w / 2} ${ry} 0 0 0 ${x + w} ${y + ry}`),
      ];
    }
    case 'circle':
      return [el('ellipse', { cx, cy, rx: w / 2, ry: h / 2, class: 'wm-shape' })];
    case 'doublecircle':
      return [
        el('ellipse', { cx, cy, rx: w / 2, ry: h / 2, class: 'wm-shape' }),
        el('ellipse', { cx, cy, rx: Math.max(1, w / 2 - 5), ry: Math.max(1, h / 2 - 5), class: 'wm-shape', 'data-line': '1' }),
      ];
    case 'diamond':
      return [el('polygon', {
        points: `${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}`, class: 'wm-shape',
      })];
    case 'hexagon': {
      const i = Math.min(18, w * 0.2);
      return [el('polygon', {
        points: `${x + i},${y} ${x + w - i},${y} ${x + w},${cy} ${x + w - i},${y + h} ${x + i},${y + h} ${x},${cy}`,
        class: 'wm-shape',
      })];
    }
    case 'parallelogram':
      return [el('polygon', {
        points: `${x + slant},${y} ${x + w},${y} ${x + w - slant},${y + h} ${x},${y + h}`, class: 'wm-shape',
      })];
    case 'parallelogram_alt':
      return [el('polygon', {
        points: `${x},${y} ${x + w - slant},${y} ${x + w},${y + h} ${x + slant},${y + h}`, class: 'wm-shape',
      })];
    // Narrow-top trapezoid: the way a mux is drawn in every datapath diagram.
    case 'trapezoid':
      return [el('polygon', {
        points: `${x + slant},${y} ${x + w - slant},${y} ${x + w},${y + h} ${x},${y + h}`, class: 'wm-shape',
      })];
    case 'trapezoid_alt':
      return [el('polygon', {
        points: `${x},${y} ${x + w},${y} ${x + w - slant},${y + h} ${x + slant},${y + h}`, class: 'wm-shape',
      })];
    case 'flag':
      return [el('path', {
        d: `M${x} ${y}Q${x + slant} ${cy} ${x} ${y + h}H${x + w}V${y}Z`, class: 'wm-shape',
      })];
    case 'document': {
      const a = Math.min(8, h * 0.15);
      return [el('path', {
        d: `M${x} ${y}H${x + w}V${y + h - a}` +
           `C${x + w * 0.75} ${y + h - a * 3} ${x + w * 0.25} ${y + h + a} ${x} ${y + h - a}Z`,
        class: 'wm-shape',
      })];
    }
    // Two copies peeking out behind the front one: N of the same thing.
    case 'stacked':
      return [
        el('rect', { x: x + 8, y, width: w - 8, height: h - 8, class: 'wm-shape' }),
        el('rect', { x: x + 4, y: y + 4, width: w - 8, height: h - 8, class: 'wm-shape' }),
        el('rect', { x, y: y + 8, width: w - 8, height: h - 8, class: 'wm-shape' }),
      ];
    // A cylinder on its side: the conventional FIFO / queue.
    case 'queue': {
      const r = Math.min(12, w / 6);
      return [
        el('path', {
          d: `M${x + r} ${y}H${x + w - r}A${r} ${h / 2} 0 0 1 ${x + w - r} ${y + h}` +
             `H${x + r}A${r} ${h / 2} 0 0 1 ${x + r} ${y}Z`,
          class: 'wm-shape',
        }),
        line(`M${x + w - r} ${y}A${r} ${h / 2} 0 0 0 ${x + w - r} ${y + h}`),
      ];
    }
    // Points right, the way a buffer / driver / amplifier is drawn.
    case 'buffer':
      return [el('polygon', { points: `${x},${y} ${x + w},${cy} ${x},${y + h}`, class: 'wm-shape' })];
    case 'delay': {
      const r = Math.min(h / 2, w / 2);
      return [el('path', {
        d: `M${x} ${y}H${x + w - r}A${r} ${h / 2} 0 0 1 ${x + w - r} ${y + h}H${x}Z`, class: 'wm-shape',
      })];
    }
    case 'junction':
      return [el('ellipse', { cx, cy, rx: w / 2, ry: h / 2, class: 'wm-shape wm-solid' })];
    case 'sum': {
      const dx = (w / 2) * 0.707;
      const dy = (h / 2) * 0.707;
      return [
        el('ellipse', { cx, cy, rx: w / 2, ry: h / 2, class: 'wm-shape' }),
        line(`M${cx - dx} ${cy - dy}L${cx + dx} ${cy + dy}M${cx + dx} ${cy - dy}L${cx - dx} ${cy + dy}`),
      ];
    }
    case 'bar':
      return [el('rect', { x, y, width: w, height: h, rx: Math.min(2, w / 2), class: 'wm-shape wm-solid' })];
    case 'text':
    case 'point':
      return [];
    default:
      return [el('rect', { x, y, width: w, height: h, class: 'wm-shape' })];
  }
}

// Written as inline style, not as attributes: a presentation attribute loses to
// the class rules, so an attribute here would silently do nothing.
function labelText(parent, lines, cx, cy, size, bold, cls, defaultSize) {
  const lh = lineH(size);
  const text = el('text', { x: cx, y: cy - ((lines.length - 1) * lh) / 2, class: cls }, parent);
  if (size !== defaultSize) text.style.fontSize = size + 'px';
  if (bold) text.style.fontWeight = 'bold';
  lines.forEach((l, i) => { el('tspan', { x: cx, dy: i === 0 ? 0 : lh }, text).textContent = l; });
  return text;
}

function drawNode(parent, n) {
  const g = el('g', { 'data-id': n.id, 'data-kind': 'node' }, parent);
  for (const shape of shapeElement(n)) {
    if (shape.getAttribute('data-line')) shape.style.fill = 'none';
    else if (n.fill && n.fill !== '#ffffff') shape.style.fill = n.fill;
    g.appendChild(shape);
  }
  if (LABELLESS.has(n.shape)) return g;
  const size = n.fontSize || DEFAULT_FONT_SIZE;
  const area = labelArea(n);
  const lines = wrapLabel(n.label, area.w - LABEL_PAD_X * 2, size, n.bold);
  labelText(g, lines, area.x + area.w / 2, area.y + area.h / 2, size, n.bold, 'wm-label', DEFAULT_FONT_SIZE);
  return g;
}

// The title sits in a filled tab rather than as loose grey text: a group you
// can't see is a group you think didn't happen.
function drawGroup(parent, g) {
  const node = el('g', { 'data-id': g.id, 'data-kind': 'group' }, parent);
  el('rect', { x: g.x, y: g.y, width: g.w, height: g.h, rx: 8, class: 'wm-group' }, node);
  const size = g.fontSize || GROUP_FONT_SIZE;
  el('rect', { x: g.x, y: g.y, width: groupTabWidth(g), height: groupTitleH(g), rx: 6, class: 'wm-group-tab' }, node);
  const title = el('text', { x: g.x + size * 0.8, y: g.y + groupTitleH(g) / 2, class: 'wm-group-title' }, node);
  if (size !== GROUP_FONT_SIZE) title.style.fontSize = size + 'px';
  title.textContent = g.label;
  return node;
}

// Sized to the title. Not capped at the group's width: a big title on a
// narrow group overhangs rather than being cut off mid-word.
function groupTabWidth(g) {
  const size = g.fontSize || GROUP_FONT_SIZE;
  return textWidth(g.label, size, true) + size * 1.6;
}

// --- edge routing -------------------------------------------------------
//
// Right-angle routing between bounding boxes. Block diagrams are drawn with
// square corners, not curves -- this is most of why the output reads as a real
// block diagram rather than as a flowchart.

const DIRS = { n: { x: 0, y: -1 }, s: { x: 0, y: 1 }, e: { x: 1, y: 0 }, w: { x: -1, y: 0 } };

function centerOf(n) { return { x: n.x + n.w / 2, y: n.y + n.h / 2 }; }

// Which side of `a` faces `b`.
function facingSide(a, b) {
  const ac = centerOf(a);
  const bc = centerOf(b);
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;
  return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'e' : 'w') : (dy >= 0 ? 's' : 'n');
}

// Where the line from a node's centre towards `toward` leaves its outline.
// Round and diamond shapes are met at their real edge -- a straight connector
// stopping at the invisible box around a circle looks like it missed.
function outlinePoint(n, toward) {
  const c = centerOf(n);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (!dx && !dy) return c;
  const rx = n.w / 2;
  const ry = n.h / 2;
  let t;
  if (['circle', 'doublecircle', 'junction', 'sum'].includes(n.shape)) t = 1 / Math.hypot(dx / rx, dy / ry);
  else if (n.shape === 'diamond') t = 1 / (Math.abs(dx) / rx + Math.abs(dy) / ry);
  else t = Math.min(dx ? rx / Math.abs(dx) : Infinity, dy ? ry / Math.abs(dy) : Infinity);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

// `t` runs 0..1 along the side, left-to-right or top-to-bottom. The point is
// on the shape's real outline: for a circle or a diamond the spot on the
// bounding box is pushed straight in until it meets the curve or the slope, so
// a line attached anywhere along the side still touches the shape.
function anchorPoint(n, side, t) {
  const x = side === 'n' || side === 's' ? n.x + n.w * t : side === 'w' ? n.x : n.x + n.w;
  const y = side === 'e' || side === 'w' ? n.y + n.h * t : side === 'n' ? n.y : n.y + n.h;
  const round = ['circle', 'doublecircle', 'junction', 'sum'].includes(n.shape);
  if ((!round && n.shape !== 'diamond') || !n.w || !n.h) return { x, y };
  const c = centerOf(n);
  const rx = n.w / 2;
  const ry = n.h / 2;
  // How far out from the centre the outline is, as a fraction of the half
  // size, at this offset along the side.
  const reach = (off) => round ? Math.sqrt(Math.max(0, 1 - off * off)) : Math.max(0, 1 - Math.abs(off));
  if (side === 'n' || side === 's') {
    const k = reach((x - c.x) / rx);
    return { x, y: c.y + (side === 'n' ? -1 : 1) * ry * k };
  }
  const k = reach((y - c.y) / ry);
  return { x: c.x + (side === 'w' ? -1 : 1) * rx * k, y };
}

// The spot on `n`'s outline nearest to `p`, as the side and position an edge
// end stores, plus how far away it is. This is what lets a line attach at any
// point along any edge rather than only at fixed ports.
function nearestOnOutline(n, p) {
  let best = null;
  for (const side of ['n', 'e', 's', 'w']) {
    const along = side === 'n' || side === 's' ? (p.x - n.x) / n.w : (p.y - n.y) / n.h;
    const t = Math.max(0.02, Math.min(0.98, along));
    const at = anchorPoint(n, side, t);
    const dist = Math.hypot(p.x - at.x, p.y - at.y);
    if (!best || dist < best.dist) best = { side, t, at, dist };
  }
  return best;
}

// Drops duplicate points and any interior point sitting on the line between its
// neighbours. A straight hop would otherwise keep redundant midpoints, which
// split the run and push the edge label up against one box.
function simplify(pts) {
  const spaced = pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > 0.5);
  if (spaced.length < 3) return spaced;
  const out = [spaced[0]];
  for (let i = 1; i < spaced.length - 1; i++) {
    const a = out[out.length - 1];
    const b = spaced[i];
    const c = spaced[i + 1];
    if (Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) > 0.01) out.push(b);
  }
  out.push(spaced[spaced.length - 1]);
  return out;
}

// Where a connector's first straight run out of node `n` ends: STUB beyond the
// node's bounding box, measured from the box rather than from the attach point.
// On a circle or diamond the attach point can sit well inside the box, and a
// stub measured from there would end inside it and read as cutting through.
function stubOf(n, p, side) {
  if (side === 'n') return { x: p.x, y: n.y - STUB };
  if (side === 's') return { x: p.x, y: n.y + n.h + STUB };
  if (side === 'w') return { x: n.x - STUB, y: p.y };
  return { x: n.x + n.w + STUB, y: p.y };
}

// Does an axis-aligned segment pass through the inside of box `r`? Running
// along its border doesn't count.
function crossesBox(u, v, r) {
  if (!r.w || !r.h) return false;
  return Math.max(u.x, v.x) > r.x + 1 && Math.min(u.x, v.x) < r.x + r.w - 1 &&
         Math.max(u.y, v.y) > r.y + 1 && Math.min(u.y, v.y) < r.y + r.h - 1;
}

// A right-angle route's cost, or null if it's unacceptable: a leg that isn't
// horizontal or vertical, one that cuts through either block, or a route that
// leaves its first block anywhere but straight out of the side it's attached
// to (or arrives at the second any other way). Bends cost extra, so a route
// with fewer corners wins over a marginally shorter one with more.
function routeCost(pts, s0, A, s1, B) {
  if (pts.length < 2) return null;
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    const u = pts[i - 1];
    const v = pts[i];
    if (Math.abs(u.x - v.x) > 0.5 && Math.abs(u.y - v.y) > 0.5) return null;
    len += Math.abs(u.x - v.x) + Math.abs(u.y - v.y);
    // The first leg starts on A's outline heading out of it and the last ends
    // on B's heading in, so each is only checked against the other block.
    if (i > 1 && crossesBox(u, v, A)) return null;
    if (i < pts.length - 1 && crossesBox(u, v, B)) return null;
  }
  const out = DIRS[s0];
  const into = DIRS[s1];
  const first = pts[1];
  const last = pts[pts.length - 2];
  const end = pts[pts.length - 1];
  if ((first.x - pts[0].x) * out.x + (first.y - pts[0].y) * out.y <= 0) return null;
  if ((last.x - end.x) * into.x + (last.y - end.y) * into.y <= 0) return null;
  return len + (pts.length - 2) * 24;
}

// The bends of an automatically routed right-angle connector, between its two
// stub ends. Rather than one fixed shape, it tries every plausible one -- a
// straight run, a single corner, a Z through the middle or round the outside
// of both blocks, a U -- and keeps the cheapest acceptable route (see
// routeCost). That is what stops a connector from cutting through its own
// blocks or doubling back when the ends face away from each other. The
// middle-channel Z is tried first, so on a tie it wins: it's the balanced one.
function routeBends(p0, s0, a0, A, p1, s1, b0, B) {
  const M = STUB;
  const midX = (a0.x + b0.x) / 2;
  const midY = (a0.y + b0.y) / 2;
  const xs = [Math.min(A.x, B.x) - M, Math.max(A.x + A.w, B.x + B.w) + M, a0.x, b0.x];
  const ys = [Math.min(A.y, B.y) - M, Math.max(A.y + A.h, B.y + B.h) + M, a0.y, b0.y];
  const cands = [
    [{ x: midX, y: a0.y }, { x: midX, y: b0.y }],
    [{ x: a0.x, y: midY }, { x: b0.x, y: midY }],
    [],
    [{ x: b0.x, y: a0.y }],
    [{ x: a0.x, y: b0.y }],
  ];
  for (const x of xs) cands.push([{ x, y: a0.y }, { x, y: b0.y }]);
  for (const y of ys) cands.push([{ x: a0.x, y }, { x: b0.x, y }]);
  for (const x of xs.concat(midX)) {
    for (const y of ys.concat(midY)) {
      cands.push([{ x, y: a0.y }, { x, y }, { x: b0.x, y }]);
      cands.push([{ x: a0.x, y }, { x, y }, { x, y: b0.y }]);
    }
  }
  let best = null;
  for (const c of cands) {
    const cost = routeCost(simplify([p0, a0].concat(c, [b0, p1])), s0, A, s1, B);
    if (cost != null && (!best || cost < best.cost)) best = { cost, c };
  }
  // Nothing acceptable (the blocks overlap, say): a single corner is the least
  // bad thing to draw.
  return best ? best.c : [{ x: b0.x, y: a0.y }];
}

// Joins points with right angles, adding a corner wherever two neighbours
// differ in both x and y. A hand-edited path only stores its bends, so when a
// block moves afterwards this is what keeps the connector square: the stub
// that moved with the block gets a fresh corner to meet the stored bends. The
// corner turns off the previous leg rather than continuing it, so it never
// doubles back over itself.
function joinOrthogonal(pts) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const u = out[out.length - 1];
    const v = pts[i];
    if (Math.abs(u.x - v.x) > 0.5 && Math.abs(u.y - v.y) > 0.5) {
      const prev = out[out.length - 2];
      const cameHorizontal = prev && Math.abs(prev.y - u.y) < 0.5;
      out.push(cameHorizontal ? { x: u.x, y: v.y } : { x: v.x, y: u.y });
    }
    const last = out[out.length - 1];
    if (Math.hypot(last.x - v.x, last.y - v.y) > 0.5) out.push(v);
  }
  return out;
}

function selfLoopPoints(n) {
  const cy = n.y + n.h / 2;
  const r = 26;
  return [
    { x: n.x + n.w, y: cy - 10 },
    { x: n.x + n.w + r, y: cy - 10 },
    { x: n.x + n.w + r, y: cy + 10 },
    { x: n.x + n.w, y: cy + 10 },
  ];
}

// All edges are routed in one pass rather than one at a time, because several
// edges leaving the same side of a block have to be spread along it instead of
// piling onto one midpoint. That spreading is most of what makes a fan-out
// read as separate signals.
//
// Returns one route per edge, indexed to match d.edges (null if an endpoint is
// missing). `raw` keeps every point including the two stub ends and collinear
// runs -- the editor needs those to know which leg you grabbed. `from`/`to`
// are the resolved ports, and `a0`/`b0` the stub ends a stored path hangs off.
function edgeRoutes(d) {
  const slots = d.edges.map((e) => {
    const a = nodeById(d, e.from);
    const b = nodeById(d, e.to);
    if (!a || !b) return null;
    if (a === b) return { a, self: true };
    // A straight connector runs between the exact points its ends were
    // attached at, or, for an end left floating, towards the other end and cut
    // off at the outline. It joins no fan-out, so it skips everything below.
    if (e.route === 'straight') return { a, b, straight: true, fa: e.fromAnchor, ta: e.toAnchor };
    const fa = e.fromAnchor || {};
    const ta = e.toAnchor || {};
    return {
      a, b,
      from: { side: fa.side || facingSide(a, b), t: fa.t, other: b, pinned: fa.t != null },
      to: { side: ta.side || facingSide(b, a), t: ta.t, other: a, pinned: ta.t != null },
    };
  });

  // Every end on each side of each block: the automatic ones to be spaced out,
  // and the pinned ones, whose spots the automatic ones must keep clear of --
  // otherwise an automatic line happily leaves from the very spot a pinned one
  // does and the two run on top of each other.
  const buckets = new Map();
  for (const s of slots) {
    if (!s || s.self || s.straight) continue;
    for (const [end, node] of [[s.from, s.a], [s.to, s.b]]) {
      const key = node.id + end.side;
      if (!buckets.has(key)) buckets.set(key, { free: [], pinned: [] });
      buckets.get(key)[end.t != null ? 'pinned' : 'free'].push(end);
    }
  }
  for (const { free, pinned } of buckets.values()) {
    if (!free.length) continue;
    // Order the fan by where the other end actually sits, so connectors don't
    // cross each other on the way out.
    const axis = free[0].side === 'n' || free[0].side === 's' ? 'x' : 'y';
    free.sort((p, q) => centerOf(p.other)[axis] - centerOf(q.other)[axis]);
    // Evenly spaced spots for every end on the side; each pinned end claims
    // the spot nearest it, and the automatic ones take the rest in order.
    const n = free.length + pinned.length;
    const spots = Array.from({ length: n }, (_, i) => (i + 1) / (n + 1));
    for (const p of pinned) {
      let k = 0;
      spots.forEach((t, i) => { if (Math.abs(t - p.t) < Math.abs(spots[k] - p.t)) k = i; });
      spots.splice(k, 1);
    }
    free.forEach((end, i) => { end.t = spots[i]; end.solo = n === 1; });
  }

  // Two blocks facing each other with some overlap get a dead straight
  // connector through the middle of that overlap, instead of centre-to-centre
  // with a tiny kink because their centres are two pixels apart. Only when
  // both ends are automatic and alone on their side -- a pinned port or a fan
  // takes precedence.
  // Likewise when one end was attached at an exact spot: a free end on a
  // facing block lines up with it, so a connector dropped level with the other
  // block comes out dead straight rather than with a small jog in it.
  for (const s of slots) {
    if (!s || s.self || s.straight) continue;
    const horiz = (s.from.side === 'e' && s.to.side === 'w') || (s.from.side === 'w' && s.to.side === 'e');
    const vert = (s.from.side === 's' && s.to.side === 'n') || (s.from.side === 'n' && s.to.side === 's');
    if (!horiz && !vert) continue;
    const [pos, len] = horiz ? ['y', 'h'] : ['x', 'w'];
    const within = (n, c) => n[len] && c >= n[pos] + 2 && c <= n[pos] + n[len] - 2;
    if (s.from.solo && s.to.solo) {
      const lo = Math.max(s.a[pos], s.b[pos]);
      const hi = Math.min(s.a[pos] + s.a[len], s.b[pos] + s.b[len]);
      if (hi - lo < 8) continue;
      const mid = (lo + hi) / 2;
      s.from.t = (mid - s.a[pos]) / s.a[len];
      s.to.t = (mid - s.b[pos]) / s.b[len];
    } else if (s.from.solo && s.to.pinned) {
      const c = anchorPoint(s.b, s.to.side, s.to.t)[pos];
      if (within(s.a, c)) s.from.t = (c - s.a[pos]) / s.a[len];
    } else if (s.to.solo && s.from.pinned) {
      const c = anchorPoint(s.a, s.from.side, s.from.t)[pos];
      if (within(s.b, c)) s.to.t = (c - s.b[pos]) / s.b[len];
    }
  }

  return slots.map((s, i) => {
    if (!s) return null;
    if (s.self) return { self: true, raw: selfLoopPoints(s.a) };
    if (s.straight) {
      const pinned = (n, an) => an && an.t != null ? anchorPoint(n, an.side, an.t) : null;
      let p0 = pinned(s.a, s.fa);
      let p1 = pinned(s.b, s.ta);
      if (!p0) p0 = outlinePoint(s.a, p1 || centerOf(s.b));
      if (!p1) p1 = outlinePoint(s.b, p0);
      return { straight: true, raw: [p0, p1] };
    }
    const p0 = anchorPoint(s.a, s.from.side, s.from.t);
    const p1 = anchorPoint(s.b, s.to.side, s.to.t);
    const a0 = stubOf(s.a, p0, s.from.side);
    const b0 = stubOf(s.b, p1, s.to.side);
    const bends = d.edges[i].points && d.edges[i].points.length
      ? d.edges[i].points : routeBends(p0, s.from.side, a0, s.a, p1, s.to.side, b0, s.b);
    return {
      raw: joinOrthogonal([p0, a0].concat(bends, [b0, p1])),
      from: { side: s.from.side, t: s.from.t },
      to: { side: s.to.side, t: s.to.t },
      a0, b0,
    };
  });
}

// What actually gets drawn: the routes with redundant points removed.
function edgeGeometry(d) {
  return edgeRoutes(d).map((r) => r && (r.self ? r.raw : simplify(r.raw)));
}

function roundedPathD(raw, r) {
  // Two coincident points make a zero-length leg, and rounding its corner
  // divides by that length -- NaN in the path, and a connector that vanishes
  // from the canvas and the inserted picture alike.
  const pts = raw.filter((p, i) => i === 0 || Math.hypot(p.x - raw[i - 1].x, p.y - raw[i - 1].y) > 0.01);
  if (pts.length < 2) return '';
  let d = `M${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1], cur = pts[i], next = pts[i + 1];
    const inLen = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const outLen = Math.hypot(next.x - cur.x, next.y - cur.y);
    const rr = Math.min(r, inLen / 2, outLen / 2);
    const a = { x: cur.x + ((prev.x - cur.x) / inLen) * rr, y: cur.y + ((prev.y - cur.y) / inLen) * rr };
    const b = { x: cur.x + ((next.x - cur.x) / outLen) * rr, y: cur.y + ((next.y - cur.y) / outLen) * rr };
    d += `L${a.x} ${a.y}Q${cur.x} ${cur.y} ${b.x} ${b.y}`;
  }
  const last = pts[pts.length - 1];
  return d + `L${last.x} ${last.y}`;
}

// Arrowheads grow with the line, or a bus-width connector ends in a pinprick.
function arrowSize(e) {
  const w = e.width || DEFAULT_EDGE_W;
  return { len: 7 + w * 2, half: 3 + w * 1.1 };
}

function arrowHeadD(tip, from, len, half) {
  const dist = Math.hypot(tip.x - from.x, tip.y - from.y) || 1;
  const ux = (tip.x - from.x) / dist;
  const uy = (tip.y - from.y) / dist;
  const bx = tip.x - ux * len;
  const by = tip.y - uy * len;
  return `M${tip.x} ${tip.y}L${bx - uy * half} ${by + ux * half}` +
         `L${bx + uy * half} ${by - ux * half}Z`;
}

// Pulls the line back so it stops at the base of the arrowhead instead of
// running through it and poking out the tip.
function trimEnd(pts, amount) {
  const out = pts.slice();
  const last = out[out.length - 1];
  const prev = out[out.length - 2];
  const len = Math.hypot(last.x - prev.x, last.y - prev.y);
  // A leg no longer than the arrowhead is left alone: pulling it back would
  // leave its end sitting on top of the previous point.
  if (len <= amount + 1) return out;
  out[out.length - 1] = {
    x: last.x - ((last.x - prev.x) / len) * amount,
    y: last.y - ((last.y - prev.y) / len) * amount,
  };
  return out;
}

// Labels go on the longest leg rather than at the path's middle index, which
// often lands exactly on a corner or under an arrowhead.
function longestSegmentMidpoint(pts) {
  let best = 1;
  let bestLen = -1;
  for (let i = 1; i < pts.length; i++) {
    const len = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (len > bestLen) { bestLen = len; best = i; }
  }
  return { x: (pts[best].x + pts[best - 1].x) / 2, y: (pts[best].y + pts[best - 1].y) / 2 };
}

// Where an edge's label box sits, with its lines. Shared by drawing, the export
// bounds and the editor, so the label is never cropped or mis-hit.
function edgeLabelBox(e, pts) {
  const size = e.fontSize || DEFAULT_EDGE_FONT;
  const lines = String(e.label).split('\n');
  const mid = longestSegmentMidpoint(pts);
  const w = Math.max(...lines.map((l) => textWidth(l, size, e.bold))) + 10;
  const h = lines.length * lineH(size) + 4;
  return { x: mid.x - w / 2, y: mid.y - h / 2, w, h, mid, lines, size };
}

function drawEdge(parent, e, pts, index) {
  const g = el('g', { 'data-index': index, 'data-kind': 'edge' }, parent);
  // Two blocks dropped exactly on top of each other collapse the route to a
  // single point; there is nothing to draw and an arrowhead needs two.
  if (pts.length < 2) return g;
  const w = e.width || DEFAULT_EDGE_W;
  const { len, half } = arrowSize(e);
  const endHead = e.head === 'end' || e.head === 'both';
  const startHead = e.head === 'both';

  let linePts = pts;
  if (endHead) linePts = trimEnd(linePts, len - 1);
  if (startHead) linePts = trimEnd(linePts.slice().reverse(), len - 1).reverse();

  const path = el('path', {
    d: roundedPathD(linePts, CORNER_R),
    class: e.dash === 'dotted' ? 'wm-edge wm-edge-dotted' : 'wm-edge',
  }, g);
  if (w !== DEFAULT_EDGE_W) path.style.strokeWidth = w;
  if (e.color) path.style.stroke = e.color;

  const heads = [];
  if (endHead) heads.push(arrowHeadD(pts[pts.length - 1], pts[pts.length - 2], len, half));
  if (startHead) heads.push(arrowHeadD(pts[0], pts[1], len, half));
  for (const d of heads) {
    const head = el('path', { d, class: 'wm-arrow' }, g);
    if (e.color) head.style.fill = e.color;
  }

  if (e.label) {
    const box = edgeLabelBox(e, pts);
    el('rect', { x: box.x, y: box.y, width: box.w, height: box.h, class: 'wm-edge-label-bg' }, g);
    const text = labelText(g, box.lines, box.mid.x, box.mid.y, box.size, e.bold, 'wm-edge-label', DEFAULT_EDGE_FONT);
    if (e.color) text.style.fill = e.color;
  }
  return g;
}

// Groups sit behind nodes, edges above groups but below nodes, so a connector
// never cuts across a label.
function drawDiagram(parent, d) {
  const groupLayer = el('g', { 'data-layer': 'groups' }, parent);
  const edgeLayer = el('g', { 'data-layer': 'edges' }, parent);
  const nodeLayer = el('g', { 'data-layer': 'nodes' }, parent);

  for (const g of d.groups) if (g.w > 0) drawGroup(groupLayer, g);
  edgeGeometry(d).forEach((pts, i) => { if (pts) drawEdge(edgeLayer, d.edges[i], pts, i); });
  for (const n of d.nodes) drawNode(nodeLayer, n);
}

// Everything that gets drawn, not just the blocks: connectors can run outside
// the outermost blocks (their stubs, a dragged path, a self-loop) and a label
// can hang past its connector. Bounding only the blocks is what cropped
// connectors off the edges of the inserted picture.
function diagramBounds(d) {
  const xs = [];
  const ys = [];
  const add = (x0, y0, x1, y1) => { xs.push(x0, x1); ys.push(y0, y1); };
  for (const b of d.nodes.concat(d.groups.filter((g) => g.w > 0))) add(b.x, b.y, b.x + b.w, b.y + b.h);
  // Text is allowed to spill out of a block resized smaller than its label,
  // and a long group name out of a narrow group; the spill is drawn, so it
  // counts too.
  for (const n of d.nodes) {
    if (LABELLESS.has(n.shape) || !n.label) continue;
    const size = n.fontSize || DEFAULT_FONT_SIZE;
    const area = labelArea(n);
    const lines = wrapLabel(n.label, area.w - LABEL_PAD_X * 2, size, n.bold);
    const tw = Math.max(...lines.map((l) => textWidth(l, size, n.bold)));
    const th = lines.length * lineH(size);
    const cx = area.x + area.w / 2;
    const cy = area.y + area.h / 2;
    add(cx - tw / 2, cy - th / 2, cx + tw / 2, cy + th / 2);
  }
  for (const g of d.groups) {
    if (g.w > 0) add(g.x, g.y, g.x + groupTabWidth(g), g.y + groupTitleH(g));
  }
  edgeGeometry(d).forEach((pts, i) => {
    if (!pts || pts.length < 2) return;
    const e = d.edges[i];
    // Half the stroke, or the arrowhead's half-width where that's wider.
    const m = Math.max((e.width || DEFAULT_EDGE_W) / 2, e.head === 'none' ? 0 : arrowSize(e).half) + 1;
    for (const p of pts) add(p.x - m, p.y - m, p.x + m, p.y + m);
    if (e.label) { const b = edgeLabelBox(e, pts); add(b.x, b.y, b.x + b.w, b.y + b.h); }
  });
  if (!xs.length) return { x: 0, y: 0, w: 1, h: 1 };
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
}

// Standalone, self-contained SVG for rasterization. Explicit width/height on
// the root (not "100%") -- some browsers refuse to drawImage an SVG without
// them, and the rasterizer needs a real intrinsic size.
function buildExportSvg(d) {
  const b = diagramBounds(d);
  const w = Math.ceil(b.w + EXPORT_PAD * 2);
  const h = Math.ceil(b.h + EXPORT_PAD * 2);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('xmlns', SVG_NS);
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  el('style', {}, svg).textContent = SVG_STYLE;
  el('rect', { x: 0, y: 0, width: w, height: h, fill: '#ffffff' }, svg);
  const world = el('g', { transform: `translate(${EXPORT_PAD - b.x} ${EXPORT_PAD - b.y})` }, svg);
  drawDiagram(world, d);
  return { svg, width: w, height: h };
}

// --- the picture that goes into the document ----------------------------

const RASTER_SCALE = 3;          // oversample, so the PNG stays sharp in print
// Placed so a label at the default size lands at 11pt -- the size of the body
// text around it. At a literal 1px = 0.75pt it came out at 9.75pt, a visibly
// smaller, fussier-looking diagram than the document it sits in.
const PX_TO_PT = 11 / DEFAULT_FONT_SIZE;
const MAX_DOC_WIDTH_PT = 468;    // 6.5in: US Letter minus one-inch margins

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Word sizes a freshly inserted picture from the image's own DPI metadata. A
// canvas PNG has none, so Word assumed 96dpi, placed the oversampled bitmap at
// three times its intended size -- onto a page of its own -- and only settled
// down once the picture was clicked and re-laid-out. Declaring the real DPI in
// a pHYs chunk makes it land at the right size on the first pass.
function withPngDpi(bytes, dpi) {
  const ppm = Math.round(dpi / 0.0254);          // PNG stores pixels per metre
  const chunk = new Uint8Array(21);              // len(4) + "pHYs"(4) + data(9) + crc(4)
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4);
  dv.setUint32(8, ppm);
  dv.setUint32(12, ppm);
  chunk[16] = 1;                                 // unit: metres
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));

  // IHDR is always first and always 13 bytes of data, and pHYs must precede
  // IDAT, so directly after IHDR is both legal and easy to find.
  const at = 8 + 4 + 4 + 13 + 4;
  const out = new Uint8Array(bytes.length + chunk.length);
  out.set(bytes.subarray(0, at), 0);
  out.set(chunk, at);
  out.set(bytes.subarray(at), at + chunk.length);
  return out;
}

function toBase64(bytes) {
  let s = '';
  // In chunks: String.fromCharCode.apply blows the argument limit on a whole
  // megapixel image.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

// SVG -> data: URL -> <img> -> canvas -> PNG. Never a blob: URL, which taints
// the canvas in some hosts.
async function renderPng(d) {
  const { svg, width, height } = buildExportSvg(d);
  const text = new XMLSerializer().serializeToString(svg);
  // btoa throws on non-Latin1, and labels are arbitrary UTF-8.
  const dataUrl = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(text)));

  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('the SVG failed to decode'));
    img.src = dataUrl;
  });

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * RASTER_SCALE);
  canvas.height = Math.ceil(height * RASTER_SCALE);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  // Wide diagrams are scaled down to the text column rather than overflowing
  // it; the declared DPI rises to match, so the picture still lands at the
  // size we asked for.
  let w = width * PX_TO_PT;
  let h = height * PX_TO_PT;
  if (w > MAX_DOC_WIDTH_PT) { h *= MAX_DOC_WIDTH_PT / w; w = MAX_DOC_WIDTH_PT; }

  const raw = atob(canvas.toDataURL('image/png').split(',')[1]);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

  return { base64: toBase64(withPngDpi(bytes, (canvas.width / w) * 72)), widthPt: w, heightPt: h };
}
