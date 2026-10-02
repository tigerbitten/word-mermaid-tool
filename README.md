# Mermaid Block Diagrams for Word

A Word add-in for drawing block diagrams — hardware/digital-logic datapaths,
system architecture, software boxes — by dragging shapes and connectors onto a
canvas. Every diagram is inserted as a picture whose **alt-text holds the
diagram's Mermaid source**, so the diagram stays editable later and an LLM
handed the `.docx` can read it natively.

Prototype. Word desktop on Windows and Mac.

## What it does

- Every Mermaid 11 shape, on the palette in sections: blocks, hardware (mux,
  demux, buffer, delay, queue/FIFO, summing junction, wire junction, bus bar),
  systems (memory, bus, document, decision, I/O…), architecture (cloud,
  person, browser, terminal, bucket, folder, disk, note) and — folded under
  **More**, click its heading — the rest of the flowchart symbols (manual
  input, display, card, documents, stored data, loop limit, collate…). Drag
  one onto the canvas — a preview follows the pointer — or click one, then
  click where it goes.
- **Select anything and a toolbar appears above it**, Miro-style: shape, fill,
  text size, bold, grouping for blocks; line style, arrowheads, thickness,
  colour, label size, bold and reverse for connectors. **Right-click** for
  everything, including copy/paste style.
- To rename a block: double-click it, press Enter or F2, or just select it and
  start typing. Enter or Esc finishes (keeping what you typed), Shift+Enter
  gives you a second line. Double-clicking a connector edits its label the
  same way. A connector's text sits near its middle but off blocks, other
  lines and bends; drag the text to slide it along the connector.
- **Pins.** Double-click near either end of a connector (or right-click >
  *Name start pin / Name end pin*) to name the pin it's wired to — `rs1`,
  `out`, `a`. The name is drawn small inside the block where the line meets
  it, as on a schematic.
- **Click-click lines.** Click **Arrow** or **Line** in the palette, click
  where it starts — on a block's edge, or anywhere — then click where it ends.
  The line follows the pointer in between; Esc cancels.
- **Lines work like Miro's.** Or drag an **Arrow** or **Line** from the top of
  the palette and drop it anywhere; drag either end onto a block to attach it.
  An end dropped near a block's edge attaches at exactly that spot — any point
  along any edge, on the real curve of a circle or slope of a diamond; dropped
  in the middle of a block it floats on whichever side faces the other end.
  Ends dropped in empty space stay loose. A line with both ends loose drags as
  a whole.
- Or start one from a block: move the pointer just outside any edge — the
  cursor becomes a crosshair and a single marker shows the exact spot — and
  drag. No dots appear on blocks. Drop on empty canvas and a shape picker asks
  what to create there (cancel and the line stays, loose).
