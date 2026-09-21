# Mermaid Block Diagrams for Word

A Word add-in for drawing block diagrams — hardware/digital-logic datapaths,
system architecture, software boxes — by dragging shapes and connectors onto a
canvas. Every diagram is inserted as a picture whose **alt-text holds the
diagram's Mermaid source**, so the diagram stays editable later and an LLM
handed the `.docx` can read it natively.

Prototype. Word desktop on Windows and Mac.

## What it does

- 23 shapes on the palette in three sections: blocks, hardware (mux, demux,
  buffer, delay, queue/FIFO, summing junction, wire junction, bus bar) and
  systems (memory, bus, document, decision, I/O…). Drag one onto the canvas —
  a preview follows the pointer — or double-click empty canvas for a block.
- **Select anything and a toolbar appears above it**, Miro-style: shape, fill,
  text size, bold, grouping for blocks; line style, arrowheads, thickness,
  colour, label size, bold and reverse for connectors. **Right-click** for
  everything, including copy/paste style.
- To rename a block: double-click it, press Enter or F2, or just select it and
  start typing. Enter or Esc finishes (keeping what you typed), Shift+Enter
  gives you a second line. Double-clicking a connector edits its label the
  same way.
- To connect: hover a block and drag one of the blue dots onto another block.
  The dot you grab is where the connector stays anchored. Drop on empty canvas
  and a shape picker asks what to create there. **Click** a dot instead of
  dragging it to add a connected block in that direction.
- To reconnect: select a connector and drag either of its end dots onto a
  different block. To reroute: drag any leg of it sideways; the path stays
  square. *Reset path* goes back to automatic routing.
- Drag a corner or side handle to resize; hold Shift on a corner to keep the
  proportions. Shift- or Ctrl-click, or shift-drag a box, to multi-select.
  Hold Shift while dragging to move in a straight line. Esc mid-drag cancels.
- Groups work like Miro frames: drag a group by its body, drag a block out to
  remove it, drop a block in to add it (the group lights up green as you do).
  Selecting a block outlines its group and tints the other members; the
  toolbar and right-click menu name the group and offer *Add to…* / *Remove*.
- Drag empty canvas or scroll to pan; Ctrl+scroll or pinch to zoom.
- The **Mermaid** tab shows the source at all times, and you can paste Mermaid
  in (from an LLM, say). Your edits apply when you go back to the canvas.
- **Insert into document** drops the picture in. **Open selected** picks a
  diagram back up out of the document. **Update in document** replaces the
  diagram you inserted or opened — no need to re-select it in the document.

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
connector was pinned to, and a `%% path` line records the bends of a connector
you rerouted by hand; neither appears unless you did that.

Everything else rides in standard Mermaid: fills and text sizes are `style`
statements, connector thickness is a `linkStyle` statement, and a heavy
connector is also written with Mermaid's own `==>` form so it stays heavy in
other renderers.

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

### Every time you push

Bump `?v=N` on `SourceLocation` in `manifest.xml` **and** the `build vN` marker
in `taskpane.html`, together, and bump the `?v=N` on the three `<script src>`
tags. Word caches the taskpane hard enough that without a new URL it will serve
a stale copy after a fresh deploy and your changes just won't appear. See
`CLAUDE.md`.
