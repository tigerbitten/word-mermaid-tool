// Interaction: turns pointer events into model edits.
//
// The whole diagram is re-rendered after every change. Diagrams are small
// enough that this is instant, and it removes an entire class of stale-view
// bugs that incremental updates invite.

const GRID = 10;
const MIN_W = 60;
const MIN_H = 36;
const UNDO_DEPTH = 50;
const PORT_OUT = 12;      // screen px between a block's border and its connection dots

const EDITOR_STYLE = `
  .wm-canvas { width: 100%; height: 100%; display: block; background: #fff; touch-action: none; }
  .wm-selbox { fill: none; stroke: #2563eb; stroke-dasharray: 4 3; }
  .wm-seledge { fill: none; stroke: #2563eb; opacity: 0.35; }
  .wm-port { fill: #fff; stroke: #2563eb; cursor: crosshair; }
  .wm-handle { fill: #fff; stroke: #2563eb; }
  .wm-rubber { fill: none; stroke: #2563eb; stroke-dasharray: 4 3; }
  .wm-marquee { fill: #2563eb; fill-opacity: 0.08; stroke: #2563eb; stroke-dasharray: 4 3; }
  .wm-droptarget { fill: none; stroke: #16a34a; }
  .wm-seghandle { fill: #fff; stroke: #2563eb; pointer-events: none; }
`;

