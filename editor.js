// Interaction: turns pointer events into model edits.
//
// The whole diagram is re-rendered after every change. Diagrams are small
// enough that this is instant, and it removes an entire class of stale-view
// bugs that incremental updates invite.

const GRID = 10;
const MIN_W = 60;
const MIN_H = 36;
const MIN_WIRE = 8;       // wiring symbols (junction, bar) may be much smaller than a text box
const UNDO_DEPTH = 50;
const PORT_OUT = 12;      // screen px between a block's border and its connection dots
const QUICK_GAP = 80;     // gap left by click-a-dot quick create

const EDITOR_STYLE = `
  .wm-canvas { width: 100%; height: 100%; display: block; background: #fff; touch-action: none; }
  .wm-selbox { fill: none; stroke: #2563eb; }
  .wm-multibox { fill: none; stroke: #2563eb; stroke-dasharray: 5 4; }
  .wm-hover { fill: none; stroke: #93b4f5; }
  .wm-seledge { fill: none; stroke: #2563eb; opacity: 0.35; }
  .wm-port { fill: #fff; stroke: #2563eb; cursor: crosshair; }
  .wm-handle { fill: #fff; stroke: #2563eb; }
  .wm-endhandle { fill: #2563eb; stroke: #fff; cursor: move; }
  .wm-rubber { fill: none; stroke: #2563eb; stroke-dasharray: 4 3; }
  .wm-marquee { fill: #2563eb; fill-opacity: 0.08; stroke: #2563eb; stroke-dasharray: 4 3; }
  .wm-droptarget { fill: none; stroke: #16a34a; }
  .wm-seghandle { fill: #fff; stroke: #2563eb; pointer-events: none; }
  .wm-group-sel { fill: none; stroke: #2563eb; }
  .wm-group-join { fill: #16a34a; fill-opacity: 0.06; stroke: #16a34a; }
  .wm-member { fill: #2563eb; fill-opacity: 0.07; stroke: #2563eb; stroke-opacity: 0.55; }
  .wm-ghost { fill: #2563eb; fill-opacity: 0.06; stroke: #2563eb; stroke-dasharray: 4 3; }
  .wm-guide { fill: none; stroke: #e11d74; }
`;

const PAGE_STYLE = `
  /* No text selection on the canvas: a drag across it otherwise starts the
     browser's own selection, which lit up labels and buttons in blue as the
     pointer swept past them. */
  .wm-host { position: relative; overflow: hidden; background: #fff;
    user-select: none; -webkit-user-select: none; }
  .wm-label-input { position: absolute; z-index: 5; box-sizing: border-box; text-align: center;
    font-family: Calibri, "Segoe UI", Helvetica, Arial, sans-serif; line-height: 1.25;
    border: 2px solid #2563eb; border-radius: 3px; padding: 3px 4px; outline: none;
    resize: none; overflow: hidden; background: #fff; color: #111;
    user-select: text; -webkit-user-select: text;
    box-shadow: 0 2px 10px rgba(0,0,0,0.15); }
`;

let model = newDiagram();
let host = null;
let svg = null;
let world = null;
let chrome = null;
let gridPattern = null;
let notify = () => {};
let onView = () => {};
let onMenu = () => {};
let onRender = () => {};
let onPickShape = null;

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 3;
let view = { x: 40, y: 40, zoom: 1 };
// Until the user pans or zooms themselves, the view keeps re-framing the
// diagram as the pane resizes. Dragging the task pane wider should show more
// of the diagram, not more empty grid -- and it means the first fit isn't
// stuck with whatever width the pane happened to have during layout.
let viewTouched = false;
let sel = new Set();      // node and group ids
let selEdge = -1;
let hoverNode = null;
let drag = null;
let armedShape = null;
let ghost = null;         // { shape, p }: preview of a shape about to be placed
let dragShape = null;     // the palette shape being dragged over the canvas, if any
let pendingConnect = null; // a connector dropped on empty canvas, waiting on the shape picker
let undoStack = [];
let redoStack = [];
let clipboard = null;
let styleClipboard = null;
let menuPoint = { x: 0, y: 0 };

const snap = (v) => Math.round(v / GRID) * GRID;

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function toModel(ev) {
  const r = svg.getBoundingClientRect();
  return { x: (ev.clientX - r.left - view.x) / view.zoom, y: (ev.clientY - r.top - view.y) / view.zoom };
}

// `extra.onRender` runs after every redraw (the shell keeps its floating
// toolbar pinned to the selection with it); `extra.onPickShape(x, y, suggested,
// done)` shows a shape picker when a connector is dropped on empty canvas.
function initEditor(hostEl, onChange, onViewChange, onContextMenu, extra) {
  host = hostEl;
  notify = onChange || (() => {});
  onView = onViewChange || (() => {});
  onMenu = onContextMenu || (() => {});
  onRender = (extra && extra.onRender) || (() => {});
  onPickShape = (extra && extra.onPickShape) || null;
  host.classList.add('wm-host');

  const pageStyle = document.createElement('style');
  pageStyle.textContent = PAGE_STYLE;
  document.head.appendChild(pageStyle);

  svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'wm-canvas');
  host.appendChild(svg);

  el('style', {}, svg).textContent = SVG_STYLE + EDITOR_STYLE;

  const defs = el('defs', {}, svg);
  gridPattern = el('pattern', { id: 'wm-grid', width: 20, height: 20, patternUnits: 'userSpaceOnUse' }, defs);
  el('circle', { cx: 1, cy: 1, r: 1, fill: '#dfe1e5' }, gridPattern);
  el('rect', { x: 0, y: 0, width: '100%', height: '100%', fill: 'url(#wm-grid)' }, svg);

  world = el('g', {}, svg);
  chrome = el('g', {}, svg);

  svg.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  // The OS can take the pointer away mid-drag (a notification, alt-tab);
  // treat that like Esc rather than leaving a drag stuck on.
  window.addEventListener('pointercancel', () => { if (drag) cancelDrag(); });
  window.addEventListener('blur', () => { if (drag) cancelDrag(); });
  svg.addEventListener('wheel', onWheel, { passive: false });
  svg.addEventListener('dblclick', onDoubleClick);
  svg.addEventListener('contextmenu', onContext);
  svg.addEventListener('pointerleave', () => { if (ghost && !drag) { ghost = null; render(); } });
  window.addEventListener('keydown', onKeyDown);

  // Drag-and-drop from the palette. The shape being dragged is announced by
  // the shell (dataTransfer can't be read during dragover), so a preview of it
  // follows the pointer across the canvas the way Miro's does.
  host.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    if (dragShape) { ghost = { shape: dragShape, p: toModel(ev) }; render(); }
  });
  host.addEventListener('dragleave', () => { ghost = null; render(); });
  host.addEventListener('drop', (ev) => {
    ev.preventDefault();
    ghost = null;
    // Carried on text/plain with a prefix rather than a custom MIME type --
    // WebKit (Word for Mac) drops custom types.
    const payload = ev.dataTransfer.getData('text/plain') || '';
    if (!payload.startsWith('wm-shape:')) { render(); return; }
    addNode(payload.slice(9), toModel(ev));
  });

  new ResizeObserver(() => { if (viewTouched) render(); else fitView(); }).observe(host);
  render();
}

function setDragShape(shape) { dragShape = shape; if (!shape && ghost) { ghost = null; render(); } }

function render() {
  // Loading, undo and delete all swap the node objects out from under the
  // hover, which would otherwise leave connection ports floating over a block
  // that no longer exists.
  if (hoverNode && !model.nodes.includes(hoverNode)) hoverNode = null;
  const t = `translate(${view.x} ${view.y}) scale(${view.zoom})`;
  world.setAttribute('transform', t);
  chrome.setAttribute('transform', t);
  gridPattern.setAttribute('patternTransform', t);
  clear(world);
  clear(chrome);
  drawDiagram(world, model);
  drawChrome();
  onRender();
}

// Ports are spaced roughly every 45px along a side, so a tall or wide block
// offers more places to land than a small one -- which is the whole point of
// not being stuck with four.
function portSpots(n) {
  const out = [];
  for (const side of ['n', 'e', 's', 'w']) {
    const len = side === 'n' || side === 's' ? n.w : n.h;
    const count = Math.max(1, Math.min(5, Math.round(len / 45)));
    for (let i = 1; i <= count; i++) {
      const t = i / (count + 1);
      const p = anchorPoint(n, side, t);
      out.push({ x: p.x, y: p.y, side, t });
    }
  }
  return out;
}

function nearestPort(n, p, maxDist) {
  let best = null;
  let bestD = maxDist;
  for (const s of portSpots(n)) {
    const dd = Math.hypot(s.x - p.x, s.y - p.y);
    if (dd < bestD) { bestD = dd; best = s; }
  }
  return best;
}

