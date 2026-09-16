// Interaction: turns pointer events into model edits.
//
// The whole diagram is re-rendered after every change. Diagrams are small
// enough that this is instant, and it removes an entire class of stale-view
// bugs that incremental updates invite.

const GRID = 10;
const MIN_W = 60;
const MIN_H = 36;
const UNDO_DEPTH = 50;

const EDITOR_STYLE = `
  .wm-canvas { width: 100%; height: 100%; display: block; background: #fff; touch-action: none; }
  .wm-selbox { fill: none; stroke: #2563eb; stroke-dasharray: 4 3; }
  .wm-seledge { fill: none; stroke: #2563eb; opacity: 0.35; }
  .wm-port { fill: #fff; stroke: #2563eb; cursor: crosshair; }
  .wm-handle { fill: #fff; stroke: #2563eb; }
  .wm-rubber { fill: none; stroke: #2563eb; stroke-dasharray: 4 3; }
  .wm-droptarget { fill: none; stroke: #16a34a; }
`;

const PAGE_STYLE = `
  .wm-host { position: relative; overflow: hidden; background: #fff; }
  .wm-label-input { position: absolute; z-index: 5; box-sizing: border-box; text-align: center;
    font-family: Calibri, "Segoe UI", Helvetica, Arial, sans-serif; line-height: 1.25;
    border: 2px solid #2563eb; border-radius: 3px; padding: 3px 4px; outline: none;
    resize: none; overflow: hidden; background: #fff; color: #111; }
`;

let model = newDiagram();
let host = null;
let svg = null;
let world = null;
let chrome = null;
let gridPattern = null;
let notify = () => {};
let onView = () => {};

const MIN_ZOOM = 0.25;
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

const snap = (v) => Math.round(v / GRID) * GRID;

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function toModel(ev) {
  const r = svg.getBoundingClientRect();
  return { x: (ev.clientX - r.left - view.x) / view.zoom, y: (ev.clientY - r.top - view.y) / view.zoom };
}

