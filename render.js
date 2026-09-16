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
const FONT_SIZE = 13;
const LINE_HEIGHT = 16;
const LABEL_PAD_X = 14;
const LABEL_PAD_Y = 12;
const CORNER_R = 8;
const ARROW_LEN = 10;
const ARROW_HALF = 4.5;
const EXPORT_PAD = 24;

const SVG_NS = 'http://www.w3.org/2000/svg';

const SVG_STYLE = `
  .wm-shape { fill: #ffffff; stroke: #333333; stroke-width: 1.5; }
  .wm-label { font-family: ${FONT_STACK}; font-size: ${FONT_SIZE}px; fill: #111111;
              text-anchor: middle; dominant-baseline: middle; }
  .wm-edge  { fill: none; stroke: #555555; stroke-width: 1.5; stroke-linejoin: round;
              stroke-linecap: round; }
  .wm-edge-thick  { stroke-width: 3.5; }
  .wm-edge-dotted { stroke-dasharray: 5 4; }
  .wm-arrow { fill: #555555; stroke: none; }
  .wm-edge-label { font-family: ${FONT_STACK}; font-size: 12px; fill: #333333;
                   text-anchor: middle; dominant-baseline: middle; }
  .wm-edge-label-bg { fill: #ffffff; stroke: none; }
  .wm-group { fill: #f7f7f9; stroke: #9aa0a6; stroke-width: 1.2; stroke-dasharray: 6 4; }
  .wm-group-title { font-family: ${FONT_STACK}; font-size: 12px; fill: #5f6368;
                    text-anchor: start; dominant-baseline: middle; font-weight: bold; }
`;

function el(tag, attrs, parent) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) node.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(node);
  return node;
}

// Text measurement via a 2D context -- synchronous, and matches what the SVG
// will do closely enough for wrapping decisions.
let measureCtx = null;
function textWidth(s) {
  if (!measureCtx) {
    measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = FONT_SIZE + 'px ' + FONT_STACK;
  }
  return measureCtx.measureText(s).width;
}

function wrapLabel(label, maxWidth) {
  const out = [];
  for (const para of String(label || '').split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const candidate = line + ' ' + words[i];
      if (textWidth(candidate) <= maxWidth) line = candidate;
      else { out.push(line); line = words[i]; }
    }
    out.push(line);
  }
  return out;
}

// Grows a node to fit its label. Never shrinks below what the user dragged it
// to -- resizing is theirs to control, this only prevents clipped text.
function fitNodeSize(n) {
  const lines = wrapLabel(n.label, Math.max(60, n.w - LABEL_PAD_X * 2));
  const needW = Math.ceil(Math.max(...lines.map(textWidth), 0)) + LABEL_PAD_X * 2;
  const needH = lines.length * LINE_HEIGHT + LABEL_PAD_Y * 2;
  n.w = Math.max(n.w, needW, 60);
  n.h = Math.max(n.h, needH, 36);
}

function shapeElement(n) {
  const { x, y, w, h } = n;
  const cx = x + w / 2;
  const cy = y + h / 2;
  switch (n.shape) {
    case 'round':
      return [el('rect', { x, y, width: w, height: h, rx: 12, class: 'wm-shape' })];
    case 'stadium':
      return [el('rect', { x, y, width: w, height: h, rx: h / 2, class: 'wm-shape' })];
    case 'subroutine':
      return [
        el('rect', { x, y, width: w, height: h, class: 'wm-shape' }),
        el('path', { d: `M${x + 8} ${y}V${y + h}M${x + w - 8} ${y}V${y + h}`, class: 'wm-shape' }),
      ];
    case 'cylinder': {
      const ry = Math.min(12, h / 4);
      return [
        el('path', {
          d: `M${x} ${y + ry}A${w / 2} ${ry} 0 0 1 ${x + w} ${y + ry}` +
             `V${y + h - ry}A${w / 2} ${ry} 0 0 1 ${x} ${y + h - ry}Z`,
          class: 'wm-shape',
        }),
        el('path', { d: `M${x} ${y + ry}A${w / 2} ${ry} 0 0 0 ${x + w} ${y + ry}`, class: 'wm-shape' }),
      ];
    }
    case 'circle':
      return [el('ellipse', { cx, cy, rx: w / 2, ry: h / 2, class: 'wm-shape' })];
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
    case 'parallelogram': {
      const s = Math.min(20, w * 0.2);
      return [el('polygon', {
        points: `${x + s},${y} ${x + w},${y} ${x + w - s},${y + h} ${x},${y + h}`, class: 'wm-shape',
      })];
    }
    case 'text':
      return [];
    default:
      return [el('rect', { x, y, width: w, height: h, class: 'wm-shape' })];
  }
}