function groupOf(id) {
  return model.groups.find((g) => g.members.includes(id)) || null;
}

function outline(box, pad, cls, width, parent) {
  el('rect', {
    x: box.x - pad, y: box.y - pad, width: box.w + pad * 2, height: box.h + pad * 2,
    rx: box.rx || 0, class: cls, 'stroke-width': width,
  }, parent || chrome);
}

// Chrome is drawn inside the zoom transform, so every size is divided by the
// zoom to keep handles and hairlines a constant size on screen.
function drawChrome() {
  const s = 1 / view.zoom;
  const only = sel.size === 1 ? nodeById(model, [...sel][0]) : null;
  let portNode = hoverNode || only;

  // Groups first, underneath everything else. A selected group -- or the
  // group of a selected block -- is outlined and its members tinted, so what
  // belongs to it is visible at a glance instead of being guesswork.
  const litGroups = new Set(model.groups.filter((g) => sel.has(g.id) ||
    g.members.some((m) => sel.has(m))));
  if (drag && drag.mode === 'move') {
    // While dragging, the group the blocks will land in lights up green.
    const moving = new Set(drag.nodes.map((n) => n.id));
    for (const g of model.groups) {
      const joining = g.members.some((m) => moving.has(m)) && !g.members.every((m) => moving.has(m));
      if (joining && g.w) outline({ ...g, rx: 8 }, 3 * s, 'wm-group-join', 2.5 * s);
    }
  } else {
    for (const g of litGroups) {
      if (!g.w) continue;
      outline({ ...g, rx: 8 }, 2 * s, 'wm-group-sel', 2 * s);
      for (const id of g.members) {
        const m = nodeById(model, id);
        if (m && !sel.has(m.id)) outline(m, 2 * s, 'wm-member', 1 * s);
      }
    }
  }

  if (hoverNode && !sel.has(hoverNode.id) && !drag) outline(hoverNode, 2 * s, 'wm-hover', 1.5 * s);

  for (const id of sel) {
    const box = nodeById(model, id) || model.groups.find((g) => g.id === id);
    if (!box || !box.w) continue;
    outline(box, 3 * s, 'wm-selbox', 1.5 * s);
  }
  // Several things selected: one box around the lot, as in Miro.
  if (sel.size > 1) {
    const b = boundsOf(selectedNodes());
    if (b) outline(b, 8 * s, 'wm-multibox', 1.2 * s);
  }

  if (selEdge >= 0 && model.edges[selEdge]) drawEdgeChrome(s);
  if (drag && drag.mode === 'move') drawGuides(s);

  if (ghost) drawGhost(ghost.shape, ghost.p);

  if (drag && drag.mode === 'marquee') {
    const b = marqueeBox(drag);
    el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, class: 'wm-marquee', 'stroke-width': 1.5 * s }, chrome);
    return;
  }

  const wire = drag && (drag.mode === 'connect' || drag.mode === 'reattach') ? drag : pendingConnect;
  if (wire) {
    el('path', {
      d: `M${wire.origin.x} ${wire.origin.y}L${wire.cur.x} ${wire.cur.y}`,
      class: 'wm-rubber', 'stroke-width': 1.5 * s,
    }, chrome);
    if (wire.over && wire.over !== wire.from) {
      outline(wire.over, 3 * s, 'wm-droptarget', 2.5 * s);
      // Show the target's ports mid-drag so there is something to aim at.
      portNode = wire.over;
    } else {
      portNode = null;
    }
  }

  // No dots mid-gesture (panning, moving, resizing, marquee) -- only while
  // wiring, where they are the target. Otherwise the last block the pointer
  // passed over kept its dots lit while the canvas slid around under it.
  if (drag && !wire) portNode = null;
  if (portNode && !pendingConnect) {
    for (const p of portSpots(portNode)) {
      // The dots float just outside the border, the way Miro draws them, so
      // grabbing a block near its edge moves it instead of starting a
      // connector, and the side resize handles on the border stay clear. An
      // invisible disc larger than the dot does the catching -- a 5px target
      // is far too fiddly to hit, especially zoomed out.
      const cx = p.x + DIRS[p.side].x * PORT_OUT * s;
      const cy = p.y + DIRS[p.side].y * PORT_OUT * s;
      el('circle', {
        cx, cy, r: 10 * s, fill: 'transparent', stroke: 'none',
        style: 'cursor:crosshair', 'data-role': 'port', 'data-for': portNode.id,
        'data-side': p.side, 'data-t': p.t.toFixed(4),
      }, chrome);
      el('circle', {
        cx, cy, r: 5 * s, class: 'wm-port', 'stroke-width': 2 * s,
        style: 'pointer-events:none',
      }, chrome);
    }
  }

  if (only && !drag) {
    const mx = only.x + only.w / 2;
    const my = only.y + only.h / 2;
    let handles = [
      ['nw', only.x, only.y, 'nwse'], ['n', mx, only.y, 'ns'], ['ne', only.x + only.w, only.y, 'nesw'],
      ['e', only.x + only.w, my, 'ew'], ['se', only.x + only.w, only.y + only.h, 'nwse'],
      ['s', mx, only.y + only.h, 'ns'], ['sw', only.x, only.y + only.h, 'nesw'], ['w', only.x, my, 'ew'],
    ];
    // On something small on screen -- a junction dot, a bus bar -- eight
    // handles would bury it, and grabbing it to move it would resize it
    // instead. One corner handle is enough.
    if (Math.min(only.w, only.h) * view.zoom < 40) handles = handles.filter((h) => h[0] === 'se');
    for (const [name, x, y, cursor] of handles) {
      el('rect', {
        x: x - 4 * s, y: y - 4 * s, width: 8 * s, height: 8 * s,
        class: 'wm-handle', 'stroke-width': 1.5 * s, style: 'cursor:' + cursor + '-resize',
        'data-role': 'handle-' + name, 'data-for': only.id,
      }, chrome);
    }
  }
}

function drawEdgeChrome(s) {
  const e = model.edges[selEdge];
  const pts = edgeGeometry(model)[selEdge];
  if (!pts) return;
  el('path', { d: roundedPathD(pts, CORNER_R), class: 'wm-seledge', 'stroke-width': 7 * s }, chrome);
  if (e.from === e.to) return;
  if (e.route === 'straight') { drawEndHandles(pts, s); return; }   // a straight line has no legs to drag
  // A grip on each leg long enough to grab, so it's obvious the path can be
  // dragged. Purely visual: the press lands on the connector itself. Where the
  // label sits the grip would cover the text, so the grip goes at the leg's
  // end instead.
  const labelMid = e.label ? longestSegmentMidpoint(pts) : null;
  for (let j = 1; j < pts.length; j++) {
    let a = pts[j - 1];
    let b = pts[j];
    if (Math.hypot(b.x - a.x, b.y - a.y) < 24 * s) continue;
    if (labelMid && Math.abs((a.x + b.x) / 2 - labelMid.x) < 0.5 && Math.abs((a.y + b.y) / 2 - labelMid.y) < 0.5) {
      const box = edgeLabelBox(e, pts);
      const past = Math.abs(a.y - b.y) < 0.5 ? box.w / 2 + 14 * s : box.h / 2 + 14 * s;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len / 2 < past + 10 * s) continue;
      const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
      const at = { x: labelMid.x + u.x * past, y: labelMid.y + u.y * past };
      a = { x: at.x - u.x, y: at.y - u.y };
      b = { x: at.x + u.x, y: at.y + u.y };
    }
    const horizontal = Math.abs(a.y - b.y) < 0.5;
    const w = (horizontal ? 14 : 6) * s;
    const h = (horizontal ? 6 : 14) * s;
    el('rect', {
      x: (a.x + b.x) / 2 - w / 2, y: (a.y + b.y) / 2 - h / 2, width: w, height: h, rx: 2 * s,
      class: 'wm-seghandle', 'stroke-width': 1.5 * s,
    }, chrome);
  }
  drawEndHandles(pts, s);
}

// The two ends: drag one onto another block to reconnect it, as in Miro.
function drawEndHandles(pts, s) {
  if (drag && drag.mode === 'reattach') return;
  for (const [end, p] of [['from', pts[0]], ['to', pts[pts.length - 1]]]) {
    el('circle', {
      cx: p.x, cy: p.y, r: 6 * s, class: 'wm-endhandle', 'stroke-width': 2 * s,
      'data-role': 'edge-end', 'data-end': end,
    }, chrome);
  }
}

function drawGhost(shape, p) {
  const [w, h] = defaultSize(shape);
  const n = { x: p.x - w / 2, y: p.y - h / 2, w, h, shape };
  for (const part of shapeElement(n)) {
    part.setAttribute('class', 'wm-ghost');
    part.setAttribute('stroke-width', 1.5 / view.zoom);
    part.style.pointerEvents = 'none';
    chrome.appendChild(part);
  }
  if (shape === 'text') outline(n, 0, 'wm-ghost', 1.5 / view.zoom);
}