const PAGE_STYLE = `
  .wm-host { position: relative; overflow: hidden; background: #fff; }
  .wm-label-input { position: absolute; z-index: 5; box-sizing: border-box; text-align: center;
    font-family: Calibri, "Segoe UI", Helvetica, Arial, sans-serif; line-height: 1.25;
    border: 2px solid #2563eb; border-radius: 3px; padding: 3px 4px; outline: none;
    resize: none; overflow: hidden; background: #fff; color: #111;
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
let undoStack = [];
let redoStack = [];
let clipboard = null;
let menuPoint = { x: 0, y: 0 };

const snap = (v) => Math.round(v / GRID) * GRID;

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function toModel(ev) {
  const r = svg.getBoundingClientRect();
  return { x: (ev.clientX - r.left - view.x) / view.zoom, y: (ev.clientY - r.top - view.y) / view.zoom };
}

function initEditor(hostEl, onChange, onViewChange, onContextMenu) {
  host = hostEl;
  notify = onChange || (() => {});
  onView = onViewChange || (() => {});
  onMenu = onContextMenu || (() => {});
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
  svg.addEventListener('wheel', onWheel, { passive: false });
  svg.addEventListener('dblclick', onDoubleClick);
  svg.addEventListener('contextmenu', onContext);
  window.addEventListener('keydown', onKeyDown);

  host.addEventListener('dragover', (ev) => { ev.preventDefault(); });
  host.addEventListener('drop', (ev) => {
    ev.preventDefault();
    // Carried on text/plain with a prefix rather than a custom MIME type --
    // WebKit (Word for Mac) drops custom types.
    const payload = ev.dataTransfer.getData('text/plain') || '';
    if (!payload.startsWith('wm-shape:')) return;
    const p = toModel(ev);
    addNode(payload.slice(9), p.x - 70, p.y - 28);
  });

  new ResizeObserver(() => { if (viewTouched) render(); else fitView(); }).observe(host);
  render();
}

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

// Chrome is drawn inside the zoom transform, so every size is divided by the
// zoom to keep handles and hairlines a constant size on screen.
function drawChrome() {
  const s = 1 / view.zoom;
  const only = sel.size === 1 ? nodeById(model, [...sel][0]) : null;
  let portNode = hoverNode || only;

  for (const id of sel) {
    const box = nodeById(model, id) || model.groups.find((g) => g.id === id);
    if (!box || !box.w) continue;
    el('rect', {
      x: box.x - 3 * s, y: box.y - 3 * s, width: box.w + 6 * s, height: box.h + 6 * s,
      class: 'wm-selbox', 'stroke-width': 1.5 * s,
    }, chrome);
  }

  if (selEdge >= 0 && model.edges[selEdge]) {
    const pts = edgeGeometry(model)[selEdge];
    if (pts) {
      el('path', { d: roundedPathD(pts, CORNER_R), class: 'wm-seledge', 'stroke-width': 7 * s }, chrome);
      // A grip on each leg long enough to grab, so it's obvious the path can
      // be dragged. Purely visual: the press lands on the connector itself.
      const self = model.edges[selEdge].from === model.edges[selEdge].to;
      for (let j = 1; j < pts.length && !self; j++) {
        const a = pts[j - 1];
        const b = pts[j];
        if (Math.hypot(b.x - a.x, b.y - a.y) < 24 * s) continue;
        const horizontal = Math.abs(a.y - b.y) < 0.5;
        const w = (horizontal ? 14 : 6) * s;
        const h = (horizontal ? 6 : 14) * s;
        el('rect', {
          x: (a.x + b.x) / 2 - w / 2, y: (a.y + b.y) / 2 - h / 2, width: w, height: h, rx: 2 * s,
          class: 'wm-seghandle', 'stroke-width': 1.5 * s,
        }, chrome);
      }
    }
  }

  if (drag && drag.mode === 'marquee') {
    const b = marqueeBox(drag);
    el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, class: 'wm-marquee', 'stroke-width': 1.5 * s }, chrome);
    return;
  }

  if (drag && drag.mode === 'connect') {
    el('path', {
      d: `M${drag.origin.x} ${drag.origin.y}L${drag.cur.x} ${drag.cur.y}`,
      class: 'wm-rubber', 'stroke-width': 1.5 * s,
    }, chrome);
    if (drag.over && drag.over !== drag.from) {
      el('rect', {
        x: drag.over.x - 3 * s, y: drag.over.y - 3 * s, width: drag.over.w + 6 * s, height: drag.over.h + 6 * s,
        class: 'wm-droptarget', 'stroke-width': 2.5 * s,
      }, chrome);
      // Show the target's ports mid-drag so there is something to aim at.
      portNode = drag.over;
    } else {
      portNode = null;
    }
  }

  if (portNode) {
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
    const handles = [
      ['nw', only.x, only.y, 'nwse'], ['n', mx, only.y, 'ns'], ['ne', only.x + only.w, only.y, 'nesw'],
      ['e', only.x + only.w, my, 'ew'], ['se', only.x + only.w, only.y + only.h, 'nwse'],
      ['s', mx, only.y + only.h, 'ns'], ['sw', only.x, only.y + only.h, 'nesw'], ['w', only.x, my, 'ew'],
    ];
    for (const [name, x, y, cursor] of handles) {
      el('rect', {
        x: x - 4 * s, y: y - 4 * s, width: 8 * s, height: 8 * s,
        class: 'wm-handle', 'stroke-width': 1.5 * s, style: 'cursor:' + cursor + '-resize',
        'data-role': 'handle-' + name, 'data-for': only.id,
      }, chrome);
    }
  }
}

// --- hit testing --------------------------------------------------------

function nodeAt(p, margin) {
  const m = margin || 0;
  for (let i = model.nodes.length - 1; i >= 0; i--) {
    const n = model.nodes[i];
    if (p.x >= n.x - m && p.x <= n.x + n.w + m && p.y >= n.y - m && p.y <= n.y + n.h + m) return n;
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
    const home = model.groups.find((g) => g.members.includes(n.id)) || null;
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

function edgeAt(p) {
  const geom = edgeGeometry(model);
  for (let i = geom.length - 1; i >= 0; i--) {
    const pts = geom[i];
    if (!pts) continue;
    for (let j = 1; j < pts.length; j++) if (distToSeg(p, pts[j - 1], pts[j]) < 7 / view.zoom + 2) return i;
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
  render();
  notify();
}

function takenIds() {
  return new Set(model.nodes.map((n) => n.id).concat(model.groups.map((g) => g.id)));
}

// Caller is responsible for pushUndo/commit -- connecting to empty canvas
// creates a node and an edge as one undoable step.
function makeNode(shape, x, y) {
  const label = shape === 'text' ? 'Text' : 'Block';
  const n = { id: makeId(label, takenIds()), label, shape, x: snap(x), y: snap(y),
              w: 140, h: 56, fill: '#ffffff', fontSize: DEFAULT_FONT_SIZE };
  fitNodeSize(n);
  model.nodes.push(n);
  return n;
}

function addNode(shape, x, y) {
  pushUndo();
  const boxes = groupBoxes();
  const n = makeNode(shape, x, y);
  regroup([n], boxes);
  sel = new Set([n.id]);
  selEdge = -1;
  commit();
  // Open for naming straight away -- a block called "Block" is never what you
  // wanted, and this saves a separate double-click every single time.
  beginLabelEdit(n);
  return n;
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
  clipboard = JSON.parse(JSON.stringify({
    nodes,
    edges: model.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
  }));
  clipboard.pastes = 0;
  return true;
}

function hasClipboard() { return !!(clipboard && clipboard.nodes.length); }

function clipboardBounds() {
  const x0 = Math.min(...clipboard.nodes.map((n) => n.x));
  const y0 = Math.min(...clipboard.nodes.map((n) => n.y));
  const x1 = Math.max(...clipboard.nodes.map((n) => n.x + n.w));
  const y1 = Math.max(...clipboard.nodes.map((n) => n.y + n.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Ctrl+V. Each paste lands a step further down and right than the last, the
// way PowerPoint and Miro cascade, instead of stacking every copy exactly on
// top of the previous one. If that spot is off-screen -- you copied, then
// panned away -- the copy lands in the middle of what you're looking at.
function pasteNext() {
  if (!hasClipboard()) return false;
  clipboard.pastes += 1;
  const off = 20 * clipboard.pastes;
  const b = clipboardBounds();
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
    n.id = makeId(n.label, taken);
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
  // Pasted next to blocks in a group, the copies join that group.
  regroup(made.map((id) => nodeById(model, id)), boxes);
  sel = new Set(made);
  selEdge = -1;
  commit();
  return true;
}

// Drops the copy where the pointer is rather than at a fixed offset, which is
// what "paste here" from the right-click menu has to mean.
function pasteAt(p) {
  if (!hasClipboard()) return false;
  const b = clipboardBounds();
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
    drag = { mode: 'connect', from, anchor, origin: anchorPoint(from, anchor.side, anchor.t), cur: p, over: null };
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
    addNode(armedShape, p.x - 70, p.y - 28);
    armedShape = null;
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

function startMove(p) {
  const nodes = selectedNodes();
  drag = {
    mode: 'move', start: p, nodes,
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
// that moves the view has to close it first or it drifts off the block.
function commitOpenEditor() {
  const open = host.querySelector('.wm-label-input');
  if (open) open.blur();
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
    const p = toModel(ev);
    // Ports show as you approach a block, not only once the pointer is inside
    // it, so the connection dots are already there when you reach for them.
    const near = nodeAt(p, 18 / view.zoom);
    if (near !== hoverNode) {
      hoverNode = near;
      render();
    }
    svg.style.cursor = nodeAt(p) ? 'move' : legCursor(p) || (groupAt(p) ? 'move' : 'grab');
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
  if (drag.mode === 'connect') {
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
    if (ev.shiftKey) { if (Math.abs(rx) > Math.abs(ry)) ry = 0; else rx = 0; }
    const dx = snap(rx);
    const dy = snap(ry);
    for (const b of drag.boxes) { b.n.x = snap(b.x + dx); b.n.y = snap(b.y + dy); }
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
    let w = c.includes('e') ? b.w + (p.x - drag.start.x) : (c.includes('w') ? b.w - (p.x - drag.start.x) : b.w);
    let h = c.includes('s') ? b.h + (p.y - drag.start.y) : (c.includes('n') ? b.h - (p.y - drag.start.y) : b.h);
    if (ev.shiftKey && c.length === 2) {
      // Shift on a corner keeps the proportions, as in PowerPoint and Miro.
      // Not snapped, because snapping each side separately would undo it.
      const k = Math.max(w / b.w, h / b.h, MIN_W / b.w, MIN_H / b.h);
      w = Math.round(b.w * k);
      h = Math.round(b.h * k);
    } else {
      // Only the sides this handle actually drags get snapped -- snapping the
      // other one too would make widening a 56px-tall block also change its
      // height to 60.
      if (c.includes('e') || c.includes('w')) w = Math.max(MIN_W, snap(w));
      if (c.includes('n') || c.includes('s')) h = Math.max(MIN_H, snap(h));
    }
    drag.node.w = w;
    drag.node.h = h;
    drag.node.x = c.includes('w') ? snap(b.x + b.w - w) : b.x;
    drag.node.y = c.includes('n') ? snap(b.y + b.h - h) : b.y;
    refitGroups();
    render();
  }
}

function onPointerUp(ev) {
  if (!drag) return;
  const d = drag;
  drag = null;

  if (d.mode === 'connect') {
    const p = toModel(ev);
    let target = nodeAt(p, 10 / view.zoom);
    if (target === d.from) { render(); return; }
    pushUndo();
    // Letting go over empty canvas creates the block you were reaching for and
    // wires it up, rather than throwing the gesture away.
    const created = !target;
    if (created) {
      const boxes = groupBoxes();
      target = makeNode(d.from.shape === 'text' ? 'rect' : d.from.shape, p.x - 70, p.y - 28);
      regroup([target], boxes);
    }
    // The landing port is pinned only if you actually aimed at one; otherwise
    // the side stays automatic so the connector follows the block around.
    const landed = created ? null : nearestPort(target, p, 16 / view.zoom);
    model.edges.push({
      from: d.from.id, to: target.id, label: '', style: 'arrow', width: DEFAULT_EDGE_W,
      fromAnchor: { side: d.anchor.side, t: d.anchor.t },
      toAnchor: landed ? { side: landed.side, t: landed.t } : null,
      points: null,
    });
    if (created) { sel = new Set([target.id]); selEdge = -1; }
    commit();
    if (created) beginLabelEdit(target);
    return;
  }
  if (d.mode === 'marquee') { render(); notify(); return; }
  if (d.mode === 'pan') { svg.style.cursor = 'default'; render(); return; }
  if (d.undoPushed) { commit(); return; }
  // A click that never became a drag: now it's safe to shrink the selection.
  if (d.onRelease === 'deselect') sel.delete(d.hit);
  if (d.onRelease === 'only') sel = new Set([d.hit]);
  render();
  if (d.onRelease) notify();
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

// Right-click selects whatever is under the pointer first, so the menu the
// shell builds is always about the thing you aimed at.
function onContext(ev) {
  ev.preventDefault();
  const p = toModel(ev);
  menuPoint = p;
  armedShape = null;
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
  if (g && p.y <= g.y + GROUP_TITLE_H) { beginLabelEdit(g); return; }
  // Empty canvas: make a block here and name it. Two clicks from nothing to a
  // named block is the fastest path there is. Inside a group's body the new
  // block lands in that group.
  addNode('rect', p.x - 70, p.y - 28);
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
  // Commit whatever was already open rather than refusing: double-clicking
  // straight from one block to the next has to just work. blur() only fires if
  // it still had focus, so remove it outright afterwards -- a stranded overlay
  // sitting over the canvas is the worst outcome here.
  const open = host.querySelector('.wm-label-input');
  if (open) { open.blur(); open.remove(); }

  // A group's name is edited in its title tab, not over the whole group --
  // a text box the size of the group, with the name floating in the middle
  // of it, reads as broken.
  const isGroup = !!item.members;
  if (isGroup && !box) box = { x: item.x, y: item.y - 4, w: Math.min(item.w, 240), h: GROUP_TITLE_H + 8 };
  const b = box || item;
  const size = (item.fontSize || DEFAULT_FONT_SIZE) * view.zoom;
  const lh = lineH(item.fontSize) * view.zoom;
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
    if (input.value !== item.label) {
      pushUndo();
      item.label = input.value;
      if (item.shape) fitNodeSize(item);
      commit();
    }
  };
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
  if (!item) return false;
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
  if (drag && ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cancelDrag(); return; }
  const ctrl = ev.ctrlKey || ev.metaKey;
  const k = ev.key.toLowerCase();
  const eat = () => { ev.preventDefault(); ev.stopPropagation(); };

  if (ev.key === 'Enter' || ev.key === 'F2') {
    if (editSelectedLabel()) eat();
  } else if (ctrl && k === 'c') { eat(); copySelection(); }
  else if (ctrl && k === 'x') { eat(); if (copySelection()) deleteSelection(); }
  else if (ctrl && k === 'v') { eat(); pasteNext(); }
  else if (ctrl && k === 'd') { eat(); duplicateSelection(); }
  else if (ctrl && k === 'a') { eat(); selectAll(); }
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
    sel = new Set(); selEdge = -1; armedShape = null;
    render(); notify();
  }
}

// --- API used by the taskpane shell -------------------------------------

function setModel(d) {
  pushUndo();
  model = d;
  sel = new Set();
  selEdge = -1;
  refitGroups();
  render();
}

function getModel() { return model; }

function armShape(shape) { armedShape = shape; }

function selectionInfo() {
  return {
    nodes: [...sel].map((id) => nodeById(model, id)).filter(Boolean),
    groups: model.groups.filter((g) => sel.has(g.id)),
    // A block inside a group can be ungrouped too, so the shell needs to know
    // the selection touches one even when the boundary itself isn't selected.
    inGroup: model.groups.some((g) => g.members.some((m) => sel.has(m))),
    edge: selEdge >= 0 ? model.edges[selEdge] : null,
  };
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