function drawNode(parent, n) {
  const g = el('g', { 'data-id': n.id, 'data-kind': 'node' }, parent);
  // Written as inline style, not as a fill attribute: a presentation attribute
  // loses to the .wm-shape class rule, so an attribute here would silently do
  // nothing. Only the first element is the body; anything after it is detail
  // linework (the cylinder's rim, the subroutine's side bars) and stays unfilled.
  shapeElement(n).forEach((shape, i) => {
    if (i === 0) { if (n.fill && n.fill !== '#ffffff') shape.style.fill = n.fill; }
    else shape.style.fill = 'none';
    g.appendChild(shape);
  });
  const lines = wrapLabel(n.label, n.w - LABEL_PAD_X * 2);
  // A cylinder's rim cuts across the middle of the box, so its label sits below it.
  const shift = n.shape === 'cylinder' ? Math.min(12, n.h / 4) * 0.75 : 0;
  const startY = n.y + n.h / 2 + shift - ((lines.length - 1) * LINE_HEIGHT) / 2;
  const text = el('text', { x: n.x + n.w / 2, y: startY, class: 'wm-label' }, g);
  lines.forEach((line, i) => {
    el('tspan', { x: n.x + n.w / 2, dy: i === 0 ? 0 : LINE_HEIGHT }, text).textContent = line;
  });
  return g;
}

function drawGroup(parent, g) {
  const node = el('g', { 'data-id': g.id, 'data-kind': 'group' }, parent);
  el('rect', { x: g.x, y: g.y, width: g.w, height: g.h, rx: 6, class: 'wm-group' }, node);
  el('text', { x: g.x + 12, y: g.y + 14, class: 'wm-group-title' }, node).textContent = g.label;
  return node;
}

// --- edge routing -------------------------------------------------------
//
// Right-angle routing between bounding boxes. Block diagrams are drawn with
// square corners, not curves -- this is most of why the output reads as a real
// block diagram rather than as a flowchart.

function routePoints(a, b) {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };

  if (a === b) {
    const r = 26;
    return [
      { x: a.x + a.w, y: ac.y - 10 },
      { x: a.x + a.w + r, y: ac.y - 10 },
      { x: a.x + a.w + r, y: ac.y + 10 },
      { x: a.x + a.w, y: ac.y + 10 },
    ];
  }

  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;
  let pts;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const p0 = { x: dx >= 0 ? a.x + a.w : a.x, y: ac.y };
    const p1 = { x: dx >= 0 ? b.x : b.x + b.w, y: bc.y };
    const mx = (p0.x + p1.x) / 2;
    pts = [p0, { x: mx, y: p0.y }, { x: mx, y: p1.y }, p1];
  } else {
    const p0 = { x: ac.x, y: dy >= 0 ? a.y + a.h : a.y };
    const p1 = { x: bc.x, y: dy >= 0 ? b.y : b.y + b.h };
    const my = (p0.y + p1.y) / 2;
    pts = [p0, { x: p0.x, y: my }, { x: p1.x, y: my }, p1];
  }

  return pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > 0.5);
}