// --- hit testing --------------------------------------------------------

function nodeAt(p, margin) {
  const m = margin || 0;
  for (let i = model.nodes.length - 1; i >= 0; i--) {
    const n = model.nodes[i];
    // Anything smaller than 20px on screen gets its hit area padded out to
    // that, or a 14px junction -- worse, zoomed out -- is next to impossible
    // to click.
    const grow = Math.max(m, Math.max(0, 20 - Math.min(n.w, n.h) * view.zoom) / 2 / view.zoom);
    if (p.x >= n.x - grow && p.x <= n.x + n.w + grow && p.y >= n.y - grow && p.y <= n.y + n.h + grow) return n;
  }
  return null;
}

// Anywhere inside a group's box grabs the group, like a Miro frame. Blocks and
// connectors are hit-tested first, so the ones inside stay individually
// selectable.
function groupAt(p) {
  for (const g of model.groups) {
    if (g.w && p.x >= g.x && p.x <= g.x + g.w && p.y >= g.y && p.y <= g.y + g.h) return g;
  }
  return null;
}

function groupBoxes() {
  return model.groups.filter((g) => g.w).map((g) => ({ g, x: g.x, y: g.y, w: g.w, h: g.h }));
}

// Groups behave like Miro frames: a block belongs to whichever group box its
// centre sits in. Dragging a block out of a group takes it out, dropping one
// in adds it. `boxes` are the group boxes as they were before the change, so
// a group stretching to follow a block being dragged out can't keep it.
// Groups that are moving as a whole are left alone -- moving a group isn't
// regrouping anything.
function regroup(nodes, boxes) {
  const ids = new Set(nodes.map((n) => n.id));
  const whole = new Set(model.groups.filter((g) => g.members.every((m) => ids.has(m))));
  for (const n of nodes) {
    const home = groupOf(n.id);
    if (home && whole.has(home)) continue;
    const c = centerOf(n);
    const hit = boxes.find((b) => !whole.has(b.g) &&
      c.x >= b.x && c.x <= b.x + b.w && c.y >= b.y && c.y <= b.y + b.h);
    const target = hit ? hit.g : null;
    if (target === home) continue;
    if (home) home.members = home.members.filter((m) => m !== n.id);
    if (target) target.members.push(n.id);
  }
}

function distToSeg(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  if (!len) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

// A connector is hit on its line or on its label -- clicking the words
// written on a connector has to pick the connector.
function edgeAt(p) {
  const geom = edgeGeometry(model);
  for (let i = geom.length - 1; i >= 0; i--) {
    const pts = geom[i];
    if (!pts || pts.length < 2) continue;
    for (let j = 1; j < pts.length; j++) if (distToSeg(p, pts[j - 1], pts[j]) < 7 / view.zoom + 2) return i;
    const e = model.edges[i];
    if (e.label) {
      const b = edgeLabelBox(e, pts);
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return i;
    }
  }
  return -1;
}

// Which leg of an edge's raw route is under the pointer, as the index of its
// first point, or -1 if the edge can't be reshaped there. The very first and
// last legs are the stubs welded to the blocks; grabbing one of those moves
// the leg next to it instead, which is what puts a jog in beside the block.
function legAt(route, p) {
  const q = route.raw;
  if (route.self || q.length < 4) return -1;
  let k = 0;
  let best = Infinity;
  for (let j = 0; j < q.length - 1; j++) {
    const dd = distToSeg(p, q[j], q[j + 1]);
    if (dd < best) { best = dd; k = j; }
  }
  return Math.max(1, Math.min(q.length - 3, k));
}

// Every edge whose two ends are both in `ids`, with a copy of its bends. When
// a set of blocks moves together their hand-drawn connectors have to come
// along; left behind, every internal path would spring into knots.
function riders(ids) {
  return model.edges
    .filter((e) => e.points && ids.has(e.from) && ids.has(e.to))
    .map((e) => ({ e, points: e.points.map((q) => ({ ...q })) }));
}

function marqueeBox(d) {
  return {
    x: Math.min(d.start.x, d.cur.x), y: Math.min(d.start.y, d.cur.y),
    w: Math.abs(d.cur.x - d.start.x), h: Math.abs(d.cur.y - d.start.y),
  };
}

function boundsOf(boxes) {
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  return { x: x0, y: y0, w: Math.max(...boxes.map((b) => b.x + b.w)) - x0,
           h: Math.max(...boxes.map((b) => b.y + b.h)) - y0 };
}

// --- model edits --------------------------------------------------------

function pushUndo() {
  undoStack.push(JSON.stringify(model));
  if (undoStack.length > UNDO_DEPTH) undoStack.shift();
  redoStack.length = 0;
}

function refitGroups() {
  model.groups = model.groups.filter((g) => g.members.length);
  for (const g of model.groups) fitGroup(model, g);
}

function commit() {
  refitGroups();
  // Once you've started editing, the view is yours: the pane resizing (the
  // status line wrapping onto a second line is enough) must not re-fit and
  // shift the whole diagram under the pointer.
  viewTouched = true;
  render();
  notify();
}

function takenIds() {
  return new Set(model.nodes.map((n) => n.id).concat(model.groups.map((g) => g.id)));
}

// Centred on `c`. Caller is responsible for pushUndo/commit -- connecting to
// empty canvas creates a node and an edge as one undoable step.
function makeNode(shape, c) {
  const label = LABELLESS.has(shape) ? '' : shape === 'text' ? 'Text' : 'Block';
  const [w, h] = defaultSize(shape);
  // Wiring symbols snap by their centre, so a junction dot sits exactly on the
  // grid line a wire runs along; text blocks snap by their corner as usual.
  const wire = LABELLESS.has(shape);
  const x = wire ? snap(c.x) - w / 2 : snap(c.x - w / 2);
  const y = wire ? snap(c.y) - h / 2 : snap(c.y - h / 2);
  const n = { id: makeId(label || shape, takenIds()), label, shape, x, y,
              w, h, fill: '#ffffff', fontSize: DEFAULT_FONT_SIZE, bold: false };
  fitNodeSize(n);
  model.nodes.push(n);
  return n;
}

function addNode(shape, c) {
  pushUndo();
  const boxes = groupBoxes();
  const n = makeNode(shape, c);
  regroup([n], boxes);
  sel = new Set([n.id]);
  selEdge = -1;
  commit();
  // Open for naming straight away -- a block called "Block" is never what you
  // wanted, and this saves a separate double-click every single time.
  beginLabelEdit(n);
  return n;
}

// A new block wired to `from` at `anchor`. The shape defaults to the source's,
// which is what you almost always want next in a chain.
function addConnected(from, anchor, shape, c) {
  pushUndo();
  const boxes = groupBoxes();
  const n = makeNode(shape, c);
  // The same shape comes out the same size as its source, so a chain built by
  // clicking dots is a row of matching blocks rather than a ragged one.
  if (shape === from.shape && !LABELLESS.has(shape)) {
    n.x = snap(c.x - from.w / 2);
    n.y = snap(c.y - from.h / 2);
    n.w = from.w;
    n.h = from.h;
  }
  regroup([n], boxes);
  const e = newEdge(from.id, n.id);
  e.fromAnchor = { side: anchor.side, t: anchor.t };
  model.edges.push(e);
  sel = new Set([n.id]);
  selEdge = -1;
  commit();
  beginLabelEdit(n);
  return n;
}

function nextShapeAfter(n) {
  return n.shape === 'text' || LABELLESS.has(n.shape) ? 'rect' : n.shape;
}

function deleteSelection() {
  if (!sel.size && selEdge < 0) return;
  pushUndo();
  if (selEdge >= 0) model.edges.splice(selEdge, 1);
  // Deleting a group boundary takes its blocks with it -- Ungroup is the one
  // that keeps them, and having both do the same thing would be a trap.
  const gone = new Set(selectedNodes().map((n) => n.id));
  model.nodes = model.nodes.filter((n) => !gone.has(n.id));
  model.edges = model.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to));
  model.groups = model.groups.filter((g) => !sel.has(g.id));
  for (const g of model.groups) g.members = g.members.filter((m) => !gone.has(m));
  sel = new Set();
  selEdge = -1;
  commit();
}

// Every selected block, plus the members of every selected group.
function selectedNodes() {
  const ids = new Set();
  for (const id of sel) {
    if (nodeById(model, id)) ids.add(id);
    const g = model.groups.find((gr) => gr.id === id);
    if (g) g.members.forEach((m) => ids.add(m));
  }
  return [...ids].map((id) => nodeById(model, id)).filter(Boolean);
}

