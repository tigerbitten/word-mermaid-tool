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
const CONNECT_BAND = 12;  // screen px outside a block's edge from which dragging starts a line
const ALIGN_SNAP = 8;     // screen px within which a dropped line end snaps level with its other end
const LINE_LEN = 160;     // a line dropped from the palette
const ATTACH_NEAR = 14;   // screen px from a block's edge within which an end attaches at that exact spot

const EDITOR_STYLE = `
  .wm-canvas { width: 100%; height: 100%; display: block; background: #fff; touch-action: none; }
  .wm-selbox { fill: none; stroke: #2563eb; }
  .wm-multibox { fill: none; stroke: #2563eb; stroke-dasharray: 5 4; }
  .wm-hover { fill: none; stroke: #93b4f5; }
  .wm-seledge { fill: none; stroke: #2563eb; opacity: 0.35; }
  .wm-connect { fill: #2563eb; stroke: #fff; pointer-events: none; }
  .wm-handle { fill: #fff; stroke: #2563eb; }
  .wm-endhandle { fill: #2563eb; stroke: #fff; cursor: move; }
  .wm-marquee { fill: #2563eb; fill-opacity: 0.08; stroke: #2563eb; stroke-dasharray: 4 3; }
  .wm-droptarget { fill: none; stroke: #16a34a; }
  .wm-seghandle { fill: #fff; stroke: #2563eb; pointer-events: none; }
  .wm-group-sel { fill: none; stroke: #2563eb; }
  .wm-group-join { fill: #16a34a; fill-opacity: 0.06; stroke: #16a34a; }
  .wm-member { fill: #2563eb; fill-opacity: 0.07; stroke: #2563eb; stroke-opacity: 0.55; }
  .wm-ghost { fill: #2563eb; fill-opacity: 0.06; stroke: #2563eb; stroke-dasharray: 4 3; }
  .wm-guide { fill: none; stroke: #e11d74; }
  .wm-attach { fill: #16a34a; stroke: #fff; stroke-width: 1.5; pointer-events: none; }
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
let connectSpot = null;   // where a line would start from, while the pointer is in a block's edge band
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
    place(payload.slice(9), toModel(ev));
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

// Where a new line would start if the pointer pressed here: a thin band just
// outside a block's outline, any point along any edge. No dots are shown on a
// block; being in the band is signalled by a crosshair and a single marker at
// the exact spot. Inside the block is for moving it; on a line is for the line.
function connectSpotAt(p) {
  if (nodeAt(p)) return null;
  const band = CONNECT_BAND / view.zoom;
  const n = nodeAt(p, band);
  if (!n || edgeAt(p) >= 0) return null;
  const hit = nearestOnOutline(n, p);
  // Past a circle's curve but still inside its bounding box's band, the real
  // outline can be much further away than the band; that's not "at the edge".
  if (hit.dist > band * 1.6) return null;
  return { node: n, side: hit.side, t: hit.t, at: hit.at };
}

// A line with both ends loose -- dropped from the palette and not yet attached.
function freeLine(e) {
  return isPoint(nodeById(model, e.from)) && isPoint(nodeById(model, e.to));
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

  // Dragging a line end: the line itself follows the pointer (it is really in
  // the model), so all that's added is the block it would attach to, and --
  // when it's close enough to the edge to attach at an exact spot -- that spot.
  if (drag && drag.mode === 'end') {
    if (drag.over) outline(drag.over, 3 * s, 'wm-droptarget', 2.5 * s);
    if (drag.attachAt) el('circle', { cx: drag.attachAt.x, cy: drag.attachAt.y, r: 4.5 * s, class: 'wm-attach' }, chrome);
  }

  // The one marker for starting a line: where it would begin, if the pointer
  // is in a block's edge band. Nothing mid-gesture or with the picker open.
  if (connectSpot && !drag && !pendingConnect) {
    el('circle', { cx: connectSpot.at.x, cy: connectSpot.at.y, r: 4 * s, class: 'wm-connect', 'stroke-width': 1.5 * s }, chrome);
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
  // A straight line has no legs to drag, and a line attached to nothing is
  // dragged whole -- neither gets leg grips.
  if (e.route === 'straight' || freeLine(e)) { drawEndHandles(pts, s); return; }
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

// The two ends: drag one onto another block to reconnect it, as in Miro, or
// into empty space to leave it loose.
function drawEndHandles(pts, s) {
  if (drag && drag.mode === 'end') return;
  for (const [end, p] of [['from', pts[0]], ['to', pts[pts.length - 1]]]) {
    el('circle', {
      cx: p.x, cy: p.y, r: 6 * s, class: 'wm-endhandle', 'stroke-width': 2 * s,
      'data-role': 'edge-end', 'data-end': end,
    }, chrome);
  }
}

function drawGhost(shape, p) {
  if (shape.startsWith('line:')) {
    el('path', { d: `M${p.x - LINE_LEN / 2} ${p.y}H${p.x + LINE_LEN / 2}`, class: 'wm-ghost',
                 'stroke-width': 2 / view.zoom, style: 'pointer-events:none' }, chrome);
    return;
  }
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

// Loose line ends are nodes in the model but not things you can click: they
// are picked up through the line's end handles instead.
function nodeAt(p, margin) {
  const m = margin || 0;
  for (let i = model.nodes.length - 1; i >= 0; i--) {
    const n = model.nodes[i];
    if (isPoint(n)) continue;
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
function regroup(all, boxes) {
  const nodes = all.filter((n) => !isPoint(n));      // a loose line end belongs to no group
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

// A loose line end with no line left using it (the line was deleted, or its
// end was attached to a block instead) is dropped.
function dropStrayPoints() {
  const used = new Set(model.edges.flatMap((e) => [e.from, e.to]));
  model.nodes = model.nodes.filter((n) => !isPoint(n) || used.has(n.id));
}

function commit() {
  dropStrayPoints();
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

// A free-standing line from the palette, the way Miro's line tool drops one:
// two loose ends, straight, selected so its ends are ready to drag onto blocks.
function addLine(kind, c) {
  pushUndo();
  const a = makeNode('point', { x: c.x - LINE_LEN / 2, y: c.y });
  const b = makeNode('point', { x: c.x + LINE_LEN / 2, y: c.y });
  const e = newEdge(a.id, b.id);
  e.route = 'straight';
  e.head = kind === 'arrow' ? 'end' : 'none';
  model.edges.push(e);
  sel = new Set();
  selEdge = model.edges.length - 1;
  commit();
}

// The Arrow / Line tool, click-click: the first click fixes where the line
// starts -- the exact spot on a block's edge when it's on or beside a block,
// else a loose end there -- and the line then follows the pointer until a
// second click fixes the other end the same way. It is the ordinary
// end-dragging code (moveEnd), just without the button held down.
function startTwoClick(kind, p, ev) {
  pushUndo();
  const block = nodeAt(p, CONNECT_BAND / view.zoom);
  let from;
  let fromAnchor = null;
  if (block) {
    const hit = nearestOnOutline(block, p);
    from = block;
    fromAnchor = { side: hit.side, t: hit.t };
  } else {
    from = makeNode('point', p);
  }
  const end = makeNode('point', p);
  const e = newEdge(from.id, end.id);
  e.fromAnchor = fromAnchor;
  e.route = 'straight';
  e.head = kind === 'arrow' ? 'end' : 'none';
  model.edges.push(e);
  sel = new Set();
  selEdge = model.edges.length - 1;
  connectSpot = null;
  drag = { mode: 'end', edge: e, end: 'to', point: end, undoPushed: true, twoClick: true, sx: ev.clientX, sy: ev.clientY };
  render();
}

function finishTwoClick(ev) {
  moveEnd(ev, toModel(ev));
  // A second click on top of the first has nothing to draw between them.
  if (Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy) < 4) { cancelDrag(); return; }
  drag = null;
  commit();
}

// Whatever the palette hands over: a shape, or `line:arrow` / `line:plain`.
function place(shape, c) {
  if (shape.startsWith('line:')) addLine(shape.slice(5), c);
  else addNode(shape, c);
}

// The same shape comes out the same size as its source, so a chain built by
// clicking dots is a row of matching blocks rather than a ragged one.
function matchSize(n, from, c) {
  if (!from || n.shape !== from.shape || LABELLESS.has(n.shape)) return;
  n.x = snap(c.x - from.w / 2);
  n.y = snap(c.y - from.h / 2);
  n.w = from.w;
  n.h = from.h;
}

// What the shape picker offers first after drawing a line out of `n`: the
// same shape, which is what you almost always want next in a chain.
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

// For the selected group boundaries themselves (their title size), as opposed
// to applyToNodes, which reaches through a selected group to its blocks.
function applyToGroups(fn) {
  const groups = model.groups.filter((g) => sel.has(g.id));
  if (!groups.length) return;
  pushUndo();
  groups.forEach(fn);
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
  sel = new Set(model.nodes.filter((n) => !isPoint(n)).map((n) => n.id));
  selEdge = -1;
  render();
  notify();
}

// --- clipboard ----------------------------------------------------------
//
// Internal, not the system clipboard: navigator.clipboard is blocked inside
// Word's task pane iframe, and pasting a picture of a block would be useless
// anyway. Edges come along only when both of their ends do.

// A selected line copies as a free-standing line: an end attached to a block
// becomes a loose end at the same spot, since the block isn't being copied.
function copyLine() {
  const e = model.edges[selEdge];
  const pts = edgeGeometry(model)[selEdge];
  if (!e || !pts || pts.length < 2) return false;
  const ends = [['from', pts[0]], ['to', pts[pts.length - 1]]].map(([end, at]) => {
    const n = nodeById(model, e[end]);
    return isPoint(n) ? n : { id: '_' + end, label: '', shape: 'point', x: at.x, y: at.y, w: 0, h: 0,
                              fill: '#ffffff', fontSize: DEFAULT_FONT_SIZE, bold: false };
  });
  const copy = { ...e, from: ends[0].id, to: ends[1].id, fromAnchor: null, toAnchor: null, points: null };
  clipboard = JSON.parse(JSON.stringify({ nodes: ends, edges: [copy], groups: [] }));
  clipboard.pastes = 0;
  return true;
}

function copySelection() {
  if (selEdge >= 0) return copyLine();
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
    // Loose line ends keep their exact offset; blocks land on the grid.
    n.x = isPoint(n) ? n.x + snap(dx) : snap(n.x + dx);
    n.y = isPoint(n) ? n.y + snap(dy) : snap(n.y + dy);
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
                   fontSize: g.fontSize, x: 0, y: 0, w: 0, h: 0 };
    taken.add(copy.id);
    model.groups.push(copy);
    madeGroups.push(copy.id);
  }
  // Pasted next to blocks in a group, loose copies join that group. Copies in
  // a pasted group of their own stay in it: regroup leaves whole groups alone.
  regroup(made.map((id) => nodeById(model, id)), boxes);
  const blocks = made.filter((id) => !isPoint(nodeById(model, id)));
  sel = new Set(blocks.filter((id) => !madeGroups.some((gid) =>
    model.groups.find((g) => g.id === gid).members.includes(id))).concat(madeGroups));
  // A pasted line on its own is selected as a line.
  selEdge = !blocks.length && clipboard.edges.length ? model.edges.length - 1 : -1;
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
  if (drag && drag.twoClick) { finishTwoClick(ev); return; }
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

  if (role === 'edge-end') {
    const e = model.edges[selEdge];
    if (!e) return;
    drag = { mode: 'end', edge: e, end: ev.target.getAttribute('data-end'), sx: ev.clientX, sy: ev.clientY };
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
    if (shape.startsWith('line:')) { startTwoClick(shape.slice(5), p, ev); return; }
    place(shape, p);
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
    const e = model.edges[ei];
    const route = edgeRoutes(model)[ei];
    const k = legAt(route, p);
    const ends = [nodeById(model, e.from), nodeById(model, e.to)];
    if (freeLine(e)) {
      // A line attached to nothing is picked up and moved whole, like any
      // other object on the board.
      drag = { mode: 'line', start: p, ends: ends.map((n) => ({ n, x: n.x, y: n.y })),
               bends: e.points ? e.points.map((q) => ({ ...q })) : null, edge: e };
    } else if (k >= 0) {
      const q = route.raw;
      const horizontal = Math.abs(q[k].y - q[k + 1].y) < 0.5;
      drag = { mode: 'segment', edge: model.edges[ei], route, k, axis: horizontal ? 'y' : 'x' };
    }
    render();
    notify();
    return;
  }

  // Just outside a block's edge: start a new line from that exact spot.
  // Nothing is created until the pointer actually moves (see moveEnd).
  const spot = connectSpotAt(p);
  if (spot) {
    drag = { mode: 'end', edge: null, end: 'to', from: spot.node, anchor: { side: spot.side, t: spot.t },
             sx: ev.clientX, sy: ev.clientY };
    connectSpot = null;
    render();
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
  if (freeLine(model.edges[ei])) return 'move';
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

// Where the far end of a line is, for angle snapping: a loose end's own spot,
// an attached end's exact spot, or the middle of a block it floats on.
function otherEndPoint(e, end) {
  const other = nodeById(model, end === 'from' ? e.to : e.from);
  const an = end === 'from' ? e.toAnchor : e.fromAnchor;
  if (isPoint(other)) return { x: other.x, y: other.y };
  return an && an.t != null ? anchorPoint(other, an.side, an.t) : centerOf(other);
}

function snapAngle(o, p) {
  const step = Math.PI / 4;
  const a = Math.round(Math.atan2(p.y - o.y, p.x - o.x) / step) * step;
  const dist = Math.hypot(p.x - o.x, p.y - o.y);
  return { x: o.x + Math.cos(a) * dist, y: o.y + Math.sin(a) * dist };
}

// Dragging a line end -- a brand-new line from a dot, or an existing line's
// end handle. The model is edited as the pointer moves, so the real line
// follows it live. Over a block the end attaches: at the exact spot if it's
// within a few pixels of the outline, otherwise floating on the block's best
// side. In empty space it becomes a loose end. Shift makes the line straight,
// and a loose end then snaps to 45-degree steps, as in Miro and PowerPoint.
function moveEnd(ev, p) {
  if (!drag.edge) {
    if (Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy) < 4) return;   // still just a click
    ensureUndo();
    const pt = makeNode('point', p);
    const e = newEdge(drag.from.id, pt.id);
    e.fromAnchor = { side: drag.anchor.side, t: drag.anchor.t };
    model.edges.push(e);
    drag.edge = e;
    drag.point = pt;
    drag.created = true;
  }
  ensureUndo();
  const e = drag.edge;
  const end = drag.end;
  const otherId = end === 'from' ? e.to : e.from;
  if (drag.point === undefined) {
    const n = nodeById(model, e[end]);
    drag.point = isPoint(n) ? n : null;
  }
  if (ev.shiftKey) e.route = 'straight';
  e.points = null;             // bends drawn for the old end mean nothing for the new one

  let target = nodeAt(p, ATTACH_NEAR / view.zoom);
  if (target && target.id === otherId) target = null;
  drag.over = target;
  drag.attachAt = null;
  if (target) {
    const hit = nearestOnOutline(target, p);
    const exact = hit.dist <= ATTACH_NEAR / view.zoom;
    // Dropped nearly level with the other end, it snaps level, so the
    // connector comes out dead straight instead of with a two-pixel jog.
    if (exact) {
      const o = otherEndPoint(e, end);
      const [pos, len] = hit.side === 'e' || hit.side === 'w' ? ['y', 'h'] : ['x', 'w'];
      const near = Math.abs(hit.at[pos] - o[pos]) <= ALIGN_SNAP / view.zoom;
      if (near && o[pos] > target[pos] + 2 && o[pos] < target[pos] + target[len] - 2) {
        hit.t = (o[pos] - target[pos]) / target[len];
        hit.at = anchorPoint(target, hit.side, hit.t);
      }
    }
    e[end] = target.id;
    e[end + 'Anchor'] = exact ? { side: hit.side, t: hit.t } : null;
    if (exact) drag.attachAt = hit.at;
  } else {
    // Reuse this drag's loose end if it has one -- attaching and detaching
    // again mid-drag mustn't pile up points.
    let pt = drag.point && model.nodes.includes(drag.point) ? drag.point : null;
    if (!pt) { pt = makeNode('point', p); drag.point = pt; }
    const q = ev.shiftKey ? snapAngle(otherEndPoint(e, end), p) : { x: snap(p.x), y: snap(p.y) };
    pt.x = q.x;
    pt.y = q.y;
    e[end] = pt.id;
    e[end + 'Anchor'] = null;
  }
  render();
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
    const near = nodeAt(p, CONNECT_BAND / view.zoom);
    // Over a resize handle or a line's end handle, those win; no line-start
    // marker competing with them.
    const role = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-role');
    // With the Arrow or Line tool picked, the marker shows where the line
    // will start: on the nearest edge when over or beside a block, else at the
    // pointer. Otherwise it's the ordinary start-a-line band.
    const lineTool = !!armedShape && armedShape.startsWith('line:');
    let spot = null;
    if (lineTool) {
      const b = nodeAt(p, CONNECT_BAND / view.zoom);
      const hit = b && nearestOnOutline(b, p);
      spot = b ? { node: b, side: hit.side, t: hit.t, at: hit.at } : { node: null, at: p };
    } else if (!armedShape && !role) {
      spot = connectSpotAt(p);
    }
    const spotChanged = !spot !== !connectSpot ||
      (spot && (spot.node !== connectSpot.node || Math.hypot(spot.at.x - connectSpot.at.x, spot.at.y - connectSpot.at.y) > 0.5));
    const hoverChanged = near !== hoverNode;
    hoverNode = near;
    connectSpot = spot;
    if (armedShape) ghost = lineTool ? null : { shape: armedShape, p };
    if (hoverChanged || spotChanged || armedShape) render();
    svg.style.cursor = armedShape || spot ? 'crosshair'
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
      if (isPoint(n)) continue;
      if (n.x < b.x + b.w && n.x + n.w > b.x && n.y < b.y + b.h && n.y + n.h > b.y) sel.add(n.id);
    }
    render();
    return;
  }
  if (drag.mode === 'end') { moveEnd(ev, p); return; }

  ensureUndo();
  if (drag.mode === 'line') {
    if (ev.shiftKey) drag.edge.route = 'straight';
    const dx = snap(p.x - drag.start.x);
    const dy = snap(p.y - drag.start.y);
    for (const b of drag.ends) { b.n.x = b.x + dx; b.n.y = b.y + dy; }
    if (drag.bends) drag.edge.points = drag.bends.map((q) => ({ x: q.x + dx, y: q.y + dy }));
    render();
    return;
  }
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
    // Shift while dragging a connector straightens it, as it does while
    // dragging a line end.
    if (ev.shiftKey) { drag.edge.route = 'straight'; render(); return; }
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
    // A side-only anchor (no position) counts as unpinned here.
    if (!drag.edge.fromAnchor || drag.edge.fromAnchor.t == null) drag.edge.fromAnchor = { ...route.from };
    if (!drag.edge.toAnchor || drag.edge.toAnchor.t == null) drag.edge.toAnchor = { ...route.to };
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
  if (drag.twoClick) return;     // a click-click line carries on past the first click's release
  const d = drag;
  drag = null;

  if (d.mode === 'end') { finishEnd(d, ev); return; }
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

function finishEnd(d, ev) {
  // A plain click just outside a block's edge, with no drag: select the block,
  // which is what a click that near it was almost certainly aiming for.
  if (!d.edge) {
    if (d.from) { sel = new Set([d.from.id]); selEdge = -1; notify(); }
    render();
    return;
  }
  if (!d.undoPushed) { render(); return; }      // an end handle pressed and released without moving
  const e = d.edge;
  const endNode = nodeById(model, e[d.end]);
  // A new line from a dot let go over empty canvas: Miro asks what block to
  // put there. The loose line is already real, so cancelling the picker just
  // leaves it -- nothing is thrown away. Without a picker (the tests) the
  // source's shape goes there directly.
  if (d.created && isPoint(endNode)) {
    const suggested = nextShapeAfter(d.from);
    if (!onPickShape) { blockAtEnd(e, endNode, suggested); return; }
    sel = new Set();
    selEdge = model.edges.indexOf(e);          // if the picker is cancelled, the line is left selected
    commit();
    pendingConnect = { edge: e, point: endNode };
    render();
    onPickShape(ev.clientX, ev.clientY, suggested, (shape) => {
      const pc = pendingConnect;
      pendingConnect = null;
      if (shape && model.edges.includes(pc.edge) && model.nodes.includes(pc.point)) blockAtEnd(pc.edge, pc.point, shape);
      else render();
    });
    return;
  }
  commit();
}

// Puts a new block where a line's loose end is and attaches the end to it.
// No undo step of its own: it finishes the gesture that drew the line.
function blockAtEnd(e, pt, shape) {
  const from = nodeById(model, e.from);
  const boxes = groupBoxes();
  const n = makeNode(shape, { x: pt.x, y: pt.y });
  matchSize(n, from, { x: pt.x, y: pt.y });
  regroup([n], boxes);
  e.to = n.id;
  e.toAnchor = null;
  sel = new Set([n.id]);
  selEdge = -1;
  commit();
  beginLabelEdit(n);
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

// For the shell: abandon whatever gesture is in progress, as Esc would. Used
// when the canvas is hidden -- a half-placed click-click line left running
// behind the Mermaid tab would otherwise finish on the next click back.
function cancelGesture() { if (drag) cancelDrag(); }

// Right-click selects whatever is under the pointer first, so the menu the
// shell builds is always about the thing you aimed at.
function onContext(ev) {
  ev.preventDefault();
  if (pendingConnect) return;
  if (drag && drag.twoClick) { cancelDrag(); return; }   // right-click abandons a half-placed line
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
  if (g && p.y <= g.y + groupTitleH(g)) beginLabelEdit(g);
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
  if (isGroup && !box) box = { x: item.x, y: item.y - 4, w: Math.max(groupTabWidth(item) + 40, Math.min(item.w, 240)), h: groupTitleH(item) + 8 };
  const b = box || item;
  const fontSize = item.fontSize || (isGroup ? GROUP_FONT_SIZE : item.from ? DEFAULT_EDGE_FONT : DEFAULT_FONT_SIZE);
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
  if (item.bold || isGroup) input.style.fontWeight = 'bold';     // group titles are always bold
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