function initEditor(hostEl, onChange, onViewChange) {
  host = hostEl;
  notify = onChange || (() => {});
  onView = onViewChange || (() => {});
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

// Chrome is drawn inside the zoom transform, so every size is divided by the
// zoom to keep handles and hairlines a constant size on screen.
function drawChrome() {
  const s = 1 / view.zoom;

  for (const id of sel) {
    const box = nodeById(model, id) || model.groups.find((g) => g.id === id);
    if (!box || !box.w) continue;
    el('rect', {
      x: box.x - 3 * s, y: box.y - 3 * s, width: box.w + 6 * s, height: box.h + 6 * s,
      class: 'wm-selbox', 'stroke-width': 1.5 * s,
    }, chrome);
  }

  if (selEdge >= 0 && model.edges[selEdge]) {
    const e = model.edges[selEdge];
    const a = nodeById(model, e.from);
    const b = nodeById(model, e.to);
    if (a && b) {
      el('path', { d: roundedPathD(routePoints(a, b), CORNER_R), class: 'wm-seledge', 'stroke-width': 5 * s }, chrome);
    }
  }

  if (drag && drag.mode === 'connect') {
    const a = { x: drag.from.x + drag.from.w / 2, y: drag.from.y + drag.from.h / 2 };
    el('path', { d: `M${a.x} ${a.y}L${drag.cur.x} ${drag.cur.y}`, class: 'wm-rubber', 'stroke-width': 1.5 * s }, chrome);
    if (drag.over && drag.over !== drag.from) {
      el('rect', {
        x: drag.over.x - 3 * s, y: drag.over.y - 3 * s, width: drag.over.w + 6 * s, height: drag.over.h + 6 * s,
        class: 'wm-droptarget', 'stroke-width': 2.5 * s,
      }, chrome);
    }
    return; // no ports or handles while wiring
  }

  const only = sel.size === 1 ? nodeById(model, [...sel][0]) : null;
  const portNode = hoverNode || only;
  if (portNode) {
    const mid = { x: portNode.x + portNode.w / 2, y: portNode.y + portNode.h / 2 };
    const spots = [
      { x: mid.x, y: portNode.y }, { x: portNode.x + portNode.w, y: mid.y },
      { x: mid.x, y: portNode.y + portNode.h }, { x: portNode.x, y: mid.y },
    ];
    for (const p of spots) {
      // An invisible disc well larger than the dot does the catching -- a 6px
      // target is far too fiddly to hit, especially zoomed out.
      el('circle', {
        cx: p.x, cy: p.y, r: 15 * s, fill: 'transparent', stroke: 'none',
        style: 'cursor:crosshair', 'data-role': 'port', 'data-for': portNode.id,
      }, chrome);
      el('circle', {
        cx: p.x, cy: p.y, r: 6 * s, class: 'wm-port', 'stroke-width': 2 * s,
        style: 'pointer-events:none',
      }, chrome);
    }
  }
  if (only) {
    const corners = [
      ['nw', only.x, only.y], ['ne', only.x + only.w, only.y],
      ['se', only.x + only.w, only.y + only.h], ['sw', only.x, only.y + only.h],
    ];
    for (const [name, x, y] of corners) {
      el('rect', {
        x: x - 4 * s, y: y - 4 * s, width: 8 * s, height: 8 * s,
        class: 'wm-handle', 'stroke-width': 1.5 * s,
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

// Only the title strip grabs a group -- its body must stay click-through so
// you can still select the nodes inside it.
function groupTitleAt(p) {
  for (const g of model.groups) {
    if (g.w > 0 && p.x >= g.x && p.x <= g.x + g.w && p.y >= g.y && p.y <= g.y + 22) return g;
  }
  return null;
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
  for (let i = model.edges.length - 1; i >= 0; i--) {
    const a = nodeById(model, model.edges[i].from);
    const b = nodeById(model, model.edges[i].to);
    if (!a || !b) continue;
    const pts = routePoints(a, b);
    for (let j = 1; j < pts.length; j++) if (distToSeg(p, pts[j - 1], pts[j]) < 6) return i;
  }
  return -1;
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
  const n = { id: makeId(label, takenIds()), label, shape, x: snap(x), y: snap(y), w: 140, h: 56, fill: '#ffffff' };
  fitNodeSize(n);
  model.nodes.push(n);
  return n;
}

function addNode(shape, x, y) {
  pushUndo();
  const n = makeNode(shape, x, y);
  sel = new Set([n.id]);
  selEdge = -1;
  commit();
  // Open for naming straight away -- a block called "Block" is never what you
  // wanted, and this saves a separate double-click every single time.
  beginLabelEdit(n);
}

function deleteSelection() {
  if (!sel.size && selEdge < 0) return;
  pushUndo();
  if (selEdge >= 0) model.edges.splice(selEdge, 1);
  const gone = new Set([...sel].filter((id) => nodeById(model, id)));
  model.nodes = model.nodes.filter((n) => !gone.has(n.id));
  model.edges = model.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to));
  model.groups = model.groups.filter((g) => !sel.has(g.id));
  for (const g of model.groups) g.members = g.members.filter((m) => !gone.has(m));
  sel = new Set();
  selEdge = -1;
  commit();
}

function groupSelection() {
  const ids = [...sel].filter((id) => nodeById(model, id));
  if (!ids.length) return 'select one or more blocks to group';
  pushUndo();
  for (const g of model.groups) g.members = g.members.filter((m) => !ids.includes(m));
  model.groups.push({ id: makeId('Group', takenIds()), label: 'Group', members: ids, x: 0, y: 0, w: 0, h: 0 });
  commit();
  return null;
}

function ungroupSelection() {
  const hit = model.groups.filter((g) => sel.has(g.id));
  if (!hit.length) return 'select a group boundary (click its title) first';
  pushUndo();
  model.groups = model.groups.filter((g) => !sel.has(g.id));
  commit();
  return null;
}

function applyToNodes(fn) {
  const nodes = [...sel].map((id) => nodeById(model, id)).filter(Boolean);
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


function undo() {
  if (!undoStack.length) return;
  redoStack.push(JSON.stringify(model));
  model = JSON.parse(undoStack.pop());
  sel = new Set();
  selEdge = -1;
  render();
  notify();
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify(model));
  model = JSON.parse(redoStack.pop());
  sel = new Set();
  selEdge = -1;
  render();
  notify();
}

// --- pointer ------------------------------------------------------------

function movingNodes() {
  const ids = new Set();
  for (const id of sel) {
    if (nodeById(model, id)) ids.add(id);
    const g = model.groups.find((gr) => gr.id === id);
    if (g) g.members.forEach((m) => ids.add(m));
  }
  return [...ids].map((id) => nodeById(model, id)).filter(Boolean);
}

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
    drag = { mode: 'connect', from: nodeById(model, ev.target.getAttribute('data-for')), cur: p, over: null };
    render();
    return;
  }
  if (role && role.startsWith('handle-')) {
    const n = nodeById(model, ev.target.getAttribute('data-for'));
    drag = { mode: 'resize', node: n, corner: role.slice(7), start: p, box: { ...n } };
    return;
  }
  if (armedShape) {
    addNode(armedShape, p.x - 70, p.y - 28);
    armedShape = null;
    notify();
    return;
  }

  const n = nodeAt(p);
  if (n) {
    if (ev.shiftKey) { sel.has(n.id) ? sel.delete(n.id) : sel.add(n.id); }
    else if (!sel.has(n.id)) sel = new Set([n.id]);
    selEdge = -1;
    drag = { mode: 'move', start: p, boxes: movingNodes().map((m) => ({ n: m, x: m.x, y: m.y })) };
    render();
    notify();
    return;
  }

  const g = groupTitleAt(p);
  if (g) {
    sel = ev.shiftKey ? new Set([...sel, g.id]) : new Set([g.id]);
    selEdge = -1;
    drag = { mode: 'move', start: p, boxes: movingNodes().map((m) => ({ n: m, x: m.x, y: m.y })) };
    render();
    notify();
    return;
  }

  const ei = edgeAt(p);
  if (ei >= 0) {
    selEdge = ei;
    sel = new Set();
    render();
    notify();
    return;
  }

  // Dragging empty canvas pans. Multi-select is shift-click rather than a
  // rubber band -- one less mode, and dragging the background to move around
  // is what people reach for first.
  if (!ev.shiftKey) { sel = new Set(); selEdge = -1; }
  drag = { mode: 'pan', sx: ev.clientX, sy: ev.clientY, vx: view.x, vy: view.y };
  svg.style.cursor = 'grabbing';
  render();
  notify();
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
    svg.style.cursor = nodeAt(p) ? 'move' : 'grab';
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
  if (drag.mode === 'connect') {
    drag.cur = p;
    drag.over = nodeAt(p, 10 / view.zoom);
    render();
    return;
  }

  ensureUndo();
  if (drag.mode === 'move') {
    const dx = snap(p.x - drag.start.x);
    const dy = snap(p.y - drag.start.y);
    for (const b of drag.boxes) { b.n.x = snap(b.x + dx); b.n.y = snap(b.y + dy); }
    refitGroups();
    render();
    return;
  }
  if (drag.mode === 'resize') {
    const b = drag.box;
    const c = drag.corner;
    let w = c.includes('e') ? b.w + (p.x - drag.start.x) : (c.includes('w') ? b.w - (p.x - drag.start.x) : b.w);
    let h = c.includes('s') ? b.h + (p.y - drag.start.y) : (c.includes('n') ? b.h - (p.y - drag.start.y) : b.h);
    w = Math.max(MIN_W, snap(w));
    h = Math.max(MIN_H, snap(h));
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
    if (created) target = makeNode(d.from.shape === 'text' ? 'rect' : d.from.shape, p.x - 70, p.y - 28);
    model.edges.push({ from: d.from.id, to: target.id, label: '', style: 'arrow' });
    if (created) { sel = new Set([target.id]); selEdge = -1; }
    commit();
    if (created) beginLabelEdit(target);
    return;
  }
  if (d.mode === 'pan') { svg.style.cursor = 'default'; render(); return; }
  if (d.undoPushed) commit(); else render();
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

function onWheel(ev) {
  ev.preventDefault();
  zoomAround(view.zoom * Math.exp(-ev.deltaY * 0.0015), toModel(ev));
}

function canvasCenter() {
  const r = svg.getBoundingClientRect();
  return { x: (r.width / 2 - view.x) / view.zoom, y: (r.height / 2 - view.y) / view.zoom };
}

function zoomBy(factor) { zoomAround(view.zoom * factor, canvasCenter()); }
function getZoom() { return view.zoom; }

function onDoubleClick(ev) {
  const p = toModel(ev);
  const target = nodeAt(p) || groupTitleAt(p);
  if (target) beginLabelEdit(target);
}

// A textarea rather than an input so labels can wrap onto two lines, which
// block diagrams need constantly. Enter commits; Shift+Enter is a line break.
// `seed` is the character that triggered the edit when you just start typing
// over a selected block.
function beginLabelEdit(item, seed) {
  if (host.querySelector('.wm-label-input')) return;
  const input = document.createElement('textarea');
  input.className = 'wm-label-input';
  input.value = seed != null ? seed : item.label;
  input.style.left = (view.x + item.x * view.zoom) + 'px';
  input.style.top = (view.y + item.y * view.zoom) + 'px';
  input.style.width = Math.max(90, item.w * view.zoom) + 'px';
  input.style.height = Math.max(32, (item.h || 26) * view.zoom) + 'px';
  input.style.fontSize = Math.max(11, 13 * view.zoom) + 'px';
  host.appendChild(input);
  input.focus();
  if (seed != null) input.setSelectionRange(input.value.length, input.value.length);
  else input.select();

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    input.remove();
    if (save && input.value !== item.label) {
      pushUndo();
      item.label = input.value;
      if (item.shape) fitNodeSize(item);
      commit();
    }
  };
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); finish(true); }
    else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
  });
}