function groupSelection() {
  const ids = selectedNodes().map((n) => n.id);
  if (!ids.length) return 'select blocks first -- shift-click them, or shift-drag a box around them';
  pushUndo();
  for (const g of model.groups) g.members = g.members.filter((m) => !ids.includes(m));
  const g = { id: makeId('Group', takenIds()), label: 'Group', members: ids, x: 0, y: 0, w: 0, h: 0 };
  model.groups.push(g);
  // Select the new boundary and open its name for editing: otherwise grouping
  // looks like it did nothing, because the blocks stay selected underneath.
  sel = new Set([g.id]);
  selEdge = -1;
  commit();
  beginLabelEdit(g);
  return null;
}

function ungroupSelection() {
  // Works whether you picked the boundary or a block inside it -- hunting for
  // the title tab just to undo a grouping is busywork.
  const hit = model.groups.filter((g) => sel.has(g.id) || g.members.some((m) => sel.has(m)));
  if (!hit.length) return 'select a group boundary, or a block inside one';
  pushUndo();
  model.groups = model.groups.filter((g) => !hit.includes(g));
  commit();
  return null;
}

function addSelectionToGroup(groupId) {
  const g = model.groups.find((gr) => gr.id === groupId);
  const nodes = [...sel].map((id) => nodeById(model, id)).filter(Boolean);
  if (!g || !nodes.length) return 'select one or more blocks first';
  pushUndo();
  const ids = new Set(nodes.map((n) => n.id));
  for (const other of model.groups) other.members = other.members.filter((m) => !ids.has(m));
  g.members.push(...ids);
  commit();
  return null;
}

// Taking a block out of a group that still visually surrounds it would look
// like nothing happened, so it's moved just clear of the group's box.
function removeSelectionFromGroup() {
  const nodes = [...sel].map((id) => nodeById(model, id)).filter((n) => n && groupOf(n.id));
  if (!nodes.length) return 'select a block that is in a group';
  pushUndo();
  const homes = nodes.map((n) => groupOf(n.id));
  nodes.forEach((n, i) => { homes[i].members = homes[i].members.filter((m) => m !== n.id); });
  refitGroups();
  nodes.forEach((n, i) => {
    const g = homes[i];
    if (!g.w) return;
    const c = centerOf(n);
    if (c.x >= g.x && c.x <= g.x + g.w && c.y >= g.y && c.y <= g.y + g.h) n.x = snap(g.x + g.w + 30);
  });
  commit();
  return null;
}

function applyToNodes(fn) {
  const nodes = selectedNodes();
  if (!nodes.length) return;
  pushUndo();
  nodes.forEach(fn);
  commit();
}

function applyToEdge(fn) {
  if (selEdge < 0 || !model.edges[selEdge]) return;
  pushUndo();
  fn(model.edges[selEdge]);
  commit();
}

// Back to automatic routing. The ports stay pinned -- they were chosen by
// hand, and only the bends are being thrown away.
function resetEdgePath() {
  applyToEdge((e) => { e.points = null; });
}

// Straight line <-> right angles. The ports and any hand-drawn bends are kept,
// just not used while straight, so switching back restores the old path.
function toggleStraight() {
  applyToEdge((e) => { e.route = e.route === 'straight' ? 'elbow' : 'straight'; });
}

function setAllRoutes(route) {
  if (!model.edges.length) return;
  pushUndo();
  for (const e of model.edges) e.route = route;
  commit();
}

// Swaps which end the arrow points at. Anchors and bends swap with it so the
// line itself doesn't move -- only the direction it's read in.
function reverseEdge() {
  applyToEdge((e) => {
    [e.from, e.to] = [e.to, e.from];
    [e.fromAnchor, e.toAnchor] = [e.toAnchor, e.fromAnchor];
    if (e.points) e.points.reverse();
  });
}

// Ctrl+B, and the B button: bold on if anything selected isn't bold, off if
// all of it already is -- the way Word's button behaves with a mixed selection.
function toggleBold() {
  if (selEdge >= 0 && model.edges[selEdge]) { applyToEdge((e) => { e.bold = !e.bold; }); return; }
  const nodes = selectedNodes().filter((n) => !LABELLESS.has(n.shape));
  if (!nodes.length) return;
  const on = nodes.some((n) => !n.bold);
  applyToNodes((n) => { if (!LABELLESS.has(n.shape)) { n.bold = on; fitNodeSize(n); } });
}

// Miro's copy style / paste style: the look of one thing onto others, without
// touching their text, shape or position.
function copyStyle() {
  const e = selEdge >= 0 ? model.edges[selEdge] : null;
  const n = selectedNodes()[0];
  if (e) styleClipboard = { kind: 'edge', dash: e.dash, head: e.head, width: e.width, color: e.color,
                            fontSize: e.fontSize, bold: e.bold, route: e.route };
  else if (n) styleClipboard = { kind: 'node', fill: n.fill, fontSize: n.fontSize, bold: n.bold };
  else return false;
  return true;
}

function pasteStyle() {
  if (!styleClipboard) return false;
  const { kind, ...style } = styleClipboard;
  if (kind === 'edge' && selEdge >= 0) { applyToEdge((e) => Object.assign(e, style)); return true; }
  if (kind === 'node' && selectedNodes().length) {
    applyToNodes((n) => { Object.assign(n, style); fitNodeSize(n); });
    return true;
  }
  return false;
}

function reorderSelection(toFront) {
  const nodes = selectedNodes();
  if (!nodes.length) return;
  pushUndo();
  const rest = model.nodes.filter((n) => !nodes.includes(n));
  model.nodes = toFront ? rest.concat(nodes) : nodes.concat(rest);
  commit();
}

function selectAll() {
  sel = new Set(model.nodes.map((n) => n.id));
  selEdge = -1;
  render();
  notify();
}

// --- clipboard ----------------------------------------------------------
//
// Internal, not the system clipboard: navigator.clipboard is blocked inside
// Word's task pane iframe, and pasting a picture of a block would be useless
// anyway. Edges come along only when both of their ends do.

function copySelection() {
  const nodes = selectedNodes();
  if (!nodes.length) return false;
  const ids = new Set(nodes.map((n) => n.id));
  // Groups come along when every one of their blocks does. Without that, a
  // duplicated group pasted 20px over from the original dropped all of its
  // copies into the original group instead of making a second one.
  clipboard = JSON.parse(JSON.stringify({
    nodes,
    edges: model.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
    groups: model.groups.filter((g) => g.members.length && g.members.every((m) => ids.has(m))),
  }));
  clipboard.pastes = 0;
  return true;
}

function hasClipboard() { return !!(clipboard && clipboard.nodes.length); }

// Ctrl+V. Each paste lands a step further down and right than the last, the
// way PowerPoint and Miro cascade, instead of stacking every copy exactly on
// top of the previous one. If that spot is off-screen -- you copied, then
// panned away -- the copy lands in the middle of what you're looking at.
function pasteNext() {
  if (!hasClipboard()) return false;
  clipboard.pastes += 1;
  const off = 20 * clipboard.pastes;
  const b = boundsOf(clipboard.nodes);
  const r = svg.getBoundingClientRect();
  const vx = -view.x / view.zoom;
  const vy = -view.y / view.zoom;
  const onScreen = b.x + off < vx + r.width / view.zoom && b.x + b.w + off > vx &&
                   b.y + off < vy + r.height / view.zoom && b.y + b.h + off > vy;
  if (onScreen) return pasteClipboard(off, off);
  const c = canvasCenter();
  return pasteClipboard(c.x - b.w / 2 - b.x, c.y - b.h / 2 - b.y);
}

function duplicateSelection() {
  return copySelection() && pasteNext();
}

function pasteClipboard(dx, dy) {
  if (!hasClipboard()) return false;
  pushUndo();
  const boxes = groupBoxes();
  const taken = takenIds();
  const remap = {};
  const made = [];
  for (const source of clipboard.nodes) {
    const n = JSON.parse(JSON.stringify(source));
    n.id = makeId(n.label || n.shape, taken);
    taken.add(n.id);
    remap[source.id] = n.id;
    n.x = snap(n.x + dx);
    n.y = snap(n.y + dy);
    model.nodes.push(n);
    made.push(n.id);
  }
  for (const e of clipboard.edges) {
    const copy = JSON.parse(JSON.stringify(e));
    copy.from = remap[e.from];
    copy.to = remap[e.to];
    // Shifted by exactly what the blocks moved (blocks sit on the grid, so
    // that's the snapped offset) and not snapped individually: bends lined
    // up with a port are usually off-grid, and snapping them puts a kink in.
    if (copy.points) copy.points = copy.points.map((q) => ({ x: q.x + snap(dx), y: q.y + snap(dy) }));
    model.edges.push(copy);
  }
  const madeGroups = [];
  for (const g of clipboard.groups || []) {
    const copy = { id: makeId(g.label, taken), label: g.label, members: g.members.map((m) => remap[m]),
                   x: 0, y: 0, w: 0, h: 0 };
    taken.add(copy.id);
    model.groups.push(copy);
    madeGroups.push(copy.id);
  }
  // Pasted next to blocks in a group, loose copies join that group. Copies in
  // a pasted group of their own stay in it: regroup leaves whole groups alone.
  regroup(made.map((id) => nodeById(model, id)), boxes);
  sel = new Set(made.filter((id) => !madeGroups.some((gid) =>
    model.groups.find((g) => g.id === gid).members.includes(id))).concat(madeGroups));
  selEdge = -1;
  commit();
  return true;
}