function roundedPathD(pts, r) {
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

function arrowHeadD(tip, from) {
  const len = Math.hypot(tip.x - from.x, tip.y - from.y) || 1;
  const ux = (tip.x - from.x) / len;
  const uy = (tip.y - from.y) / len;
  const bx = tip.x - ux * ARROW_LEN;
  const by = tip.y - uy * ARROW_LEN;
  return `M${tip.x} ${tip.y}L${bx - uy * ARROW_HALF} ${by + ux * ARROW_HALF}` +
         `L${bx + uy * ARROW_HALF} ${by - ux * ARROW_HALF}Z`;
}

// Pulls the line back so it stops at the base of the arrowhead instead of
// running through it and poking out the tip.
function trimEnd(pts, amount) {
  const out = pts.slice();
  const last = out[out.length - 1];
  const prev = out[out.length - 2];
  const len = Math.hypot(last.x - prev.x, last.y - prev.y);
  if (len <= amount) return out;
  out[out.length - 1] = {
    x: last.x - ((last.x - prev.x) / len) * amount,
    y: last.y - ((last.y - prev.y) / len) * amount,
  };
  return out;
}

// Labels go on the longest leg rather than at the path's middle index, which
// often lands exactly on a corner or under an arrowhead.
function longestSegmentMidpoint(pts) {
  let best = 0;
  let bestLen = -1;
  for (let i = 1; i < pts.length; i++) {
    const len = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (len > bestLen) { bestLen = len; best = i; }
  }
  return { x: (pts[best].x + pts[best - 1].x) / 2, y: (pts[best].y + pts[best - 1].y) / 2 };
}

function drawEdge(parent, e, from, to, index) {
  const g = el('g', { 'data-index': index, 'data-kind': 'edge' }, parent);
  const pts = routePoints(from, to);
  const hasEndArrow = e.style !== 'line';
  const hasStartArrow = e.style === 'bidir';

  let linePts = pts;
  if (hasEndArrow) linePts = trimEnd(linePts, ARROW_LEN - 1);
  if (hasStartArrow) linePts = trimEnd(linePts.slice().reverse(), ARROW_LEN - 1).reverse();

  let cls = 'wm-edge';
  if (e.style === 'thick') cls += ' wm-edge-thick';
  if (e.style === 'dotted') cls += ' wm-edge-dotted';
  el('path', { d: roundedPathD(linePts, CORNER_R), class: cls }, g);

  if (hasEndArrow) {
    el('path', { d: arrowHeadD(pts[pts.length - 1], pts[pts.length - 2]), class: 'wm-arrow' }, g);
  }
  if (hasStartArrow) {
    el('path', { d: arrowHeadD(pts[0], pts[1]), class: 'wm-arrow' }, g);
  }

  if (e.label) {
    const mid = longestSegmentMidpoint(pts);
    const w = textWidth(e.label) + 10;
    el('rect', { x: mid.x - w / 2, y: mid.y - 9, width: w, height: 18, class: 'wm-edge-label-bg' }, g);
    el('text', { x: mid.x, y: mid.y, class: 'wm-edge-label' }, g).textContent = e.label;
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
  d.edges.forEach((e, i) => {
    const from = nodeById(d, e.from);
    const to = nodeById(d, e.to);
    if (from && to) drawEdge(edgeLayer, e, from, to, i);
  });
  for (const n of d.nodes) drawNode(nodeLayer, n);
}

function diagramBounds(d) {
  const boxes = d.nodes.concat(d.groups.filter((g) => g.w > 0));
  if (!boxes.length) return { x: 0, y: 0, w: 1, h: 1 };
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  // Self-loops bulge to the right of their node; give them room.
  const loopPad = d.edges.some((e) => e.from === e.to) ? 40 : 0;
  return { x: x0, y: y0, w: x1 - x0 + loopPad, h: y1 - y0 };
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
