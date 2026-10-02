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
  .wm-bare  { stroke: none; }
  .wm-label { font-family: ${FONT_STACK}; font-size: ${DEFAULT_FONT_SIZE}px; fill: #111111;
              text-anchor: middle; dominant-baseline: middle; }
  .wm-edge  { fill: none; stroke: ${EDGE_COLOR}; stroke-width: ${DEFAULT_EDGE_W}; stroke-linejoin: round;
              stroke-linecap: round; }
  .wm-edge-dotted { stroke-dasharray: 5 4; }
  .wm-arrow { fill: ${EDGE_COLOR}; stroke: none; }
  .wm-edge-label { font-family: ${FONT_STACK}; font-size: ${DEFAULT_EDGE_FONT}px; fill: #333333;
                   text-anchor: middle; dominant-baseline: middle; }
  .wm-edge-label-bg { fill: #ffffff; stroke: none; }
  .wm-port { font-family: ${FONT_STACK}; font-size: 10px; fill: #444444; dominant-baseline: middle; }
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
// A shape turned by 90/180/270 degrees is drawn as its unturned self in the
// box it turns into: same centre, sides swapped for a quarter turn.
function unturned(n) {
  const quarter = n.rotate === 90 || n.rotate === 270;
  return Object.assign({}, n, quarter ? { x: n.x + n.w / 2 - n.h / 2, y: n.y + n.h / 2 - n.w / 2, w: n.h, h: n.w } : {}, { rotate: 0 });
}

// A point of the unturned shape, turned into place about the centre.
function turnPoint(n, p) {
  const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
  const dx = p.x - cx, dy = p.y - cy;
  if (n.rotate === 90) return { x: cx - dy, y: cy + dx };
  if (n.rotate === 180) return { x: cx - dx, y: cy - dy };
  if (n.rotate === 270) return { x: cx + dy, y: cy - dx };
  return p;
}

function labelArea(n) {
  if (n.rotate) {
    // The unturned text area, turned, as the box it then covers. The text
    // itself is never turned.
    const a = labelArea(unturned(n));
    const corners = [turnPoint(n, a), turnPoint(n, { x: a.x + a.w, y: a.y + a.h })];
    const x = Math.min(corners[0].x, corners[1].x), y = Math.min(corners[0].y, corners[1].y);
    return { x, y, w: Math.abs(corners[0].x - corners[1].x), h: Math.abs(corners[0].y - corners[1].y) };
  }
  const { x, y, w, h } = n;
  if (n.shape === 'cylinder') { const r = Math.min(12, h / 4); return { x, y: y + r, w, h: h - r }; }
  if (n.shape === 'document') { const a = Math.min(8, h * 0.15); return { x, y, w, h: h - a }; }
  if (n.shape === 'stacked') return { x, y: y + 8, w: w - 8, h: h - 8 };
  if (n.shape === 'queue') { const r = Math.min(12, w / 6); return { x, y, w: w - r * 1.5, h }; }
  if (n.shape === 'buffer') return { x, y: y + h * 0.2, w: w * 0.65, h: h * 0.6 };
  // Sloping or round sides: the text has to stay inside them, not the box.
  if (n.shape === 'diamond') return { x: x + w / 4, y: y + h / 4, w: w / 2, h: h / 2 };
  if (['circle', 'doublecircle'].includes(n.shape)) return { x: x + w * 0.15, y: y + h * 0.15, w: w * 0.7, h: h * 0.7 };
  if (n.shape === 'hexagon') { const i = Math.min(18, w * 0.2); return { x: x + i, y, w: w - 2 * i, h }; }
  if (/^(parallelogram|trapezoid)/.test(n.shape)) { const sl = Math.min(20, w * 0.2); return { x: x + sl, y, w: w - 2 * sl, h }; }
  const bar = Math.min(16, h / 4);
  switch (n.shape) {
    case 'cloud': return { x: x + w * 0.12, y: y + h * 0.28, w: w * 0.76, h: h * 0.56 };
    case 'icon': case 'image': { const top = mediaBox(n).h + 6; return { x: x - 20, y: y + top, w: w + 40, h: Math.max(lineH(n.fontSize) + 4, h - top) }; }
    case 'person': { const r = personHead(n); return { x, y: y + 2 * r + 4, w, h: h - 2 * r - 4 }; }
    case 'browser': case 'console': case 'divided': return { x, y: y + bar, w, h: h - bar };
    case 'storage': return { x: x + 10, y: y + 10, w: w - 10, h: h - 10 };
    case 'lined': case 'lined_doc': { const a = n.shape === 'lined_doc' ? Math.min(8, h * 0.15) : 0; return { x: x + 8, y, w: w - 8, h: h - a }; }
    case 'disk': case 'bucket': { const r = Math.min(12, h / 4); return { x, y: y + r * 2, w, h: h - r * 2 }; }
    case 'folder': return { x, y: y + 8, w, h: h - 8 };
    case 'documents': { const a = Math.min(8, h * 0.15); return { x, y: y + 8, w: w - 8, h: h - 8 - a }; }
    case 'paper_tape': { const a = Math.min(8, h * 0.15); return { x, y: y + a, w, h: h - 2 * a }; }
    case 'tagged_doc': { const a = Math.min(8, h * 0.15); return { x, y, w, h: h - a }; }
    case 'stored': case 'display': { const r = Math.min(14, w / 6); return { x: x + r, y, w: w - 2 * r, h }; }
    case 'loop_limit': case 'card': { const c = Math.min(12, h / 3); return { x, y: y + c / 2, w, h: h - c / 2 }; }
    case 'manual_input': { const sl = Math.min(14, h * 0.3); return { x, y: y + sl, w, h: h - sl }; }
    case 'manual_file': return { x: x + w * 0.2, y, w: w * 0.6, h: h * 0.5 };
    case 'collate': return { x: x + w * 0.15, y, w: w * 0.7, h: h * 0.3 };
    case 'brace': return { x: x + 14, y, w: w - 14, h };
    case 'brace_r': return { x, y, w: w - 14, h };
    case 'braces': return { x: x + 14, y, w: w - 28, h };
  }
  return n;
}

// Grows a node to fit its label. Never shrinks below what the user dragged it
// to -- resizing is theirs to control, this only prevents clipped text.
function fitNodeSize(n) {
  if (LABELLESS.has(n.shape) || n.shape === 'icon' || n.shape === 'image') return;
  const size = n.fontSize || DEFAULT_FONT_SIZE;
  // A few rounds: for a diamond the outline's share of the box grows with the
  // box, so one round of growing still leaves it short.
  for (let round = 0; round < 4; round++) {
    const area = labelArea(n);
    // Extra room the shape's own outline takes out of the box, added back on.
    const slackW = n.w - area.w;
    const slackH = n.h - area.h;
    const lines = wrapLabel(shownLabel(n), Math.max(60, area.w - LABEL_PAD_X * 2), size, n.bold);
    const needW = Math.ceil(Math.max(...lines.map((l) => textWidth(l, size, n.bold)), 0)) + LABEL_PAD_X * 2 + slackW;
    const needH = lines.length * lineH(size) + LABEL_PAD_Y * 2 + slackH;
    if (n.w >= needW && n.h >= needH) break;
    n.w = Math.max(n.w, needW, 60);
    n.h = Math.max(n.h, needH, 36);
  }
}

// A block pasted in as Mermaid has no size of its own: wide enough that its
// text takes about three lines (up to a limit), then tall enough for them.
// The width is for the text: a diamond, whose text only has the middle half,
// gets twice it, so it stays a diamond rather than a tall spike.
function sizeForLabel(n) {
  if (LABELLESS.has(n.shape) || !n.label) return;
  // A blank diamond or circle is a marker (a state diagram's choice): small.
  if (!n.label.trim() && /diamond|circle/.test(n.shape)) { n.w = 40; n.h = 40; return; }
  if (n.shape === 'icon' || n.shape === 'image') return;
  const one = textWidth(shownLabel(n), n.fontSize || DEFAULT_FONT_SIZE, n.bold);
  const textW = Math.min(240, one / 3 + LABEL_PAD_X * 2 + 20);
  n.w = Math.max(n.w, Math.ceil(textW * n.w / labelArea(n).w / 10) * 10);
  fitNodeSize(n);
}

// Line glyphs on a 24-unit grid for the icons LLMs name most, picked by
// keyword from any icon pack's name (`fa:user`, `mdi:account`, `logos:aws`...).
// Mermaid itself needs the pack registered to draw them; the picture can't
// wait for that, so it draws its own.
const GLYPHS = [
  [/user|person|account|people|customer|admin|actor/, 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1'],
  [/server|host|rack|vm\b|instance|compute/, 'M4 3h16v7H4zM4 14h16v7H4zM7.5 6.5h.01M7.5 17.5h.01'],
  [/database|\bdb\b|sql|postgres|mongo|storage|table/, 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3'],
  [/cloud|aws|azure|gcp/, 'M7 19a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 9.5a4.7 4.7 0 0 1 0 9.5z'],
  [/lock|secur|auth|password/, 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4M12 15v2'],
  [/key|token|secret/, 'M8 15a4 4 0 1 1 3.4-6.1L21 9v3h-3v3h-3l-1.6-1.6A4 4 0 0 1 8 15z'],
  [/globe|web|internet|world|earth|dns|cdn/, 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18'],
  [/gear|cog|setting|config/, 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v4M12 18v4M2 12h4M18 12h4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8'],
  [/mobile|phone|android|iphone|ios/, 'M7 2h10v20H7zM11 18h2'],
  [/laptop/, 'M5 5h14v10H5zM2 19h20'],
  [/desktop|monitor|computer|screen|display|browser|chrome|firefox/, 'M3 4h18v12H3zM8 21h8M12 16v5'],
  [/envelope|mail|email|inbox|smtp/, 'M3 5h18v14H3zM3 5l9 8 9-8'],
  [/folder|directory/, 'M3 6h6l2 2h10v11H3z'],
  [/file|doc|pdf|page|report/, 'M6 2h8l4 4v16H6zM14 2v4h4M9 13h6M9 17h6'],
  [/shield|firewall|guard|protect|waf/, 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'],
  [/bell|notif|alert|alarm/, 'M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 21h4'],
  [/chart|analytic|metric|graph|stat|dashboard|monitor/, 'M4 20V11M10 20V5M16 20v-7M2 20h20'],
  [/cart|shop|store|basket|order/, 'M3 4h3l2.5 11h10l2-7H7.2M10 20h.01M17 20h.01'],
  [/credit|card|payment|pay|bill|money|wallet|dollar/, 'M2 6h20v12H2zM2 10h20M6 15h4'],
  [/search|find|magnif|query/, 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16 16l5 5'],
  [/clock|time|schedul|cron|timer/, 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 3'],
  [/code|terminal|console|cli|bash|shell|git/, 'M8 7l-5 5 5 5M16 7l5 5-5 5'],
  [/bolt|lambda|function|serverless|flash|event|trigger/, 'M13 2L4 14h7l-1 8 9-12h-7z'],
  [/network|sitemap|router|switch|load|balanc|gateway|proxy/, 'M10 3h4v4h-4zM3 17h4v4H3zM17 17h4v4h-4zM12 7v5M5 17v-5h14v5'],
  [/plug|api|connect|integrat|webhook/, 'M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5'],
  [/robot|\bai\b|brain|ml\b|model|llm|bot|openai|anthropic/, 'M5 8h14v11H5zM12 4v4M9 13h.01M15 13h.01M9 16h6'],
  [/home|house/, 'M3 11l9-8 9 8M5 9v12h14V9'],
  [/warn|error|danger|exclam|bug/, 'M12 3L2 21h20zM12 10v5M12 18h.01'],
  [/check|success|done|ok\b|tick/, 'M4 12l5 5L20 6'],
  [/message|chat|comment|slack|sms/, 'M4 4h16v12H8l-4 4z'],
  [/queue|list|log|stream|kafka|topic/, 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01'],
  [/box|package|container|docker|kube|k8s|pod|cube/, 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10'],
];
const IMAGE_GLYPH = 'M3 4h18v16H3zM3 16l5-5 4 4 3-3 6 6M15.5 8a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z';

function glyphFor(name) {
  const key = String(name || '').toLowerCase().replace(/^[\w-]+:/, '').replace(/^fa-/, '');
  const hit = GLYPHS.find(([re]) => re.test(key));
  // Unknown: a plain rounded square, rather than a wrong picture.
  return hit ? hit[1] : 'M5 5h14v14H5z';
}

// `"fa:fa-car Car"`: Mermaid's old inline-icon syntax. The code is shown as
// nothing (its icon font isn't there), the text as text.
function shownLabel(n) {
  return String(n.label || '').replace(/\bfa[a-z]?:fa-[\w-]+\s*/g, '').trim();
}

// The icon or picture's own square at the top of an icon / image node; the
// label goes under it, as Mermaid draws them.
function mediaBox(n) {
  const side = Math.max(16, Math.min(n.w, n.h - (n.label ? lineH(n.fontSize) + 6 : 0)));
  return { x: n.x + (n.w - side) / 2, y: n.y, w: side, h: side };
}

function personHead(n) { return Math.min(n.h * 0.17, n.w * 0.25, 14); }

// A cloud's outline as cubic curves, fractions of its box: drawn from these and
// sampled from these, so connectors meet the bumps the reader sees.
const CLOUD = [[0.25, 0.92], [0.02, 0.92, 0.0, 0.5, 0.2, 0.47], [0.13, 0.12, 0.45, 0.02, 0.52, 0.22],
  [0.62, 0.0, 0.92, 0.08, 0.84, 0.38], [1.02, 0.42, 1.03, 0.92, 0.78, 0.92], [0.62, 1.04, 0.4, 1.04, 0.25, 0.92]];

function cloudPoints(n) {
  const P = ([fx, fy]) => ({ x: n.x + fx * n.w, y: n.y + fy * n.h });
  let at = P(CLOUD[0]);
  const pts = [at];
  for (const c of CLOUD.slice(1)) {
    const [p1, p2, p3] = [P(c.slice(0, 2)), P(c.slice(2, 4)), P(c.slice(4, 6))];
    for (let k = 1; k <= 10; k++) {
      const t = k / 10, u = 1 - t;
      pts.push({ x: u * u * u * at.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
                 y: u * u * u * at.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y });
    }
    at = p3;
  }
  return pts;
}

function cloudPath(n) {
  const P = (fx, fy) => `${n.x + fx * n.w} ${n.y + fy * n.h}`;
  return 'M' + P(...CLOUD[0]) + CLOUD.slice(1).map((c) => 'C' + P(c[0], c[1]) + ' ' + P(c[2], c[3]) + ' ' + P(c[4], c[5])).join('') + 'Z';
}

// A document's wavy bottom edge, from the right corner back to the left.
function docBottom(x, y, w, h, a) {
  return `V${y + h - a}C${x + w * 0.75} ${y + h - a * 3} ${x + w * 0.25} ${y + h + a} ${x} ${y + h - a}Z`;
}

// A curly brace down the side at `x`, its point toward `dir` (-1 left, 1 right).
function braceD(x, y, h, dir) {
  const k = 7 * dir;
  const m = y + h / 2;
  return `M${x - k} ${y}Q${x} ${y} ${x} ${y + 8}V${m - 6}Q${x} ${m} ${x + k} ${m}` +
         `Q${x} ${m} ${x} ${m + 6}V${y + h - 8}Q${x} ${y + h} ${x - k} ${y + h}`;
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
    case 'start':
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
    case 'cloud':
      return [el('path', { d: cloudPath(n), class: 'wm-shape' })];
    case 'icon':
    case 'image': {
      const b = mediaBox(n);
      const parts = [];
      // Mermaid's `form`: a square, rounded square or circle behind the icon.
      if (n.shape === 'image' || n.form === 'square') parts.push(el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, class: 'wm-shape' }));
      else if (n.form === 'rounded') parts.push(el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: b.w * 0.18, class: 'wm-shape' }));
      else if (n.form === 'circle') parts.push(el('ellipse', { cx: b.x + b.w / 2, cy: b.y + b.h / 2, rx: b.w / 2, ry: b.h / 2, class: 'wm-shape' }));
      const k = (b.w * (n.form || n.shape === 'image' ? 0.6 : 0.95)) / 24;
      const glyph = el('path', { d: n.shape === 'image' ? IMAGE_GLYPH : glyphFor(n.icon), class: 'wm-shape', 'data-line': '1',
        transform: `translate(${b.x + b.w / 2 - 12 * k} ${b.y + b.h / 2 - 12 * k}) scale(${k})` });
      glyph.style.strokeWidth = 1.6 / k;
      glyph.setAttribute('data-glyph', '1');
      glyph.setAttribute('stroke-linecap', 'round');
      glyph.setAttribute('stroke-linejoin', 'round');
      parts.push(glyph);
      return parts;
    }
    // Punched tape: waved top and bottom.
    case 'paper_tape': {
      const a = Math.min(8, h * 0.15);
      return [el('path', { d: `M${x} ${y + a}C${x + w / 3} ${y - a} ${x + 2 * w / 3} ${y + 3 * a} ${x + w} ${y + a}V${y + h - a}` +
        `C${x + 2 * w / 3} ${y + h - 3 * a} ${x + w / 3} ${y + h + a} ${x} ${y + h - a}Z`, class: 'wm-shape' })];
    }
    // Head and shoulders, the person / actor of every architecture diagram.
    case 'person': {
      const r = personHead(n);
      const top = y + 2 * r + 4;
      return [
        el('ellipse', { cx, cy: y + r, rx: r, ry: r, class: 'wm-shape' }),
        el('rect', { x, y: top, width: w, height: y + h - top, rx: Math.min(14, (y + h - top) / 2), class: 'wm-shape' }),
      ];
    }
    // A window: title bar with three dots.
    case 'browser': {
      const b = Math.min(16, h / 4);
      return [
        el('rect', { x, y, width: w, height: h, rx: 4, class: 'wm-shape' }),
        line(`M${x} ${y + b}H${x + w}`),
      ].concat([0, 1, 2].map((k) => el('ellipse', { cx: x + 8 + k * 7, cy: y + b / 2, rx: 2.2, ry: 2.2, class: 'wm-shape wm-solid' })));
    }
    // A terminal: dark title bar, a prompt.
    case 'console': {
      const b = Math.min(16, h / 4);
      return [
        el('rect', { x, y, width: w, height: h, rx: 4, class: 'wm-shape' }),
        el('path', { d: `M${x} ${y + b}V${y + 4}Q${x} ${y} ${x + 4} ${y}H${x + w - 4}Q${x + w} ${y} ${x + w} ${y + 4}V${y + b}Z`, class: 'wm-shape wm-solid' }),
        line(`M${x + 8} ${y + b + 6}l5 4l-5 4M${x + 16} ${y + b + 15}h7`),
      ];
    }
    // Object storage: a pail, wider at the top.
    case 'bucket': {
      const r = Math.min(12, h / 4);
      const t = w * 0.1;
      return [
        el('path', { d: `M${x} ${y + r}A${w / 2} ${r} 0 0 1 ${x + w} ${y + r}L${x + w - t} ${y + h - r}` +
                        `A${w / 2 - t} ${r} 0 0 1 ${x + t} ${y + h - r}Z`, class: 'wm-shape' }),
        line(`M${x} ${y + r}A${w / 2} ${r} 0 0 0 ${x + w} ${y + r}`),
      ];
    }
    case 'folder':
      return [el('path', { d: `M${x} ${y}H${x + w * 0.35}L${x + w * 0.35 + 8} ${y + 8}H${x + w}V${y + h}H${x}Z`, class: 'wm-shape' })];
    // A data-flow-diagram store: open-ended, a line above and below.
    case 'datastore':
      return [
        el('rect', { x, y, width: w, height: h, class: 'wm-shape wm-bare' }),
        line(`M${x} ${y}H${x + w}M${x} ${y + h}H${x + w}`),
      ];
    case 'disk': {
      const ry = Math.min(12, h / 4);
      return [
        el('path', { d: `M${x} ${y + ry}A${w / 2} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${w / 2} ${ry} 0 0 1 ${x} ${y + h - ry}Z`, class: 'wm-shape' }),
        line(`M${x} ${y + ry}A${w / 2} ${ry} 0 0 0 ${x + w} ${y + ry}M${x} ${y + 2 * ry}A${w / 2} ${ry} 0 0 0 ${x + w} ${y + 2 * ry}`),
      ];
    }
    case 'storage':
      return [el('rect', { x, y, width: w, height: h, class: 'wm-shape' }), line(`M${x + 10} ${y}V${y + h}M${x} ${y + 10}H${x + w}`)];
    case 'stored': {
      const r = Math.min(14, w / 6);
      return [el('path', { d: `M${x + r} ${y}H${x + w}A${r} ${h / 2} 0 0 0 ${x + w} ${y + h}H${x + r}A${r} ${h / 2} 0 0 1 ${x + r} ${y}Z`, class: 'wm-shape' })];
    }
    case 'documents': {
      const a = Math.min(8, h * 0.15);
      const page = (ox, oy) => el('path', { d: `M${x + ox} ${y + oy}H${x + ox + w - 8}` + docBottom(x + ox, y + oy, w - 8, h - 8, a), class: 'wm-shape' });
      return [page(8, 0), page(4, 4), page(0, 8)];
    }
    case 'lined_doc': {
      const a = Math.min(8, h * 0.15);
      return [el('path', { d: `M${x} ${y}H${x + w}` + docBottom(x, y, w, h, a), class: 'wm-shape' }), line(`M${x + 8} ${y}V${y + h - a * 1.3}`)];
    }
    case 'tagged_doc': {
      const a = Math.min(8, h * 0.15);
      return [el('path', { d: `M${x} ${y}H${x + w}` + docBottom(x, y, w, h, a), class: 'wm-shape' }),
        line(`M${x + w} ${y + h * 0.55}L${x + w * 0.8} ${y + h - a * 1.6}`)];
    }
    case 'card': {
      const c = Math.min(12, h / 3);
      return [el('polygon', { points: `${x + c},${y} ${x + w},${y} ${x + w},${y + h} ${x},${y + h} ${x},${y + c}`, class: 'wm-shape' })];
    }
    case 'tagged': {
      const c = Math.min(12, h / 3);
      return [el('rect', { x, y, width: w, height: h, class: 'wm-shape' }), line(`M${x + w - c} ${y + h}L${x + w} ${y + h - c}`)];
    }
    case 'divided':
      return [el('rect', { x, y, width: w, height: h, class: 'wm-shape' }), line(`M${x} ${y + Math.min(16, h / 4)}H${x + w}`)];
    case 'lined':
      return [el('rect', { x, y, width: w, height: h, class: 'wm-shape' }), line(`M${x + 8} ${y}V${y + h}`)];
    case 'display': {
      const r = Math.min(14, w / 6);
      return [el('path', { d: `M${x + r} ${y}H${x + w - r}A${r} ${h / 2} 0 0 1 ${x + w - r} ${y + h}H${x + r}L${x} ${cy}Z`, class: 'wm-shape' })];
    }
    case 'loop_limit': {
      const c = Math.min(12, h / 3);
      return [el('polygon', { points: `${x + c},${y} ${x + w - c},${y} ${x + w},${y + c} ${x + w},${y + h} ${x},${y + h} ${x},${y + c}`, class: 'wm-shape' })];
    }
    case 'collate':
      return [el('polygon', { points: `${x},${y} ${x + w},${y} ${cx},${cy}`, class: 'wm-shape' }),
        el('polygon', { points: `${cx},${cy} ${x + w},${y + h} ${x},${y + h}`, class: 'wm-shape' })];
    case 'manual_file':
      return [el('polygon', { points: `${x},${y} ${x + w},${y} ${cx},${y + h}`, class: 'wm-shape' })];
    case 'manual_input': {
      const sl = Math.min(14, h * 0.3);
      return [el('polygon', { points: `${x},${y + sl} ${x + w},${y} ${x + w},${y + h} ${x},${y + h}`, class: 'wm-shape' })];
    }
    case 'stop':
      return [el('ellipse', { cx, cy, rx: w / 2, ry: h / 2, class: 'wm-shape' }),
        el('ellipse', { cx, cy, rx: w * 0.3, ry: h * 0.3, class: 'wm-shape wm-solid' })];
    // A note: text with a curly brace beside it, no box.
    case 'brace':
      return [line(braceD(x + 7, y, h, -1))];
    case 'brace_r':
      return [line(braceD(x + w - 7, y, h, 1))];
    case 'braces':
      return [line(braceD(x + 7, y, h, -1) + braceD(x + w - 7, y, h, 1))];
    // A communication link: a lightning bolt.
    case 'bolt':
      return [el('polygon', { points: `${x + w * 0.62},${y} ${x + w * 0.12},${y + h * 0.58} ${x + w * 0.47},${y + h * 0.55} ` +
        `${x + w * 0.3},${y + h} ${x + w * 0.9},${y + h * 0.38} ${x + w * 0.53},${y + h * 0.42}`, class: 'wm-shape wm-solid' })];
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
  const solid = /wm-solid/;
  // A turned shape: drawn unturned, in a group turned about the centre.
  let shapeParent = g;
  if (n.rotate) shapeParent = el('g', { transform: `rotate(${n.rotate} ${n.x + n.w / 2} ${n.y + n.h / 2})` }, g);
  for (const shape of shapeElement(n.rotate ? unturned(n) : n)) {
    if (shape.getAttribute('data-line')) shape.style.fill = 'none';
    else if (n.fill && n.fill !== '#ffffff' && !solid.test(shape.getAttribute('class'))) shape.style.fill = n.fill;
    // Border colour, width and dashes from the Mermaid style, where it set them.
    // A border's width and dashes are for the outline, not an icon's glyph.
    if (!/wm-bare/.test(shape.getAttribute('class')) && !shape.getAttribute('data-glyph')) {
      if (n.stroke) shape.style.stroke = n.stroke;
      if (n.strokeWidth) shape.style.strokeWidth = n.strokeWidth;
      if (n.dash) shape.style.strokeDasharray = '5 4';
    }
    if (n.stroke && solid.test(shape.getAttribute('class'))) shape.style.fill = n.stroke;
    shapeParent.appendChild(shape);
  }
  if (LABELLESS.has(n.shape)) return g;
  const size = n.fontSize || DEFAULT_FONT_SIZE;
  const area = labelArea(n);
  const lines = wrapLabel(shownLabel(n), area.w - LABEL_PAD_X * 2, size, n.bold);
  // Left or right aligned text runs from that side of the text area.
  const x = n.align === 'left' ? area.x + LABEL_PAD_X : n.align === 'right' ? area.x + area.w - LABEL_PAD_X : area.x + area.w / 2;
  const text = labelText(g, lines, x, area.y + area.h / 2, size, n.bold, 'wm-label', DEFAULT_FONT_SIZE);
  // Inline style, not an attribute: the class rule would win over an attribute.
  if (n.align) text.style.textAnchor = n.align === 'left' ? 'start' : 'end';
  if (n.color) text.style.fill = n.color;
  if (n.italic) text.style.fontStyle = 'italic';
  if (n.underline) text.style.textDecoration = 'underline';
  return g;
}

// The title sits in a filled tab rather than as loose grey text: a group you
// can't see is a group you think didn't happen.
function drawGroup(parent, g) {
  const node = el('g', { 'data-id': g.id, 'data-kind': 'group' }, parent);
  const box = el('rect', { x: g.x, y: g.y, width: g.w, height: g.h, rx: 8, class: 'wm-group' }, node);
  const size = g.fontSize || GROUP_FONT_SIZE;
  const tab = el('rect', { x: g.x, y: g.y, width: groupTabWidth(g), height: groupTitleH(g), rx: 6, class: 'wm-group-tab' }, node);
  const title = el('text', { x: g.x + size * 0.8, y: g.y + groupTitleH(g) / 2, class: 'wm-group-title' }, node);
  if (size !== GROUP_FONT_SIZE) title.style.fontSize = size + 'px';
  // A subgraph's own colours: its fill, and its border carried into the tab.
  if (g.fill) box.style.fill = g.fill;
  if (g.stroke) { box.style.stroke = g.stroke; tab.style.fill = g.stroke; }
  if (g.strokeWidth) box.style.strokeWidth = g.strokeWidth;
  if (g.color) title.style.fill = g.color;
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

// A shape's visible outline as a closed polygon, curves sampled finely enough
// that a connector ending on it looks like it touches. Connector ends sit on
// this, not on the bounding box: an arrow that stops in the air beside a mux's
// slanted side, or a cylinder's curved top, looks like it missed.
function outlineOf(n) {
  if (n.rotate) return outlineOf(unturned(n)).map((p) => turnPoint(n, p));
  const { x, y, w, h } = n;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const slant = Math.min(20, w * 0.2);
  const arc = (ax, ay, rx, ry, from, to, steps = 12) => Array.from({ length: steps + 1 }, (_, k) => {
    const a = from + (to - from) * k / steps;
    return { x: ax + rx * Math.cos(a), y: ay + ry * Math.sin(a) };
  });
  const P = Math.PI;
  switch (n.shape) {
    case 'circle': case 'doublecircle': case 'junction': case 'start': case 'sum':
      return arc(cx, cy, w / 2, h / 2, 0, 2 * P, 48);
    case 'diamond': return [{ x: cx, y }, { x: x + w, y: cy }, { x: cx, y: y + h }, { x, y: cy }];
    case 'hexagon': {
      const i = Math.min(18, w * 0.2);
      return [{ x: x + i, y }, { x: x + w - i, y }, { x: x + w, y: cy }, { x: x + w - i, y: y + h }, { x: x + i, y: y + h }, { x, y: cy }];
    }
    case 'parallelogram': return [{ x: x + slant, y }, { x: x + w, y }, { x: x + w - slant, y: y + h }, { x, y: y + h }];
    case 'parallelogram_alt': return [{ x, y }, { x: x + w - slant, y }, { x: x + w, y: y + h }, { x: x + slant, y: y + h }];
    case 'trapezoid': return [{ x: x + slant, y }, { x: x + w - slant, y }, { x: x + w, y: y + h }, { x, y: y + h }];
    case 'trapezoid_alt': return [{ x, y }, { x: x + w, y }, { x: x + w - slant, y: y + h }, { x: x + slant, y: y + h }];
    case 'buffer': return [{ x, y }, { x: x + w, y: cy }, { x, y: y + h }];
    case 'stadium': {
      const r = Math.min(h / 2, w / 2);
      return arc(x + w - r, cy, r, h / 2, -P / 2, P / 2).concat(arc(x + r, cy, r, h / 2, P / 2, 3 * P / 2));
    }
    case 'queue': {
      const r = Math.min(12, w / 6);
      return arc(x + w - r, cy, r, h / 2, -P / 2, P / 2).concat(arc(x + r, cy, r, h / 2, P / 2, 3 * P / 2));
    }
    case 'delay': {
      const r = Math.min(h / 2, w / 2);
      return [{ x, y }].concat(arc(x + w - r, cy, r, h / 2, -P / 2, P / 2), [{ x, y: y + h }]);
    }
    case 'cylinder': {
      const ry = Math.min(12, h / 4);
      return arc(cx, y + ry, w / 2, ry, P, 2 * P).concat(arc(cx, y + h - ry, w / 2, ry, 0, P));
    }
    case 'cloud': return cloudPoints(n);
    case 'icon': case 'image': {
      const b = mediaBox(n);
      return [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: n.y + n.h }, { x: b.x, y: n.y + n.h }];
    }
    case 'stop': return arc(cx, cy, w / 2, h / 2, 0, 2 * P, 48);
    case 'person': {
      const r = personHead(n);
      return [{ x, y: y + 2 * r + 4 }].concat(arc(cx, y + r, r, r, P, 2 * P), [{ x: x + w, y: y + 2 * r + 4 }, { x: x + w, y: y + h }, { x, y: y + h }]);
    }
    case 'bucket': {
      const r = Math.min(12, h / 4);
      const t = w * 0.1;
      return arc(cx, y + r, w / 2, r, P, 2 * P).concat(arc(cx, y + h - r, w / 2 - t, r, 0, P));
    }
    case 'disk': {
      const ry = Math.min(12, h / 4);
      return arc(cx, y + ry, w / 2, ry, P, 2 * P).concat(arc(cx, y + h - ry, w / 2, ry, 0, P));
    }
    case 'folder': return [{ x, y }, { x: x + w * 0.35, y }, { x: x + w * 0.35 + 8, y: y + 8 }, { x: x + w, y: y + 8 }, { x: x + w, y: y + h }, { x, y: y + h }];
    case 'stored': {
      const r = Math.min(14, w / 6);
      return [{ x: x + r, y }].concat(arc(x + w, cy, r, h / 2, 3 * P / 2, P / 2), arc(x + r, cy, r, h / 2, P / 2, 3 * P / 2));
    }
    case 'display': {
      const r = Math.min(14, w / 6);
      return [{ x: x + r, y }].concat(arc(x + w - r, cy, r, h / 2, -P / 2, P / 2), [{ x: x + r, y: y + h }, { x, y: cy }]);
    }
    case 'card': { const c = Math.min(12, h / 3); return [{ x: x + c, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y: y + c }]; }
    case 'loop_limit': {
      const c = Math.min(12, h / 3);
      return [{ x: x + c, y }, { x: x + w - c, y }, { x: x + w, y: y + c }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y: y + c }];
    }
    case 'collate': return [{ x, y }, { x: x + w, y }, { x: cx, y: cy }, { x: x + w, y: y + h }, { x, y: y + h }, { x: cx, y: cy }];
    case 'manual_file': return [{ x, y }, { x: x + w, y }, { x: cx, y: y + h }];
    case 'manual_input': { const sl = Math.min(14, h * 0.3); return [{ x, y: y + sl }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]; }
    case 'flag':
      return [{ x: x + w, y }, { x: x + w, y: y + h }].concat(Array.from({ length: 13 }, (_, k) => {
        const t = 1 - k / 12;
        return { x: x + 2 * (1 - t) * t * slant, y: y + h * t };
      }));
    default: return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  }
}

// Where the ray from `from` in direction `dir` first meets `n`'s outline, or
// null if it doesn't.
function rayToOutline(n, from, dir) {
  const pts = outlineOf(n);
  let best = null;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const ex = q.x - p.x;
    const ey = q.y - p.y;
    const den = dir.x * ey - dir.y * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((p.x - from.x) * ey - (p.y - from.y) * ex) / den;
    const u = ((p.x - from.x) * dir.y - (p.y - from.y) * dir.x) / den;
    if (t >= 0 && u >= -1e-6 && u <= 1 + 1e-6 && (best === null || t < best)) best = t;
  }
  return best === null ? null : { x: from.x + dir.x * best, y: from.y + dir.y * best };
}

// Which side a connector leaves `a` by for `b`: the side facing it. A
// decision's branch to a block off to one side leaves from that side's corner,
// the flowchart convention, rather than off a sloping edge with a jog in it.
function exitSide(a, b) {
  const side = facingSide(a, b);
  if (a.shape !== 'diamond') return side;
  // Straight ahead means within the middle third; anything further out goes
  // from the corner on its side.
  const c = centerOf(b);
  const m = centerOf(a);
  if ((side === 'n' || side === 's') && Math.abs(c.x - m.x) > a.w / 6) return c.x > m.x ? 'e' : 'w';
  if ((side === 'e' || side === 'w') && Math.abs(c.y - m.y) > a.h / 6) return c.y > m.y ? 's' : 'n';
  return side;
}

// Where the line from a node's centre towards `toward` leaves its outline.
function outlinePoint(n, toward) {
  const c = centerOf(n);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (!dx && !dy) return c;
  // Cast inwards from beyond the box, so the hit is the outline's outer edge.
  const far = Math.hypot(n.w, n.h) / Math.hypot(dx, dy);
  const from = { x: c.x + dx * far, y: c.y + dy * far };
  return rayToOutline(n, from, { x: -dx, y: -dy }) || c;
}

// `t` runs 0..1 along the side, left-to-right or top-to-bottom. The point is
// on the shape's real outline: the spot on the bounding box is pushed straight
// in until it meets the shape, so a line attached anywhere along a slanted,
// curved or pointed side still touches it.
function anchorPoint(n, side, t) {
  const x = side === 'n' || side === 's' ? n.x + n.w * t : side === 'w' ? n.x : n.x + n.w;
  const y = side === 'e' || side === 'w' ? n.y + n.h * t : side === 'n' ? n.y : n.y + n.h;
  if (!n.w || !n.h || !n.shape) return { x, y };
  const dir = DIRS[side];
  return rayToOutline(n, { x: x + dir.x, y: y + dir.y }, { x: -dir.x, y: -dir.y }) || { x, y };
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

// How far a leg runs alongside a block within HUG of its edge without
// entering it: a line skimming a box's side reads as part of its outline.
const HUG = 10;
function hugLength(u, v, r) {
  if (!r.w || !r.h) return 0;
  const lx = Math.min(u.x, v.x), hx = Math.max(u.x, v.x), ly = Math.min(u.y, v.y), hy = Math.max(u.y, v.y);
  if (hx <= r.x - HUG + 1 || lx >= r.x + r.w + HUG - 1 || hy <= r.y - HUG + 1 || ly >= r.y + r.h + HUG - 1) return 0;
  if (crossesBox(u, v, r)) return 0;
  return hy - ly < 0.5
    ? Math.max(0, Math.min(hx, r.x + r.w + HUG) - Math.max(lx, r.x - HUG))
    : Math.max(0, Math.min(hy, r.y + r.h + HUG) - Math.max(ly, r.y - HUG));
}

// Running through another block is allowed -- something has to be drawn when
// there's no way round -- but costs more than any detour or shared stretch,
// so any route clear of blocks wins.
const THROUGH_BLOCK = 20000;
// Running along a connector already drawn, closer than this, reads as one
// line: it costs as if that stretch were three times as long.
const SHARED_LANE = 6;

// How much of an axis-aligned segment runs on top of (within SHARED_LANE of)
// one of `lanes`, the segments of connectors routed before it.
function sharedLength(u, v, lanes) {
  let total = 0;
  const horiz = Math.abs(u.y - v.y) < 0.5;
  for (const [p, q] of lanes) {
    if (horiz !== (Math.abs(p.y - q.y) < 0.5)) continue;
    const [a, b, c, e] = horiz ? [u.x, v.x, p.x, q.x] : [u.y, v.y, p.y, q.y];
    if (Math.abs(horiz ? u.y - p.y : u.x - p.x) > SHARED_LANE) continue;
    total += Math.max(0, Math.min(Math.max(a, b), Math.max(c, e)) - Math.max(Math.min(a, b), Math.min(c, e)));
  }
  return total;
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
    if (i > 1 && i < pts.length - 1) len += (hugLength(u, v, A) + hugLength(u, v, B)) * 4;
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

// What else a route costs: every other block it runs through, and every
// stretch it runs along a connector already drawn.
function clutterCost(pts, obstacles, lanes) {
  let cost = 0;
  for (let i = 1; i < pts.length; i++) {
    const u = pts[i - 1], v = pts[i];
    const lx = Math.min(u.x, v.x), hx = Math.max(u.x, v.x), ly = Math.min(u.y, v.y), hy = Math.max(u.y, v.y);
    for (const r of obstacles) {
      // Clear of the block and its margin: by far the usual case, so first.
      if (hx <= r.x - HUG + 1 || lx >= r.x + r.w + HUG - 1 || hy <= r.y - HUG + 1 || ly >= r.y + r.h + HUG - 1) continue;
      cost += crossesBox(u, v, r) ? THROUGH_BLOCK : hugLength(u, v, r) * 4;
    }
    cost += sharedLength(pts[i - 1], pts[i], lanes) * 2;
  }
  return cost;
}

// The bends of an automatically routed right-angle connector, between its two
// stub ends. Rather than one fixed shape, it tries every plausible one -- a
// straight run, a single corner, a Z through the middle or round the outside
// of both blocks, a U -- and keeps the cheapest acceptable route (see
// routeCost). That is what stops a connector from cutting through its own
// blocks or doubling back when the ends face away from each other. The
// middle-channel Z is tried first, so on a tie it wins: it's the balanced one.
function routeBends(p0, s0, a0, A, p1, s1, b0, B, blocks, lanes) {
  const M = STUB;
  const midX = (a0.x + b0.x) / 2;
  const midY = (a0.y + b0.y) / 2;
  // Neighbouring lanes each side of the middle, for when another connector
  // already runs there.
  const xs = [Math.min(A.x, B.x) - M, Math.max(A.x + A.w, B.x + B.w) + M, a0.x, b0.x, midX - 12, midX + 12];
  const ys = [Math.min(A.y, B.y) - M, Math.max(A.y + A.h, B.y + B.h) + M, a0.y, b0.y, midY - 12, midY + 12];
  // Only what's near the two blocks can be in the way: the rest is left out,
  // which is what keeps this fast enough to run on every pointer move.
  const x0 = Math.min(A.x, B.x) - 120, x1 = Math.max(A.x + A.w, B.x + B.w) + 120;
  const y0 = Math.min(A.y, B.y) - 120, y1 = Math.max(A.y + A.h, B.y + B.h) + 120;
  const near = (r) => r.x <= x1 && r.x + r.w >= x0 && r.y <= y1 && r.y + r.h >= y0;
  const obstacles = blocks.filter((n) => n !== A && n !== B && near(n));
  const nearLanes = lanes.filter(([p, q]) => near({ x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(p.x - q.x), h: Math.abs(p.y - q.y) }));

  const pick = () => {
    // The same lane offered twice (two blocks lined up) is the same routes twice.
    const uniq = (vs) => [...new Set(vs.map((v) => Math.round(v)))];
    const xs_ = uniq(xs);
    const ys_ = uniq(ys);
    const cands = [
      [{ x: midX, y: a0.y }, { x: midX, y: b0.y }],
      [{ x: a0.x, y: midY }, { x: b0.x, y: midY }],
      [],
      [{ x: b0.x, y: a0.y }],
      [{ x: a0.x, y: b0.y }],
    ];
    for (const x of xs_) cands.push([{ x, y: a0.y }, { x, y: b0.y }]);
    for (const y of ys_) cands.push([{ x: a0.x, y }, { x: b0.x, y }]);
    for (const x of uniq(xs_.concat(midX))) {
      for (const y of uniq(ys_.concat(midY))) {
        cands.push([{ x, y: a0.y }, { x, y }, { x: b0.x, y }]);
        cands.push([{ x: a0.x, y }, { x, y }, { x, y: b0.y }]);
      }
    }
    // Cheapest shape first; clutter only ever adds, so once a shape's own cost
    // is past the best total found, nothing after it can win.
    const scored = [];
    for (const c of cands) {
      const pts = simplify([p0, a0].concat(c, [b0, p1]));
      const cost = routeCost(pts, s0, A, s1, B);
      if (cost != null) scored.push({ cost, c, pts });
    }
    scored.sort((p, q) => p.cost - q.cost);
    let best = null;
    for (const r of scored) {
      if (best && r.cost >= best.cost) break;
      const cost = r.cost + clutterCost(r.pts, obstacles, nearLanes);
      if (!best || cost < best.cost) best = { cost, c: r.c, clutter: cost - r.cost };
    }
    return best;
  };
  // A route through a block gets the gaps beside that block to try, and so on
  // for whatever the detour runs into -- a few rounds, not every block at once.
  // If the way round one block runs into two more, the route stays put, so
  // then the gaps of the nearest few other blocks go in: the clear lane is
  // usually just past them.
  const tried = new Set();
  let best = pick();
  for (let round = 0; best && best.clutter >= THROUGH_BLOCK && round < 4; round++) {
    const pts = simplify([p0, a0].concat(best.c, [b0, p1]));
    let hit = obstacles.filter((r) => !tried.has(r) && pts.some((u, i) => i && crossesBox(pts[i - 1], u, r)));
    if (!hit.length) {
      const dist = (r) => Math.hypot(r.x + r.w / 2 - midX, r.y + r.h / 2 - midY);
      hit = obstacles.filter((r) => !tried.has(r)).sort((p, q) => dist(p) - dist(q)).slice(0, 8);
    }
    if (!hit.length) break;
    for (const r of hit) { tried.add(r); xs.push(r.x - M, r.x + r.w + M); ys.push(r.y - M, r.y + r.h + M); }
    best = pick();
  }
  // Nothing acceptable (the blocks overlap, say): a single corner is the least
  // bad thing to draw.
  return best ? best.c : [{ x: b0.x, y: a0.y }];
}

// What the best right-angle route between these two sides would cost, for
// choosing sides; Infinity if there's none.
function sideCost(A, sa, B, sb, blocks) {
  const p0 = anchorPoint(A, sa, 0.5);
  const p1 = anchorPoint(B, sb, 0.5);
  const a0 = stubOf(A, p0, sa);
  const b0 = stubOf(B, p1, sb);
  const pts = simplify(joinOrthogonal([p0, a0].concat(routeBends(p0, sa, a0, A, p1, sb, b0, B, blocks, []), [b0, p1])));
  const cost = routeCost(pts, sa, A, sb, B);
  return cost == null ? Infinity : cost + clutterCost(pts, blocks.filter((n) => n !== A && n !== B), []);
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

function selfLoopPoints(n, direction) {
  // Off the top when the flow runs sideways: the right side is where the next step's connector leaves.
  if (direction === 'LR' || direction === 'RL') {
    const x = n.x + n.w - 20;
    return [{ x: x - 24, y: n.y }, { x: x - 24, y: n.y - 26 }, { x, y: n.y - 26 }, { x, y: n.y }];
  }
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
  // What a connector must go round: drawn blocks, not loose line ends. And the
  // legs of the connectors routed so far, which the next one keeps off.
  const blocks = d.nodes.filter((n) => !isPoint(n) && n.w && n.h);
  const lanes = [];
  // A group's dashed border is a line too: a connector running along it is lost in it.
  for (const g of d.groups) {
    if (!g.w) continue;
    const c = [{ x: g.x, y: g.y }, { x: g.x + g.w, y: g.y }, { x: g.x + g.w, y: g.y + g.h }, { x: g.x, y: g.y + g.h }];
    for (let k = 0; k < 4; k++) lanes.push([c[k], c[(k + 1) % 4]]);
  }
  const slots = d.edges.map((e) => {
    const a = endOf(d, e.from);
    const b = endOf(d, e.to);
    if (!a || !b) return null;
    if (a === b) return { a, self: true };
    // A straight connector runs between the exact points its ends were
    // attached at, or, for an end left floating, towards the other end and cut
    // off at the outline. It joins no fan-out, so it skips everything below.
    if (e.route === 'straight') return { a, b, straight: true, fa: e.fromAnchor, ta: e.toAnchor };
    const fa = e.fromAnchor || {};
    const ta = e.toAnchor || {};
    let fromSide = fa.side || exitSide(a, b);
    let toSide = ta.side || facingSide(b, a);
    // Diagonal neighbours (apart on both axes) could be joined from either of
    // two sides at each end; the facing one isn't always the clean one -- it
    // can send the line across a group border or another connector's path.
    // Each pairing is tried and the cheapest route's sides kept.
    // And when the facing sides' best route still runs through a block (the
    // target straight below, past a block in between), every pairing is tried:
    // out of a side and down the clear lane beside everything beats through.
    const apart = (p, q, pos, len) => p[pos] + p[len] <= q[pos] || q[pos] + q[len] <= p[pos];
    if (!fa.side && !ta.side) {
      const ca = centerOf(a);
      const cb = centerOf(b);
      const h = (from, to) => (to.x > from.x ? 'e' : 'w');
      const v = (from, to) => (to.y > from.y ? 's' : 'n');
      let pairings = null;
      if (a.shape !== 'diamond' && apart(a, b, 'x', 'w') && apart(a, b, 'y', 'h')) {
        pairings = [[fromSide, toSide], [h(ca, cb), v(cb, ca)], [v(ca, cb), h(cb, ca)], [h(ca, cb), h(cb, ca)], [v(ca, cb), v(cb, ca)]];
      } else if (sideCost(a, fromSide, b, toSide, blocks) >= THROUGH_BLOCK) {
        pairings = [[fromSide, toSide]];
        for (const sa of 'nesw') for (const sb of 'nesw') pairings.push([sa, sb]);
      }
      let best = Infinity;
      for (const [sa, sb] of pairings || []) {
        const cost = sideCost(a, sa, b, sb, blocks);
        if (cost < best - 1) { best = cost; fromSide = sa; toSide = sb; }
      }
    }
    return {
      a, b,
      from: { side: fromSide, t: fa.t, other: b, pinned: fa.t != null },
      to: { side: toSide, t: ta.t, other: a, pinned: ta.t != null },
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
  // Likewise when only one end is alone on its side: it lines up with the
  // other end's spot (in a fan, or attached by hand), so the connector comes
  // out dead straight rather than with a small jog in it.
  for (const s of slots) {
    if (!s || s.self || s.straight) continue;
    // An L: out of one side, turning once into the top or side of the other.
    // An end alone on its side lands right under (or beside) the turn, so the
    // connector bends once instead of jogging on its way in.
    const vertical = (side) => side === 'n' || side === 's';
    if (vertical(s.from.side) !== vertical(s.to.side)) {
      for (const [end, far, n, other] of [[s.to, s.from, s.b, s.a], [s.from, s.to, s.a, s.b]]) {
        if (!end.solo || end.pinned) continue;
        const turn = stubOf(other, anchorPoint(other, far.side, far.t), far.side);
        const [pos, len] = vertical(end.side) ? ['x', 'w'] : ['y', 'h'];
        if (n[len] && turn[pos] >= n[pos] + 8 && turn[pos] <= n[pos] + n[len] - 8) { end.t = (turn[pos] - n[pos]) / n[len]; break; }
      }
      continue;
    }
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
    } else if (s.from.solo) {
      // Alone on its side, this end can go wherever the other end is -- a spot
      // in a fan, or one attached by hand -- and make the connector straight.
      const c = anchorPoint(s.b, s.to.side, s.to.t)[pos];
      if (within(s.a, c)) s.from.t = (c - s.a[pos]) / s.a[len];
    } else if (s.to.solo) {
      const c = anchorPoint(s.a, s.from.side, s.from.t)[pos];
      if (within(s.b, c)) s.to.t = (c - s.b[pos]) / s.b[len];
    }
  }

  return slots.map((s, i) => {
    if (!s) return null;
    if (s.self) return { self: true, raw: selfLoopPoints(s.a, d.direction) };
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
      ? d.edges[i].points : routeBends(p0, s.from.side, a0, s.a, p1, s.to.side, b0, s.b, blocks, lanes);
    const raw = joinOrthogonal([p0, a0].concat(bends, [b0, p1]));
    for (let k = 1; k < raw.length; k++) lanes.push([raw[k - 1], raw[k]]);
    return {
      raw,
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

// Where an edge's label box sits, with its lines. Shared by drawing, the export
// bounds and the editor, so the label is never cropped or mis-hit.
// The point `t` (0 to 1) of the way along a path, and the leg it's on.
function pointAlong(pts, t) {
  const lens = pts.slice(1).map((q, i) => Math.hypot(q.x - pts[i].x, q.y - pts[i].y));
  let left = Math.max(0, Math.min(1, t)) * lens.reduce((a, b) => a + b, 0);
  for (let i = 0; i < lens.length; i++) {
    if (left <= lens[i] || i === lens.length - 1) {
      const k = lens[i] ? Math.min(1, left / lens[i]) : 0;
      return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * k, y: pts[i].y + (pts[i + 1].y - pts[i].y) * k, leg: i };
    }
    left -= lens[i];
  }
  return { x: pts[0].x, y: pts[0].y, leg: 0 };
}

// How far along a path (0 to 1) its nearest point to `p` is.
function fractionAlong(pts, p) {
  let total = 0, best = Infinity, at = 0;
  const lens = pts.slice(1).map((q, i) => Math.hypot(q.x - pts[i].x, q.y - pts[i].y));
  const sum = lens.reduce((a, b) => a + b, 0) || 1;
  for (let i = 0; i < lens.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const k = lens[i] ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (lens[i] * lens[i]))) : 0;
    const dist = Math.hypot(a.x + (b.x - a.x) * k - p.x, a.y + (b.y - a.y) * k - p.y);
    if (dist < best) { best = dist; at = (total + k * lens[i]) / sum; }
    total += lens[i];
  }
  return at;
}

function labelBoxAt(e, pts, t) {
  const size = e.fontSize || DEFAULT_EDGE_FONT;
  const lines = String(e.label).split('\n');
  const mid = pointAlong(pts, t);
  const w = Math.max(...lines.map((l) => textWidth(l, size, e.bold))) + 10;
  const h = lines.length * lineH(size) + 4;
  return { x: mid.x - w / 2, y: mid.y - h / 2, w, h, mid, lines, size, t };
}

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// Where each connector's text goes. One moved by hand stays where it was put
// (`labelAt`, a fraction along the connector). The rest are placed in turn:
// near the middle of their connector, but off blocks, off other connectors
// and off text already placed -- a label sitting on a crossing reads as
// belonging to either line.
function labelBoxes(d, geom) {
  geom = geom || edgeGeometry(d);
  const blocks = d.nodes.filter((n) => !isPoint(n) && n.w && n.h);
  const placed = [];
  return d.edges.map((e, i) => {
    const pts = geom[i];
    if (!e.label || !pts || pts.length < 2) return null;
    let best;
    if (e.labelAt != null) best = labelBoxAt(e, pts, e.labelAt);
    else if (e.from === e.to) {
      // A loop's text goes just outside its far leg, not on it: on it, it hides the loop.
      best = labelBoxAt(e, pts, 0.5);
      const up = Math.abs(pts[1].y - pts[2].y) < 0.5;
      const dx = up ? 0 : best.w / 2 + 3, dy = up ? -(best.h / 2 + 3) : 0;
      best = { ...best, x: best.x + dx, y: best.y + dy, mid: { x: best.mid.x + dx, y: best.mid.y + dy } };
    }
    else {
      const lens = pts.slice(1).map((q, k) => Math.hypot(q.x - pts[k].x, q.y - pts[k].y));
      const sum = lens.reduce((a, b) => a + b, 0) || 1;
      const cands = [0.5];
      let at = 0;
      lens.forEach((len) => { for (const f of [0.5, 0.3, 0.7, 0.15, 0.85]) cands.push((at + len * f) / sum); at += len; });
      let bestCost = Infinity;
      // Each spot on the line, and beside it: a label beside a vertical line
      // leaves its neighbour (the way back of a pair) and its arrowhead clear.
      const spots = [];
      for (const t of cands) {
        const on = labelBoxAt(e, pts, t);
        spots.push([on, 0]);
        const leg = pointAlong(pts, t).leg;
        const vertical = Math.abs(pts[leg].x - pts[leg + 1].x) < 0.5;
        for (const sgn of [-1, 1]) {
          const dx = vertical ? sgn * (on.w / 2 + 4) : 0, dy = vertical ? 0 : sgn * (on.h / 2 + 3);
          spots.push([{ ...on, x: on.x + dx, y: on.y + dy, mid: { x: on.mid.x + dx, y: on.mid.y + dy } }, 40]);
        }
      }
      const tip = pts[pts.length - 1];
      for (const [box, extra] of spots) {
        const t = box.t;
        const pad = { x: box.x - 2, y: box.y - 2, w: box.w + 4, h: box.h + 4 };
        // Off the middle costs a little; sticking out past a bend more.
        let cost = Math.abs(t - 0.5) * 60 + extra;
        // Over the arrowhead hides which way the connector points.
        if (overlaps(pad, { x: tip.x - 10, y: tip.y - 10, w: 20, h: 20 })) cost += 300;
        // Room each side of its centre on its own leg: none and it hides a bend.
        const leg = pointAlong(pts, t).leg;
        const along = Math.abs(pts[leg].y - pts[leg + 1].y) < 0.5 ? box.w : box.h;
        const room = Math.min(Math.hypot(box.mid.x - pts[leg].x, box.mid.y - pts[leg].y),
          Math.hypot(box.mid.x - pts[leg + 1].x, box.mid.y - pts[leg + 1].y));
        if (room < along / 2 + 6) cost += 150;
        for (const n of blocks) if (overlaps(pad, n)) cost += 1000;
        for (const q of placed) if (overlaps(pad, q)) cost += 1000;
        geom.forEach((other, j) => {
          if (j === i || !other) return;
          for (let k = 1; k < other.length; k++) if (crossesBox(other[k - 1], other[k], pad)) { cost += 200; break; }
        });
        if (cost < bestCost) { bestCost = cost; best = box; }
      }
    }
    placed.push(best);
    return best;
  });
}

function drawEdge(parent, e, pts, index, box, pinLayer) {
  const g = el('g', { 'data-index': index, 'data-kind': 'edge' }, parent);
  // Two blocks dropped exactly on top of each other collapse the route to a
  // single point; there is nothing to draw and an arrowhead needs two.
  if (pts.length < 2) return g;
  const w = e.width || DEFAULT_EDGE_W;
  const { len, half } = arrowSize(e);
  const endHead = e.head === 'end' || e.head === 'both';
  const startHead = e.head === 'both';

  // A circle end is an open ring the line stops at; a cross sits on the line.
  const trim = e.mark === 'circle' ? half * 2 : e.mark === 'cross' ? 0 : len - 1;
  let linePts = pts;
  if (endHead) linePts = trimEnd(linePts, trim);
  if (startHead) linePts = trimEnd(linePts.slice().reverse(), trim).reverse();

  const path = el('path', {
    d: roundedPathD(linePts, CORNER_R),
    class: e.dash === 'dotted' ? 'wm-edge wm-edge-dotted' : 'wm-edge',
  }, g);
  if (w !== DEFAULT_EDGE_W) path.style.strokeWidth = w;
  if (e.color) path.style.stroke = e.color;

  const ends = [];
  if (endHead) ends.push([pts[pts.length - 1], pts[pts.length - 2]]);
  if (startHead) ends.push([pts[0], pts[1]]);
  for (const [tip, from] of ends) {
    const dist = Math.hypot(tip.x - from.x, tip.y - from.y) || 1;
    const ux = (tip.x - from.x) / dist;
    const uy = (tip.y - from.y) / dist;
    let head;
    if (e.mark === 'circle') {
      head = el('ellipse', { cx: tip.x - ux * half, cy: tip.y - uy * half, rx: half, ry: half, class: 'wm-edge' }, g);
      head.style.fill = '#ffffff';
      if (e.color) head.style.stroke = e.color;
      if (w !== DEFAULT_EDGE_W) head.style.strokeWidth = w;
      continue;
    }
    if (e.mark === 'cross') {
      const c = { x: tip.x - ux * half * 1.6, y: tip.y - uy * half * 1.6 };
      const k = half * 0.9;
      head = el('path', { d: `M${c.x - k} ${c.y - k}L${c.x + k} ${c.y + k}M${c.x + k} ${c.y - k}L${c.x - k} ${c.y + k}`, class: 'wm-edge' }, g);
      if (e.color) head.style.stroke = e.color;
      if (w !== DEFAULT_EDGE_W) head.style.strokeWidth = w;
      continue;
    }
    head = el('path', { d: arrowHeadD(tip, from, len, half), class: 'wm-arrow' }, g);
    if (e.color) head.style.fill = e.color;
  }

  // Pin names, small, just inside the block where the connector meets it --
  // the way a schematic labels a part's pins.
  for (const [name, tip, from] of [[e.fromPort, pts[0], pts[1]], [e.toPort, pts[pts.length - 1], pts[pts.length - 2]]]) {
    if (!name) continue;
    const dist = Math.hypot(from.x - tip.x, from.y - tip.y) || 1;
    const ix = (tip.x - from.x) / dist;   // pointing into the block
    const iy = (tip.y - from.y) / dist;
    const across = Math.abs(ix) > Math.abs(iy);
    const t = el('text', { x: tip.x + ix * 5, y: tip.y + iy * 10, class: 'wm-port' }, pinLayer || g);
    t.setAttribute('text-anchor', across ? (ix > 0 ? 'start' : 'end') : 'middle');
    t.textContent = name;
    if (e.color) t.style.fill = e.color;
  }
  if (box) {
    el('rect', { x: box.x, y: box.y, width: box.w, height: box.h, class: 'wm-edge-label-bg' }, g);
    const text = labelText(g, box.lines, box.mid.x, box.mid.y, box.size, e.bold, 'wm-edge-label', DEFAULT_EDGE_FONT);
    if (e.color) text.style.fill = e.color;
    if (e.italic) text.style.fontStyle = 'italic';
  }
  return g;
}

// Groups sit behind nodes, edges above groups but below nodes, so a connector
// never cuts across a label.
function drawDiagram(parent, d) {
  const groupLayer = el('g', { 'data-layer': 'groups' }, parent);
  const edgeLayer = el('g', { 'data-layer': 'edges' }, parent);
  const nodeLayer = el('g', { 'data-layer': 'nodes' }, parent);
  // Pin names sit inside blocks, so over them.
  const pinLayer = el('g', { 'data-layer': 'pins' });

  // Outer groups first, so a subgroup is drawn on top of the group it sits in.
  for (const g of d.groups.slice().sort((p, q) => groupDepth(d, p) - groupDepth(d, q))) if (g.w > 0) drawGroup(groupLayer, g);
  const geom = edgeGeometry(d);
  const labels = labelBoxes(d, geom);
  geom.forEach((pts, i) => { if (pts) drawEdge(edgeLayer, d.edges[i], pts, i, labels[i], pinLayer); });
  for (const n of d.nodes) drawNode(nodeLayer, n);
  parent.appendChild(pinLayer);
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
    const lines = wrapLabel(shownLabel(n), area.w - LABEL_PAD_X * 2, size, n.bold);
    const tw = Math.max(...lines.map((l) => textWidth(l, size, n.bold)));
    const th = lines.length * lineH(size);
    // Where drawNode puts it: from the left or right of the text area when aligned.
    const x0 = n.align === 'left' ? area.x + LABEL_PAD_X : n.align === 'right' ? area.x + area.w - LABEL_PAD_X - tw : area.x + area.w / 2 - tw / 2;
    const cy = area.y + area.h / 2;
    add(x0, cy - th / 2, x0 + tw, cy + th / 2);
  }
  for (const g of d.groups) {
    if (g.w > 0) add(g.x, g.y, g.x + groupTabWidth(g), g.y + groupTitleH(g));
  }
  const geom = edgeGeometry(d);
  const labels = labelBoxes(d, geom);
  geom.forEach((pts, i) => {
    if (!pts || pts.length < 2) return;
    const e = d.edges[i];
    // Half the stroke, or the arrowhead's half-width where that's wider.
    const m = Math.max((e.width || DEFAULT_EDGE_W) / 2, e.head === 'none' ? 0 : arrowSize(e).half) + 1;
    for (const p of pts) add(p.x - m, p.y - m, p.x + m, p.y + m);
    const b = labels[i];
    if (b) add(b.x, b.y, b.x + b.w, b.y + b.h);
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

// Pixels per inch at the size the picture has in Word: enough to stay sharp in
// print and when the picture is enlarged a little. (A fixed 3x oversample gave
// about 255.) Browsers refuse canvases past a size, WebKit (Word for Mac) the
// strictest, so a very big diagram gets fewer.
const TARGET_PPI = 400;
const CANVAS_MAX_SIDE = 16384;
const CANVAS_MAX_PIXELS = 16.7e6;
// Placed so a label at the default size lands at 11pt -- the size of the body
// text around it. At a literal 1px = 0.75pt it came out at 9.75pt, a visibly
// smaller, fussier-looking diagram than the document it sits in.
const PX_TO_PT = 11 / DEFAULT_FONT_SIZE;
const MAX_DOC_WIDTH_PT = 468;    // 6.5in: US Letter minus one-inch margins
// 8.5in: the 9in of text height on that page, less a line for a caption.
// Taller and the picture runs off the bottom of the page.
const MAX_DOC_HEIGHT_PT = 612;

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

// The size a diagram is placed at in Word, in points: default-size text lands
// at 11pt, and nothing is wider than the text column or taller than the page.
function pictureSize(d) {
  const b = diagramBounds(d);
  let w = Math.ceil(b.w + EXPORT_PAD * 2) * PX_TO_PT;
  let h = Math.ceil(b.h + EXPORT_PAD * 2) * PX_TO_PT;
  const fit = Math.min(1, MAX_DOC_WIDTH_PT / w, MAX_DOC_HEIGHT_PT / h);
  return { w: w * fit, h: h * fit, fit };
}

// The SVG Word gets for a vector picture. Word draws SVG with its own
// renderer, which can't be relied on to apply a <style> sheet or
// `dominant-baseline`, so every style is written onto its element as an
// attribute and text is moved down onto its baseline by hand.
function svgForWord(d) {
  const { svg } = buildExportSvg(d);
  const rules = [...SVG_STYLE.matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)].map(([, cls, body]) =>
    [cls, body.split(';').map((decl) => decl.split(':').map((t) => t.trim())).filter(([k, v]) => k && v)]);
  for (const node of svg.querySelectorAll('[class]')) {
    const classes = node.getAttribute('class').split(/\s+/);
    for (const [cls, decls] of rules) if (classes.includes(cls)) for (const [k, v] of decls) node.setAttribute(k, v);
    node.removeAttribute('class');
  }
  // Set on the element itself (a block's fill, a bigger label), so it wins over the class.
  for (const node of svg.querySelectorAll('[style]')) {
    for (let i = 0; i < node.style.length; i++) {
      const prop = node.style[i];
      // The browser expands text-decoration into longhands Word doesn't read.
      if (prop.startsWith('text-decoration')) { if (prop === 'text-decoration-line') node.setAttribute('text-decoration', node.style.getPropertyValue(prop)); continue; }
      node.setAttribute(prop, node.style.getPropertyValue(prop));
    }
    node.removeAttribute('style');
  }
  for (const text of svg.querySelectorAll('text[dominant-baseline]')) {
    text.setAttribute('y', +text.getAttribute('y') + parseFloat(text.getAttribute('font-size')) * 0.35);
    text.removeAttribute('dominant-baseline');
  }
  svg.querySelector('style').remove();
  return new XMLSerializer().serializeToString(svg);
}

// SVG -> data: URL -> <img> -> canvas -> PNG. Never a blob: URL, which taints
// the canvas in some hosts. `widthPt` is the width the picture will have in
// Word; without it, its natural size (pictureSize).
async function renderPng(d, widthPt) {
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

  // The declared DPI follows the pixels, so the picture lands at the size asked for.
  const w = widthPt || pictureSize(d).w;
  const h = w * height / width;

  const scale = Math.min(TARGET_PPI * (w / 72) / width, CANVAS_MAX_SIDE / Math.max(width, height),
    Math.sqrt(CANVAS_MAX_PIXELS / (width * height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const raw = atob(canvas.toDataURL('image/png').split(',')[1]);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

  return { base64: toBase64(withPngDpi(bytes, (canvas.width / w) * 72)), widthPt: w, heightPt: h };
}