// Drops the copy where the pointer is rather than at a fixed offset, which is
// what "paste here" from the right-click menu has to mean.
function pasteAt(p) {
  if (!hasClipboard()) return false;
  const b = boundsOf(clipboard.nodes);
  return pasteClipboard(p.x - b.x, p.y - b.y);
}

// Whatever was selected stays selected across undo and redo, as long as it
// still exists -- undoing a move shouldn't make you re-select the block to
// carry on. A connector is identified only by its index, which undo can
// reshuffle, so that one is dropped.
function restoreModel(text) {
  model = JSON.parse(text);
  sel = new Set([...sel].filter((id) => nodeById(model, id) || model.groups.some((g) => g.id === id)));
  selEdge = -1;
  render();
  notify();
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(JSON.stringify(model));
  restoreModel(undoStack.pop());
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify(model));
  restoreModel(redoStack.pop());
}

// --- pointer ------------------------------------------------------------

function onPointerDown(ev) {
  if (pendingConnect) return;     // the shape picker is open; it owns the next click
  // Any press on the canvas finishes an open label edit. Normally the textarea
  // losing focus does that, but if it never had focus (the host can refuse
  // it) no blur ever arrives and the box would sit there for good.
  commitOpenEditor();
  // Capture, so the release still arrives if the pointer leaves the pane
  // mid-drag -- otherwise the drag never ends and the next move drags again.
  try { svg.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic events have no live pointer */ }
  if (ev.button === 1) {
    drag = { mode: 'pan', sx: ev.clientX, sy: ev.clientY, vx: view.x, vy: view.y };
    ev.preventDefault();
    return;
  }
  if (ev.button !== 0) return;

  const role = ev.target.getAttribute && ev.target.getAttribute('data-role');
  const p = toModel(ev);

  if (role === 'port') {
    const from = nodeById(model, ev.target.getAttribute('data-for'));
    if (!from) return;            // chrome outlived the block it belonged to
    const anchor = { side: ev.target.getAttribute('data-side'), t: +ev.target.getAttribute('data-t') };
    drag = { mode: 'connect', from, anchor, origin: anchorPoint(from, anchor.side, anchor.t), cur: p, over: null,
             sx: ev.clientX, sy: ev.clientY };
    render();
    return;
  }
  if (role === 'edge-end') {
    const e = model.edges[selEdge];
    if (!e) return;
    const end = ev.target.getAttribute('data-end');
    const pts = edgeGeometry(model)[selEdge];
    // The rubber band runs from the end that stays put.
    const fixed = end === 'from' ? pts[pts.length - 1] : pts[0];
    drag = { mode: 'reattach', edge: e, end, origin: fixed, cur: p, over: null,
             from: nodeById(model, end === 'from' ? e.to : e.from) };
    render();
    return;
  }
  if (role && role.startsWith('handle-')) {
    const n = nodeById(model, ev.target.getAttribute('data-for'));
    if (!n) return;               // chrome outlived the block it belonged to
    drag = { mode: 'resize', node: n, corner: role.slice(7), start: p, box: { ...n } };
    return;
  }
  if (armedShape) {
    const shape = armedShape;
    armedShape = null;
    ghost = null;
    addNode(shape, p);
    notify();
    return;
  }

  // Shift- or Ctrl-click toggles, as in PowerPoint and Word. Anything that
  // would shrink the selection waits for the release: pressing on an already
  // selected block has to leave the whole selection intact in case this turns
  // into a drag of all of them, and only a click that never moved collapses it.
  const toggle = ev.shiftKey || ev.ctrlKey || ev.metaKey;
  const n = nodeAt(p);
  if (n) {
    let onRelease = null;
    if (toggle) { if (sel.has(n.id)) onRelease = 'deselect'; else sel.add(n.id); }
    else if (!sel.has(n.id)) sel = new Set([n.id]);
    else if (sel.size > 1) onRelease = 'only';
    selEdge = -1;
    startMove(p);
    drag.onRelease = onRelease;
    drag.hit = n.id;
    render();
    notify();
    return;
  }

  // Connectors before groups: a connector running along a group's border band
  // would otherwise be impossible to pick up.
  const ei = edgeAt(p);
  if (ei >= 0) {
    selEdge = ei;
    sel = new Set();
    const route = edgeRoutes(model)[ei];
    const k = legAt(route, p);
    if (k >= 0) {
      const q = route.raw;
      const horizontal = Math.abs(q[k].y - q[k + 1].y) < 0.5;
      drag = { mode: 'segment', edge: model.edges[ei], route, k, axis: horizontal ? 'y' : 'x' };
    }
    render();
    notify();
    return;
  }

  const g = groupAt(p);
  if (g) {
    sel = toggle ? new Set([...sel, g.id]) : new Set([g.id]);
    selEdge = -1;
    startMove(p);
    render();
    notify();
    return;
  }

  // Shift-drag on empty canvas draws a selection box; a plain drag pans. Pan
  // is the unmodified gesture because moving around is what people reach for
  // first, and grouping needs the box only occasionally.
  if (ev.shiftKey) {
    drag = { mode: 'marquee', start: p, cur: p, base: new Set(sel) };
    render();
    return;
  }
  sel = new Set();
  selEdge = -1;
  hoverNode = null;
  drag = { mode: 'pan', sx: ev.clientX, sy: ev.clientY, vx: view.x, vy: view.y };
  svg.style.cursor = 'grabbing';
  render();
  notify();
}

// The resize cursor over a connector leg tells you which way it will move.
function legCursor(p) {
  const ei = edgeAt(p);
  if (ei < 0) return null;
  const route = edgeRoutes(model)[ei];
  const k = legAt(route, p);
  if (k < 0) return 'pointer';
  return Math.abs(route.raw[k].y - route.raw[k + 1].y) < 0.5 ? 'ns-resize' : 'ew-resize';
}

// Smart guides, PowerPoint/Miro-style: while dragging, the moving blocks snap
// to line up with any other block -- left, centre or right edges, top, middle
// or bottom -- within a few screen pixels, and a guide line shows what they
// lined up with. Lining up with the block next door is nearly always what you
// were aiming for, so it wins over the grid on that axis.
function alignGuides(dx, dy, lockX, lockY) {
  const b0 = drag.bounds;
  const moving = new Set(drag.nodes.map((n) => n.id));
  const others = model.nodes.filter((n) => !moving.has(n.id));
  const tol = 6 / view.zoom;
  const guides = [];
  const along = (key, size, d, locked) => {
    if (locked || !others.length) return null;
    let best = null;
    for (const f of [0, 0.5, 1]) {
      const mine = b0[key] + d + b0[size] * f;
      for (const o of others) {
        for (const g of [0, 0.5, 1]) {
          const v = o[key] + o[size] * g;
          const off = v - mine;
          if (Math.abs(off) <= tol && (!best || Math.abs(off) < Math.abs(best.off))) best = { off, v, o };
        }
      }
    }
    if (best) guides.push({ axis: key, v: best.v, o: best.o });
    return best ? d + best.off : null;
  };
  return { gx: along('x', 'w', dx, lockX), gy: along('y', 'h', dy, lockY), guides };
}

function drawGuides(s) {
  const b = boundsOf(drag.nodes);
  for (const g of drag.guides || []) {
    const o = g.o;
    const d = g.axis === 'x'
      ? `M${g.v} ${Math.min(b.y, o.y) - 12}V${Math.max(b.y + b.h, o.y + o.h) + 12}`
      : `M${Math.min(b.x, o.x) - 12} ${g.v}H${Math.max(b.x + b.w, o.x + o.w) + 12}`;
    el('path', { d, class: 'wm-guide', 'stroke-width': 1 * s }, chrome);
  }
}