function editSelectedLabel(seed) {
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
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  const ctrl = ev.ctrlKey || ev.metaKey;

  if (ev.key === 'Enter' || ev.key === 'F2') {
    if (editSelectedLabel()) { ev.preventDefault(); ev.stopPropagation(); }
  } else if (!ctrl && !ev.altKey && ev.key.length === 1 && ev.key !== ' ') {
    // Typing over a selected block replaces its text, the way it works in
    // every other diagram tool.
    if (editSelectedLabel(ev.key)) { ev.preventDefault(); ev.stopPropagation(); }
  } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
    ev.preventDefault(); ev.stopPropagation();
    deleteSelection();
  } else if (ctrl && ev.key.toLowerCase() === 'z') {
    ev.preventDefault(); ev.stopPropagation();
    ev.shiftKey ? redo() : undo();
  } else if (ctrl && ev.key.toLowerCase() === 'y') {
    ev.preventDefault(); ev.stopPropagation();
    redo();
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
    edge: selEdge >= 0 ? model.edges[selEdge] : null,
  };
}

// Never zooms past 1:1. Blowing a two-block diagram up to fill the pane looks
// broken, and shrinking below half makes labels unreadable -- past that point
// it's better to clip and let the user pan.
function fitView() {
  const r = host.getBoundingClientRect();
  viewTouched = false;
  if (!model.nodes.length) { view = { x: 40, y: 40, zoom: 1 }; render(); onView(); return; }
  const b = diagramBounds(model);
  const pad = 24;
  view.zoom = Math.max(0.5, Math.min((r.width - pad * 2) / b.w, (r.height - pad * 2) / b.h, 1));
  view.x = (r.width - b.w * view.zoom) / 2 - b.x * view.zoom;
  view.y = (r.height - b.h * view.zoom) / 2 - b.y * view.zoom;
  render();
  onView();
}