- Right-angled connectors are routed to stay clean: they leave and arrive
  square to the edge and end on the shape itself (a mux's slanted side, a
  cylinder's curve), go round other blocks rather than through them, keep off
  each other and off group borders, and come out as one straight line whenever
  the two ends line up. A decision's branches leave from its side corners.
  Drop an end nearly level with the other and it snaps level.
- **Hold Shift while dragging a line** — an end, a new connector, or the line
  itself — to make it straight; a loose end also snaps to 45° steps.
  **Straight** in the toolbar does the same and switches back to right angles
  (any path you drew by hand comes back). Right-click empty canvas to switch
  every connector at once.
- To reroute a right-angled connector: drag any leg of it sideways; the path
  stays square. *Reset path* goes back to automatic routing.
- Placement is free, as in Miro: nothing snaps to a grid. Dragging a block
  lines it up with the blocks around it — edges and centres — or spaces it
  evenly beside its neighbours, once within a few pixels, with a pink guide
  showing what it lined up with; resizing lines a side up or matches another
  block's size the same way. Hold Alt to drag without guides.
- Drag a corner or side handle to resize; hold Shift on a corner to keep the
  proportions. Shift- or Ctrl-click, or shift-drag a box, to multi-select.
  Hold Shift while dragging to move in a straight line. Alt- or Ctrl-drag
  drags off a copy. Drag anything to the edge of the canvas and the view
  scrolls with it. Esc mid-drag cancels.
- With several blocks selected, **Align…** in the toolbar lines them up,
  spaces them evenly, or makes them all the size of the first one selected.
- Groups nest: select groups (and blocks) and group them again, and the
  groups go in whole. Ungrouping an inner group leaves its blocks in the one
  around it. Pasted Mermaid with nested `subgraph`s, or a connector to a whole
  subgraph (`User --> Cloud`), comes in the same way.
- Groups work like Miro frames: drag a group by its body, drag a block out to
  remove it, drop a block in to add it (the group lights up green as you do).
  Selecting a block outlines its group and tints the other members; the
  toolbar and right-click menu name the group and offer *Add to…* / *Remove*.
  Select a group to change its title size.
- Drag empty canvas, hold Space and drag anywhere, or scroll to pan;
  Ctrl+scroll or pinch to zoom.
- The **Mermaid** tab shows the source at all times, and you can paste Mermaid
  in — even a whole LLM reply; its first ```` ```mermaid ```` block is used. Your
  edits apply when you go back to the canvas. Pasted diagrams are laid out
  for you: blocks sized to their text, groups kept together, and loops cut at
  their "go back" arrow so the flow reads top to bottom (or left to right).
  Flowcharts are read in full, styles included (named and rgb colours,
  borders, `classDef`s, `linkStyle default`), as are icon and image nodes
  (`@{ icon: "fa:user" }` is drawn with a built-in glyph for the icon's
  name). A **state diagram** or a **`block-beta`** grid is read as the
  flowchart that draws it. Another kind is named and refused.
- **Insert** drops the picture in. **Open** picks a
  diagram back up out of the document. **Update** replaces the
  diagram you inserted or opened — no need to re-select it in the document.
  A picture you resized in Word keeps that scale when updated.
- Pictures go in as SVG, sharp at any zoom and in print (Word 2016 and later;
  older Word shows the 400 ppi PNG kept inside). If Word refuses the SVG, the
  picture goes in as a PNG and the status line says so. Untick **SVG**
  for plain PNG pictures.

### Keyboard

| | |
|---|---|
| `F2` / `Enter` / any letter | rename the selection |
| `Ctrl+C` / `X` / `V` / `D` | copy, cut, paste, duplicate |
| `Ctrl+A` | select all |
| `Ctrl+B` | bold |
| `Ctrl+Alt+C` / `Ctrl+Alt+V` | copy style / paste style |
| `Ctrl+G` / `Ctrl+Shift+G` | group / ungroup |
| `Ctrl+Z` / `Ctrl+Y` | undo / redo |
| `Shift+1` / `Shift+0` | fit everything / 100% |
| `Ctrl +` / `Ctrl -` | zoom |
| arrows (`Shift` for 1px) | nudge |
| `PgUp` / `PgDn` | bring to front / send to back |
| `Space` + drag | pan |
| `Delete` | delete |

## Why the source lives in alt-text

Alt-text lands in `word/document.xml` as `wp:docPr/@descr`, which means the
Mermaid travels inside the `.docx` itself — no sidecar file, no separate store,
and it survives copy-pasting the picture into another document.

It is stored as a fenced code block, verbatim, never encoded:

    ```mermaid
    flowchart LR
      CPU["CPU core"]
      BUS{{"System bus"}}
      CPU ==>|"addr"| BUS
    %% --- layout (word-mermaid-tool v1; safe to ignore) ---
    %% CPU 40,40 140x56
    %% BUS 260,40 140x56
    ```

The whole payload is valid Mermaid — paste it into mermaid.live and it renders.
The `%%` lines are Mermaid comments, ignored by every renderer; they're how this
tool remembers where you put each block, since Mermaid itself has no way to
express node positions. A `%% link` line records which side of a block a
connector was pinned to, a `%% path` line records the bends of a connector
you rerouted by hand, and `%% route … straight` marks a straightened one; none
of them appear unless you did that. A line with a loose end needs a node there
in Mermaid, so the loose end is written as an empty text node
(`point@{ shape: text, label: " " }`), which Mermaid also draws as nothing.

So that a plain Mermaid renderer — and an LLM — sees the diagram the way you
drew it, the header's direction is read off the drawing (`TD` for a diagram
that flows downward, `LR` across, `BT`/`RL` for upward or leftward flows),
blocks and groups are declared in the order the flow runs (stage by stage
along the header's direction), and connectors are listed grouped by the block
they leave. mermaid.live still does its own layout, but it keeps the drawing's
broad shape. Labels are written as typed (`"Attempts >= 3?"`, `"C# client"`):
only a quote, a `<` that would open an HTML tag and a `#` that would start an
entity are escaped. Hardware symbols Mermaid has no word for get one in a
comment under the header (`%% J1 is a wire junction; ADD is a summing
junction`), so an LLM knows what it's looking at.

Everything else rides in standard Mermaid: fills, borders and text sizes are
`style` statements (a pasted `classDef` stays a class, so its name still says
what the blocks have in common), connector thickness is a `linkStyle`
statement, and a heavy connector is also written with Mermaid's own `==>`
form so it stays heavy in other renderers. Circle and cross ends (`--o`,
`x--x`) and longer links (`--->`) are kept. A diagram pasted in keeps its
front matter, `%%{init}%%` directive, comments, `click` and `accTitle` lines.
Pin names, which Mermaid has no syntax for, are spelled out in a comment
(`%% ports: RF.rs1 --> ALU.a`) and recorded in a `%% port` line; text slid
along a connector is a `%% label` line.

### Pointing an LLM at the diagrams

Tell it explicitly where to look, because naive text extraction from a `.docx`
misses alt-text:

> The diagrams in this document are stored as Mermaid in each image's alt-text
> (`wp:docPr/@descr` in `word/document.xml`). Read those.

With `python-docx`: `inline_shape._inline.docPr.get("descr")`.

**Alt-text is dropped when you export to PDF.** Keep the `.docx` if the
diagrams need to stay machine-readable.

## Installing

The add-in is hosted on GitHub Pages; you only sideload a manifest that points
at it.

### Windows

1. Create a folder, e.g. `C:\AddinCatalog`.
2. Download `manifest.xml` from this repo using GitHub's **Download raw file**
   button — not Save Page As, which gives you HTML. It should be about 1 KB.
   Put it in that folder.
3. Share the folder: right-click → Properties → Sharing → Share. Note the
   network path (`\\<pc-name>\AddinCatalog`). On a machine where admin shares
   work, `\\localhost\c$\AddinCatalog` also does, and skips the sharing step —
   but it's blocked on many corporate builds, so use real sharing if unsure.
   It has to be a network path; a plain local path will not register.
4. Word → File → Options → Trust Center → Trust Center Settings → **Trusted
   Add-in Catalogs**. Paste the network path, Add catalog, tick **Show in
   Menu**, OK, OK.
5. **Fully restart Word.**
6. Home → Add-ins → Advanced → **Shared Folder** → Mermaid Block Diagrams.

### Mac

1. Copy `manifest.xml` into
   `~/Library/Containers/com.microsoft.Word/Data/Documents/wef`
   (create the `wef` folder if it isn't there).
2. Quit Word completely and reopen it.
3. Home → Add-ins → **Developer Add-ins** → Mermaid Block Diagrams.

## Developing

There is no build step. The files are served straight from GitHub Pages off the
repo root.

`taskpane.html` also runs in a plain browser — open it directly and it detects
that there's no Office host, disables the three Word buttons, and is otherwise
fully usable. That's the fast iteration loop; only insert/replace/load need
real Word.

| File | What's in it |
|---|---|
| `diagram.js` | The model, and Mermaid in/out (serialize, parse, auto-layout for imports) |
| `render.js` | Model → SVG. The canvas and the inserted picture come from this same code |
| `editor.js` | Pointer interaction: drag, connect, resize, select, undo, pan/zoom |
| `taskpane.html` | UI shell and every Office.js call |
| `icon.svg` | The add-in icon; `icon-32.png` / `icon-64.png` are it exported at those sizes for the manifest |
| `test.js` | `node test.js`: Mermaid in and out without a browser (what LLMs write, round trips, pasted-diagram layout, label escaping) |

### Every time you push

Bump `?v=N` on `SourceLocation` in `manifest.xml` **and** the `build vN` marker
in `taskpane.html` (and the manifest's `ProviderName`, which shows the same
text), together, and bump the `?v=N` on the three `<script src>` tags. Word caches the taskpane hard enough that without a new URL it will serve
a stale copy after a fresh deploy and your changes just won't appear. See
`CLAUDE.md`.