// Align and distribute, for a multi-selection. Alignment lines everything up
// with the selection's own outer edge or centre; distribution fixes the two
// outermost blocks and spaces the rest evenly between them.
function alignSelection(how) {
  const nodes = selectedNodes();
  const needs = how.startsWith('dist') ? 3 : 2;
  if (nodes.length < needs) return 'select ' + needs + ' or more blocks first';
  pushUndo();
  const b = boundsOf(nodes);
  const first = nodeById(model, [...sel].find((id) => nodeById(model, id))) || nodes[0];
  for (const n of nodes) {
    if (how === 'left') n.x = b.x;
    if (how === 'center') n.x = Math.round(b.x + b.w / 2 - n.w / 2);
    if (how === 'right') n.x = b.x + b.w - n.w;
    if (how === 'top') n.y = b.y;
    if (how === 'middle') n.y = Math.round(b.y + b.h / 2 - n.h / 2);
    if (how === 'bottom') n.y = b.y + b.h - n.h;
    // Same size as the block selected first, the way PowerPoint does it.
    if (how === 'size') { n.w = first.w; n.h = first.h; }
  }
  if (how === 'dist-h' || how === 'dist-v') {
    const [pos, len] = how === 'dist-h' ? ['x', 'w'] : ['y', 'h'];
    const sorted = nodes.slice().sort((p, q) => (p[pos] + p[len] / 2) - (q[pos] + q[len] / 2));
    const total = sorted.reduce((sum, n) => sum + n[len], 0);
    const gap = (b[len] - total) / (sorted.length - 1);
    let at = b[pos];
    for (const n of sorted) { n[pos] = Math.round(at); at += n[len] + gap; }
  }
  commit();
  return null;
}

function startMove(p) {
  const nodes = selectedNodes();
  drag = {
    mode: 'move', start: p, nodes, bounds: boundsOf(nodes), guides: [],
    boxes: nodes.map((m) => ({ n: m, x: m.x, y: m.y })),
    riders: riders(new Set(nodes.map((m) => m.id))),
    // Group membership and boxes as they were at pointerdown. Every move
    // re-decides membership from these, so a block dragged out of a group and
    // back in again ends up where it started.
    members: model.groups.map((g) => [g, g.members.slice()]),
    groupBoxes: groupBoxes(),
  };
}

// Esc mid-gesture puts everything back the way it was, as it does everywhere
// else.
function cancelDrag() {
  const d = drag;
  drag = null;
  if (d.mode === 'pan') { view.x = d.vx; view.y = d.vy; onView(); }
  if (d.mode === 'marquee') sel = d.base;
  if (d.undoPushed) model = JSON.parse(undoStack.pop());
  svg.style.cursor = 'default';
  render();
  notify();
}

// A label editor is positioned in screen pixels over its block, so anything
// that moves the view has to close it first or it drifts off the block. The
// textarea's own commit runs on blur; `wmFinish` covers the case where it
// never had focus, so blur can't fire.
function commitOpenEditor() {
  const open = host.querySelector('.wm-label-input');
  if (!open) return;
  open.blur();
  if (open.isConnected && open.wmFinish) open.wmFinish();
}

// Undo is snapshotted on the first movement rather than on pointerdown, so a
// click that never turns into a drag doesn't fill the stack with no-ops.
function ensureUndo() {
  if (drag.undoPushed) return;
  drag.undoPushed = true;
  pushUndo();
}

function onPointerMove(ev) {
  if (!drag) {
    if (pendingConnect) return;
    const p = toModel(ev);
    // Ports show as you approach a block, not only once the pointer is inside
    // it, so the connection dots are already there when you reach for them.
    const near = nodeAt(p, 18 / view.zoom);
    const hoverChanged = near !== hoverNode;
    hoverNode = near;
    if (armedShape) ghost = { shape: armedShape, p };
    if (hoverChanged || armedShape) render();
    svg.style.cursor = armedShape ? 'crosshair'
      : nodeAt(p) ? 'move' : legCursor(p) || (groupAt(p) ? 'move' : 'grab');
    return;
  }
  const p = toModel(ev);

  if (drag.mode === 'pan') {
    view.x = drag.vx + (ev.clientX - drag.sx);
    view.y = drag.vy + (ev.clientY - drag.sy);
    viewTouched = true;
    render();
    onView();
    return;
  }
  if (drag.mode === 'marquee') {
    drag.cur = p;
    const b = marqueeBox(drag);
    sel = new Set(drag.base);
    for (const n of model.nodes) {
      if (n.x < b.x + b.w && n.x + n.w > b.x && n.y < b.y + b.h && n.y + n.h > b.y) sel.add(n.id);
    }
    render();
    return;
  }
  if (drag.mode === 'connect' || drag.mode === 'reattach') {
    drag.cur = p;
    drag.over = nodeAt(p, 10 / view.zoom);
    render();
    return;
  }

  ensureUndo();
  if (drag.mode === 'move') {
    let rx = p.x - drag.start.x;
    let ry = p.y - drag.start.y;
    // Shift locks the drag to whichever axis it's mostly moving along.
    let lockX = false;
    let lockY = false;
    if (ev.shiftKey) { if (Math.abs(rx) > Math.abs(ry)) { ry = 0; lockY = true; } else { rx = 0; lockX = true; } }
    const { gx, gy, guides } = alignGuides(snap(rx), snap(ry), lockX, lockY);
    drag.guides = guides;
    // A guided axis moves by exactly the aligning amount; an unguided one
    // snaps to the grid as before.
    const dx = gx != null ? gx : snap(rx);
    const dy = gy != null ? gy : snap(ry);
    for (const b of drag.boxes) {
      b.n.x = gx != null ? b.x + dx : snap(b.x + dx);
      b.n.y = gy != null ? b.y + dy : snap(b.y + dy);
    }
    for (const r of drag.riders) r.e.points = r.points.map((q) => ({ x: q.x + dx, y: q.y + dy }));
    for (const [g, members] of drag.members) g.members = members.slice();
    regroup(drag.nodes, drag.groupBoxes);
    // Not refitGroups: that drops groups that have emptied, and a group
    // emptied halfway through a drag has to be able to come back.
    for (const g of model.groups) fitGroup(model, g);
    render();
    return;
  }
  if (drag.mode === 'segment') {
    // Rebuilt from the route as it was at pointerdown on every move, never
    // accumulated, so a long drag can't drift.
    const { route, k, axis } = drag;
    const q = route.raw.map((pt) => ({ ...pt }));
    const c = snap(p[axis]);
    q[k][axis] = c;
    q[k + 1][axis] = c;
    // Only the bends are stored. The stub ends are re-derived from the blocks
    // at render, and a moved one stays behind as a bend -- that is the jog.
    const bends = simplify([route.a0].concat(q.slice(1, -1), [route.b0])).slice(1, -1);
    drag.edge.points = bends.length ? bends : null;
    // Pin the ports the path was drawn against, so adding another connector
    // to the same side can't re-space this one out from under its bends.
    drag.edge.fromAnchor = drag.edge.fromAnchor || { ...route.from };
    drag.edge.toAnchor = drag.edge.toAnchor || { ...route.to };
    render();
    return;
  }
  if (drag.mode === 'resize') {
    const b = drag.box;
    const c = drag.corner;
    const wire = LABELLESS.has(drag.node.shape);
    const minW = wire ? MIN_WIRE : MIN_W;
    const minH = wire ? MIN_WIRE : MIN_H;
    let w = c.includes('e') ? b.w + (p.x - drag.start.x) : (c.includes('w') ? b.w - (p.x - drag.start.x) : b.w);
    let h = c.includes('s') ? b.h + (p.y - drag.start.y) : (c.includes('n') ? b.h - (p.y - drag.start.y) : b.h);
    if (ev.shiftKey && c.length === 2) {
      // Shift on a corner keeps the proportions, as in PowerPoint and Miro.
      // Not snapped, because snapping each side separately would undo it.
      const k = Math.max(w / b.w, h / b.h, minW / b.w, minH / b.h);
      w = Math.round(b.w * k);
      h = Math.round(b.h * k);
    } else {
      // Only the sides this handle actually drags get snapped -- snapping the
      // other one too would make widening a 56px-tall block also change its
      // height to 60. Wiring symbols aren't snapped at all; a 10px grid is
      // coarser than the symbol.
      const s = wire ? Math.round : snap;
      if (c.includes('e') || c.includes('w')) w = Math.max(minW, s(w));
      if (c.includes('n') || c.includes('s')) h = Math.max(minH, s(h));
    }
    drag.node.w = w;
    drag.node.h = h;
    drag.node.x = c.includes('w') ? b.x + b.w - w : b.x;
    drag.node.y = c.includes('n') ? b.y + b.h - h : b.y;
    refitGroups();
    render();
  }
}

function onPointerUp(ev) {
  if (!drag) return;
  const d = drag;
  drag = null;

  if (d.mode === 'connect') { finishConnect(d, ev); return; }
  if (d.mode === 'reattach') { finishReattach(d, ev); return; }
  if (d.mode === 'marquee') { render(); notify(); return; }
  if (d.mode === 'pan') {
    // Hover is re-read where the pointer came to rest, rather than left over
    // from wherever it was when the pan began.
    hoverNode = nodeAt(toModel(ev), 18 / view.zoom);
    svg.style.cursor = 'default';
    render();
    return;
  }
  if (d.undoPushed) { commit(); return; }
  // A click that never became a drag: now it's safe to shrink the selection.
  if (d.onRelease === 'deselect') sel.delete(d.hit);
  if (d.onRelease === 'only') sel = new Set([d.hit]);
  render();
  if (d.onRelease) notify();
}

function finishConnect(d, ev) {
  const p = toModel(ev);
  // A click on a dot, with no drag: Miro's quick-create. A new block of the
  // same shape appears in that direction, already wired up.
  if (Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) < 4) {
    const shape = nextShapeAfter(d.from);
    const [w, h] = shape === d.from.shape ? [d.from.w, d.from.h] : defaultSize(shape);
    const dir = DIRS[d.anchor.side];
    const reach = QUICK_GAP + (dir.x ? (d.from.w + w) / 2 : (d.from.h + h) / 2);
    const fc = centerOf(d.from);
    addConnected(d.from, d.anchor, shape, { x: fc.x + dir.x * reach, y: fc.y + dir.y * reach });
    return;
  }
  const target = nodeAt(p, 10 / view.zoom);
  if (target === d.from) { render(); return; }
  if (target) {
    // The landing port is pinned only if you actually aimed at one; otherwise
    // the side stays automatic so the connector follows the block around.
    const landed = nearestPort(target, p, 16 / view.zoom);
    pushUndo();
    const e = newEdge(d.from.id, target.id);
    e.fromAnchor = { side: d.anchor.side, t: d.anchor.t };
    e.toAnchor = landed ? { side: landed.side, t: landed.t } : null;
    model.edges.push(e);
    commit();
    return;
  }
  // Letting go over empty canvas asks which block to create there -- Miro's
  // shape picker -- rather than throwing the gesture away. Without a picker
  // (the tests), it creates the source's shape directly.
  const suggested = nextShapeAfter(d.from);
  if (!onPickShape) { addConnected(d.from, d.anchor, suggested, p); return; }
  pendingConnect = { from: d.from, anchor: d.anchor, origin: d.origin, cur: p, over: null };
  render();
  onPickShape(ev.clientX, ev.clientY, suggested, (shape) => {
    const pc = pendingConnect;
    pendingConnect = null;
    if (shape && model.nodes.includes(pc.from)) addConnected(pc.from, pc.anchor, shape, pc.cur);
    else render();
  });
}

// Dropping a connector's end on another block moves that end there. The old
// bends were drawn for the old block, so the path goes back to automatic.
function finishReattach(d, ev) {
  const p = toModel(ev);
  const target = nodeAt(p, 10 / view.zoom);
  const other = d.end === 'from' ? d.edge.to : d.edge.from;
  if (!target || target.id === other || !model.edges.includes(d.edge)) { render(); return; }
  const landed = nearestPort(target, p, 16 / view.zoom);
  pushUndo();
  d.edge[d.end] = target.id;
  d.edge[d.end + 'Anchor'] = landed ? { side: landed.side, t: landed.t } : null;
  d.edge.points = null;
  commit();
}

// Zoom keeps the point under the cursor fixed, so the canvas grows and shrinks
// around whatever you are looking at instead of drifting off.
function zoomAround(next, anchor) {
  const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
  view.x -= anchor.x * (z - view.zoom);
  view.y -= anchor.y * (z - view.zoom);
  view.zoom = z;
  viewTouched = true;
  render();
  onView();
}

// Scrolling scrolls and Ctrl+scroll zooms, as in Word, PowerPoint and Figma.
// A trackpad pinch arrives as a ctrl+wheel event in every browser, so the same
// test covers pinch-to-zoom -- and a two-finger swipe on a Mac trackpad pans
// instead of zooming wildly, which is what made plain-wheel zoom unusable
// there.
function onWheel(ev) {
  ev.preventDefault();
  commitOpenEditor();
  // deltaMode 1 is lines (Firefox, some mice); everything else is pixels.
  const unit = ev.deltaMode === 1 ? 16 : 1;
  if (ev.ctrlKey || ev.metaKey) {
    // Clamped per event: a mouse notch is ~100, a pinch step ~2-10, and both
    // need to feel like a sensible zoom increment.
    const d = Math.max(-30, Math.min(30, ev.deltaY * unit));
    zoomAround(view.zoom * Math.exp(-d * 0.01), toModel(ev));
    return;
  }
  // Shift+wheel scrolls sideways on a mouse with no horizontal wheel.
  const sideways = ev.shiftKey && !ev.deltaX;
  view.x -= (sideways ? ev.deltaY : ev.deltaX) * unit;
  view.y -= (sideways ? 0 : ev.deltaY) * unit;
  viewTouched = true;
  render();
  onView();
}

function canvasCenter() {
  const r = svg.getBoundingClientRect();
  return { x: (r.width / 2 - view.x) / view.zoom, y: (r.height / 2 - view.y) / view.zoom };
}

function zoomBy(factor) { commitOpenEditor(); zoomAround(view.zoom * factor, canvasCenter()); }
function getZoom() { return view.zoom; }
function isDragging() { return !!drag || !!pendingConnect; }

// Right-click selects whatever is under the pointer first, so the menu the
// shell builds is always about the thing you aimed at.
function onContext(ev) {
  ev.preventDefault();
  if (pendingConnect) return;
  const p = toModel(ev);
  menuPoint = p;
  armedShape = null;
  ghost = null;
  const n = nodeAt(p, 6 / view.zoom);
  if (n) {
    if (!sel.has(n.id)) { sel = new Set([n.id]); }
    selEdge = -1;
  } else {
    // Same order as a left click: a connector inside a group is the
    // connector, not the group.
    const ei = edgeAt(p);
    const g = ei >= 0 ? null : groupAt(p);
    if (ei >= 0) { sel = new Set(); selEdge = ei; }
    else if (g) { sel = new Set([g.id]); selEdge = -1; }
    else { sel = new Set(); selEdge = -1; }
  }
  render();
  notify();
  onMenu(ev.clientX, ev.clientY);
}

function lastMenuPoint() { return menuPoint; }

function onDoubleClick(ev) {
  const p = toModel(ev);
  const n = nodeAt(p, 6 / view.zoom);
  if (n) { beginLabelEdit(n); return; }
  const ei = edgeAt(p);
  if (ei >= 0) { selEdge = ei; sel = new Set(); render(); editEdgeLabel(ei); return; }
  const g = groupAt(p);
  if (g && p.y <= g.y + GROUP_TITLE_H) beginLabelEdit(g);
  // Double-clicking empty canvas does nothing. It used to create a block,
  // which mostly meant stray "Block" boxes left behind by a double-click that
  // was only meant to select or zoom. New blocks come from the palette, from
  // clicking a dot, or from right-click -> Add block here.
}

// An edge has no box to hang the editor on, so one is synthesised over the
// spot the label is drawn.
function editEdgeLabel(index) {
  const pts = edgeGeometry(model)[index];
  if (!pts) return;
  const mid = longestSegmentMidpoint(pts);
  beginLabelEdit(model.edges[index], undefined, { x: mid.x - 70, y: mid.y - 16, w: 140, h: 32 });
}

// A textarea rather than an input so labels can wrap onto two lines, which
// block diagrams need constantly. Enter commits; Shift+Enter is a line break.
// `seed` is the character that triggered the edit when you just start typing
// over a selected block. `box` overrides where the editor is placed, for
// things (edges) that have no box of their own.
function beginLabelEdit(item, seed, box) {
  if (item.shape && LABELLESS.has(item.shape)) return;   // a junction dot has no text to edit
  // Commit whatever was already open rather than refusing: double-clicking
  // straight from one block to the next has to just work. blur() only fires if
  // it still had focus, so remove it outright afterwards -- a stranded overlay
  // sitting over the canvas is the worst outcome here.
  commitOpenEditor();

  // A group's name is edited in its title tab, not over the whole group --
  // a text box the size of the group, with the name floating in the middle
  // of it, reads as broken.
  const isGroup = !!item.members;
  if (isGroup && !box) box = { x: item.x, y: item.y - 4, w: Math.min(item.w, 240), h: GROUP_TITLE_H + 8 };
  const b = box || item;
  const fontSize = item.fontSize || (item.from ? DEFAULT_EDGE_FONT : DEFAULT_FONT_SIZE);
  const size = fontSize * view.zoom;
  const lh = lineH(fontSize) * view.zoom;
  const boxH = Math.max(30, (b.h || 32) * view.zoom);
  const rows = Math.max(1, String(item.label || '').split('\n').length);

  const input = document.createElement('textarea');
  input.className = 'wm-label-input';
  input.value = seed != null ? seed : item.label;
  input.style.left = (view.x + b.x * view.zoom) + 'px';
  input.style.top = (view.y + b.y * view.zoom) + 'px';
  input.style.width = Math.max(90, b.w * view.zoom) + 'px';
  input.style.height = boxH + 'px';
  input.style.fontSize = Math.max(11, size) + 'px';
  if (item.bold) input.style.fontWeight = 'bold';
  // Textareas top-align their text; pad it down so the text sits where it will
  // sit once committed instead of jumping when the editor closes.
  input.style.paddingTop = Math.max(2, (boxH - rows * lh) / 2) + 'px';
  if (isGroup) input.style.textAlign = 'left';
  host.appendChild(input);
  input.focus();
  if (seed != null) input.setSelectionRange(input.value.length, input.value.length);
  else input.select();

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    input.remove();
    // Undo, a load or a delete may have replaced the object while the editor
    // was open; writing to the orphan would silently go nowhere.
    const live = model.nodes.includes(item) || model.edges.includes(item) || model.groups.includes(item);
    if (live && input.value !== item.label) {
      pushUndo();
      item.label = input.value;
      if (item.shape) fitNodeSize(item);
      commit();
    }
  };
  input.wmFinish = finish;
  input.addEventListener('blur', finish);
  // Esc keeps what you typed and just stops editing, as it does in Word,
  // PowerPoint and Miro -- throwing away a label you just typed because you
  // reached for the key that means "done" is the worst surprise available.
  // Ctrl+Z takes it back.
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if ((ev.key === 'Enter' && !ev.shiftKey) || ev.key === 'Escape') { ev.preventDefault(); finish(); }
  });
}

function editSelectedLabel(seed) {
  if (selEdge >= 0 && model.edges[selEdge]) {
    if (seed != null) return false;   // typing over an edge would be a surprise
    editEdgeLabel(selEdge);
    return true;
  }
  if (sel.size !== 1) return false;
  const item = nodeById(model, [...sel][0]) || model.groups.find((g) => sel.has(g.id));
  if (!item || (item.shape && LABELLESS.has(item.shape))) return false;
  beginLabelEdit(item, seed);
  return true;
}

// Word claims keys that reach the host, so everything handled here is also
// stopped from propagating.
function onKeyDown(ev) {
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (!ev.key) return;            // IME composition and some synthetic events
  // The canvas is hidden while the Mermaid tab is showing; Delete there must
  // not quietly delete blocks nobody can see.
  if (!host.offsetParent) return;
  if (pendingConnect) return;     // the shape picker handles its own keys
  const eat = () => { ev.preventDefault(); ev.stopPropagation(); };
  if (drag && ev.key === 'Escape') { eat(); cancelDrag(); return; }
  const ctrl = ev.ctrlKey || ev.metaKey;
  const k = ev.key.toLowerCase();

  // Miro's view shortcuts. Matched on the physical key, since Shift+1 is
  // reported as "!" -- and ahead of type-to-rename, which would otherwise
  // start editing a block with a "!".
  if (ev.shiftKey && !ctrl && ev.code === 'Digit1') { eat(); fitView(true); return; }
  if (ev.shiftKey && !ctrl && ev.code === 'Digit0') { eat(); zoomBy(1 / view.zoom); return; }
  if (ctrl && (k === '=' || k === '+')) { eat(); zoomBy(1.25); return; }
  if (ctrl && k === '-') { eat(); zoomBy(0.8); return; }
  if (ctrl && k === '0') { eat(); zoomBy(1 / view.zoom); return; }

  if (ev.key === 'Enter' || ev.key === 'F2') {
    if (editSelectedLabel()) eat();
  } else if (ctrl && ev.altKey && k === 'c') { eat(); copyStyle(); }
  else if (ctrl && ev.altKey && k === 'v') { eat(); pasteStyle(); }
  else if (ctrl && k === 'c') { eat(); copySelection(); }
  else if (ctrl && k === 'x') { eat(); if (copySelection()) deleteSelection(); }
  else if (ctrl && k === 'v') { eat(); pasteNext(); }
  else if (ctrl && k === 'd') { eat(); duplicateSelection(); }
  else if (ctrl && k === 'a') { eat(); selectAll(); }
  else if (ctrl && k === 'b') { eat(); toggleBold(); }
  else if (ctrl && k === 'g') { eat(); ev.shiftKey ? ungroupSelection() : groupSelection(); }
  else if (ctrl && k === 'z') { eat(); ev.shiftKey ? redo() : undo(); }
  else if (ctrl && k === 'y') { eat(); redo(); }
  else if (!ctrl && !ev.altKey && ev.key.length === 1 && ev.key !== ' ') {
    // Typing over a selected block replaces its text, the way it works in
    // every other diagram tool.
    if (editSelectedLabel(ev.key)) eat();
  } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
    eat();
    deleteSelection();
  } else if (ev.key.startsWith('Arrow') && sel.size) {
    const step = ev.shiftKey ? 1 : GRID;
    const dx = (ev.key === 'ArrowRight' ? step : 0) - (ev.key === 'ArrowLeft' ? step : 0);
    const dy = (ev.key === 'ArrowDown' ? step : 0) - (ev.key === 'ArrowUp' ? step : 0);
    if (dx || dy) {
      eat();
      const moving = riders(new Set(selectedNodes().map((n) => n.id)));
      applyToNodes((n) => { n.x += dx; n.y += dy; });
      // applyToNodes took the undo snapshot before moving anything, so
      // shifting the riders afterwards still lands in that same undo step.
      for (const r of moving) r.e.points = r.points.map((q) => ({ x: q.x + dx, y: q.y + dy }));
      render(); notify();
    }
  } else if (ev.key === 'Escape') {
    sel = new Set(); selEdge = -1; armedShape = null; ghost = null;
    render(); notify();
  }
}

// --- API used by the taskpane shell -------------------------------------

// `noUndo` for the diagram the pane starts with: Ctrl+Z straight after opening
// the add-in must not empty the canvas.
function setModel(d, noUndo) {
  if (!noUndo) pushUndo();
  model = d;
  sel = new Set();
  selEdge = -1;
  refitGroups();
  render();
}

function getModel() { return model; }

function armShape(shape) {
  armedShape = shape;
  if (!shape) { ghost = null; render(); }
}

function selectionInfo() {
  const nodes = [...sel].map((id) => nodeById(model, id)).filter(Boolean);
  return {
    nodes,
    groups: model.groups.filter((g) => sel.has(g.id)),
    // The group the selected blocks sit in, when they all share one -- the
    // shell names it, and offers to take them out of it.
    group: nodes.length && nodes.every((n) => groupOf(n.id) && groupOf(n.id) === groupOf(nodes[0].id))
      ? groupOf(nodes[0].id) : null,
    inGroup: model.groups.some((g) => g.members.some((m) => sel.has(m))),
    edge: selEdge >= 0 ? model.edges[selEdge] || null : null,
    allGroups: model.groups,
  };
}

// Where the selection is on screen, relative to the canvas host, so the shell
// can float its toolbar over it. Null when nothing is selected.
function selectionScreenBox() {
  let b = null;
  if (selEdge >= 0 && model.edges[selEdge]) {
    const pts = edgeGeometry(model)[selEdge];
    if (pts) b = boundsOf(pts.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })));
  } else {
    b = boundsOf([...sel].map((id) => nodeById(model, id) || model.groups.find((g) => g.id === id)).filter(Boolean));
  }
  if (!b) return null;
  return { x: view.x + b.x * view.zoom, y: view.y + b.y * view.zoom, w: b.w * view.zoom, h: b.h * view.zoom };
}

// Never zooms past 1:1. Blowing a two-block diagram up to fill the pane looks
// broken. The automatic fit also stops at half size, below which labels are
// unreadable and it's better to clip and let the user pan -- but pressing Fit
// is an explicit request to see all of it (`everything`), and a Fit that still
// leaves blocks off-screen reads as broken.
function fitView(everything) {
  const r = host.getBoundingClientRect();
  viewTouched = false;
  if (!model.nodes.length) { view = { x: 40, y: 40, zoom: 1 }; render(); onView(); return; }
  const b = diagramBounds(model);
  const pad = 24;
  const floor = everything ? MIN_ZOOM : 0.5;
  view.zoom = Math.max(floor, Math.min((r.width - pad * 2) / b.w, (r.height - pad * 2) / b.h, 1));
  view.x = (r.width - b.w * view.zoom) / 2 - b.x * view.zoom;
  view.y = (r.height - b.h * view.zoom) / 2 - b.y * view.zoom;
  render();
  onView();
}
