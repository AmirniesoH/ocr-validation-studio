# Developer guide

Technical reference for people who want to read, change or extend OCR Validation Studio. For using the app, see the [User Guide](../USER_GUIDE.md).

The app is plain HTML, CSS and JavaScript. There is no build step, no server and nothing to install: every file in the repository is served as it is.

## Running it

- **Directly:** open `index.html` in Chrome, Edge, Firefox or Safari. It works over `file://`.
- **From a local server (optional):** run `python3 -m http.server` in this folder and open <http://localhost:8000>.
- **Without your own files:** click **Try with sample documents** on the start screen. The four sample pages cover nested JSON, a flat JSON array and Parquet. Each is raw OCR output with typical mistakes and missed characters; nothing is reviewed. Every page also has a word or two of faded type, as from a dry typewriter ribbon (struck lightly, or fading out across the word). There the OCR misreads characters with very low confidence (below 0.3) and reads the rest of the word correctly but unsure (0.3–0.6), so the whole confidence range is there to practise on. Three pages also carry text that is not horizontal: a tilted rubber stamp (page 1), a steeper one (page 2) and a round seal with curved text (page 3). Samples are for practice: they are generated fresh every time and never auto-saved (see below).

## Review rules

All review rules live in `js/model/review.js`. They are the only place that decides what counts as accepted, pending or complete.

Every character is in exactly one group. The groups are checked in this order:

| Group | Meaning | Shown as |
|---|---|---|
| **Manually added** | Inserted by you; it has no OCR value or confidence | purple |
| **Corrected** | Its value differs from what the OCR detected | teal, with the detected value in the inspector |
| **Accepted by confidence** | Confidence > threshold | plain text |
| **Accepted by you** | Was pending (confidence ≤ threshold) and you accepted it unchanged | green |
| **Pending** | Confidence ≤ threshold (or missing) and not reviewed | orange |

**Accepted** is every group except Pending. So total = accepted + pending, and accepted = by confidence + by you + corrected + added. A page is **complete** when nothing on it is pending.

- **Only pending characters can be accepted:** with `A`, Enter on an unchanged value, the line's ✓ button, or **Accept page**. Accepting never changes the character.
- **Editing any character to a new value makes it Corrected,** and only Corrected; corrected characters are never counted as accepted by you.
- **Typing the original value back** (or **Restore OCR value**) ends the correction: the character becomes Accepted by confidence if its confidence is above the threshold, otherwise Accepted by you.
- **The threshold still applies to reviewed characters.** The inspector always shows the confidence and whether it is above the threshold. If you lower the threshold below the confidence of a character you accepted, it simply counts as Accepted by confidence; raise it again and it is Accepted by you again.
- **Undo acceptance** in the inspector turns an Accepted by you character back into Pending.

How actions change the counters:

| Action | Characters | Accepted | Pending | Accepted by you | Corrected | Manually added |
|---|---|---|---|---|---|---|
| Accept a pending character | = | +1 | −1 | +1 | = | = |
| Correct a pending character | = | +1 | −1 | = | +1 | = |
| Correct an accepted character | = | = | = | = (or −1 if it was accepted by you) | +1 | = |
| Add a character | +1 | +1 | = | = | = | +1 |
| Remove an added character | −1 | −1 | = | = | = | −1 |
| Remove an OCR character | −1 | −1 if it was accepted | −1 if it was pending | −1 if it was accepted by you | −1 if it was corrected | = |

**Removing a character** (`commands.removeChar`, any character; the inspector's **Remove** button, no keyboard shortcut) takes it out of `page.chars`. Nothing else stores characters, so the box on the image, the counts, statistics, auto-save and every export follow without further code. The line is rebuilt by `layout.withoutChar(page, id)`, a pure function:

- **Nothing takes its place.** Inside a word the two neighbours become adjacent. Their boxes are now a character apart, which an import would read as a space, so the right-hand neighbour gets `joined: true` ("no space before me"). Exports write it (`joined`), the schema reads it back (aliases `joined`, `no_space_before`, `joined_to_previous`) and `buildPage()` skips space inference before such a character. A re-import therefore gives the same text.
- A character that stood alone between spaces leaves one gap, measured with the import rule; spaces that would start or end the line are dropped.
- The rest of the line is **renumbered** (`order` 0, 1, 2, …). Export indices (`index`, `char_index`), word membership and the inspector's position are counted from the line, so they move up with it.
- A line left without characters is removed from `page.lines`, passing its paragraph break to the next line. A commit that changes the lines passes them to `store.commit(pageId, chars, info, lines)`; the history entry keeps both line arrays, so undo and redo restore them. Such a commit carries no `lineIds`, which makes the text panel redraw the page (the lines below are renumbered).

**Outlines of manually added characters.** `commands.beginDraw(id, shape)` starts drawing on the image with `ui.tool` set to `'box'` (drag a rectangle → `setBox`) or `'poly'` (click four corners → `setPolygon`); the shape used last is kept in the `drawShape` setting. The viewer collects the corners (a click places one, a drag still pans) and `box-layer.js` previews them. `geometry.quadFromPoints(points, refAngle)` accepts the points in any order: it sorts them around their centre and starts the quad at the corner that brings the text direction closest to `refAngle`, which is the angle of the nearest rotated character on the same line, or 0. A quad that turns out level is stored as a plain box (`poly: null`), like polygons on import.

Inspector buttons work with one click while a character is being edited: the button row keeps the focus in the editor on mouse-down (a blur would cancel the edit and redraw the buttons before the click arrived), and each action ends the edit first.

The threshold is a setting from 0 to 1. At 0, only characters with a confidence of exactly 0 are pending. At 1, every character you have not reviewed is pending.

## Keyboard

| Key | Action |
|---|---|
| `Tab` / `Shift+Tab` | Go to the next / previous **pending** character and open its editor |
| In the editor: `Enter` | Confirm. A changed value is corrected; an unchanged pending character is accepted; anything else is left as it is |
| In the editor: `Tab` | Save a changed value and move to the next pending character. If the value is unchanged, the character is skipped, not accepted |
| In the editor: `Esc`, or clicking anywhere else | Cancel: the character stays exactly as it was (a pending one stays pending) |
| `A` | Accept the selected character and move on |
| `N` / `P` | Next / previous character in the active filter |
| `I` | Insert mode (click between characters to add one) |
| `B` | Show / hide bounding boxes |
| `+` `−` `0` | Zoom in / out / fit width |
| Click the zoom level | Type a level (`150`, `150%` or `1.5x`) and press Enter; ↑ / ↓ step by 10% (Shift: 50%), Esc cancels. A level above 800% is set to 800% and one below 5% (including 0 or a negative number) to 5%, with a short note saying so. |
| `PageDown` / `PageUp` | Next / previous page |
| `Ctrl+Z`, `Ctrl+Shift+Z` / `Ctrl+Y` | Undo, redo |
| `Ctrl+S` / `Ctrl+O` | Save all / import |

## Project structure

```
index.html             page skeleton; loads js/ovs.js first and js/app.js last
css/
  tokens.css           colours, spacing, z-index layers, light/dark themes
  base.css             buttons, inputs, status pills, tooltips
  layout.css           toolbar, document list, panes, status bar, start screen
  viewer.css           image viewer, boxes, minimap
  text.css             text panel, character cells, inline editor, inspector
  panels.css           settings drawer, statistics, charts
  overlays.css         menus, dialogs, toasts
js/
  ovs.js               tiny module system: OVS.define(name, factory) / OVS.require(name)
  app.js               startup in three steps: create the services, mount the components, restore the session
  util/                dom helpers, formatting, async helpers, file reading, lazy vendor loading
  model/               pure data logic, with no DOM:
    review.js            review rules and counters
    geometry.js          character outlines, including rotated text (four corners, angle, hit testing)
    layout.js            builds lines and characters from annotation records; infers spaces
    page-index.js        cached derived views (lines, reading order, lookup by id)
    stats.js             statistics for any set of pages
  core/
    event-bus.js         publish/subscribe; every event name is listed in this file
    settings.js          persisted user settings (localStorage)
    history.js           undo/redo stacks
    store.js             documents, pages and UI state; emits events on change
    commands.js          every user action, as one method each
  io/                  import, export, auto-save and the sample generator
  ui/                  one file per component (toolbar, nav-panel, viewer, text-panel, ...)
vendor/                PDF.js, JSZip, jsPDF, a Parquet bundle and a PDF font, all loaded on demand
```

### How data flows

1. UI components call `app.commands.*`. For example, the text panel calls `commands.commitEdit(id, value)`.
2. Commands apply the review rules and call `store.commit(pageId, chars)`. Character arrays are immutable, so undo just restores the previous array.
3. The store emits events on `app.bus`, such as `chars:changed`, `page:changed`, `ui:select` and `ui:hover`.
4. Components listen for the events they care about and update themselves.

The original OCR data is never overwritten. Each character keeps `ocr: { value, conf, bbox }`, and your changes live in `value`, `bbox` and `verified`.

### Modules

Each file registers one module:

```js
OVS.define('model/example', (require) => {
  const { clamp } = require('util/format');
  function double(x) { return clamp(x * 2, 0, 10); }
  return { double };
});
```

Factories run lazily the first time a module is required, so the order of the `<script>` tags only matters for `ovs.js` (first) and `app.js` (last). Circular dependencies throw a readable error. Plain scripts are used instead of ES modules because ES modules are blocked over `file://`.

To add a new file, create it under `js/`, add a `<script>` tag for it in `index.html`, and `require` it where it is needed.

## Extending

- **Export format:** add a descriptor to `FORMATS` in `js/io/export-text.js` or `js/io/export-data.js`:
  ```js
  { id: 'md', group: 'text', badge: 'MD', label: 'Markdown', description: '…',
    build: async (ctx) => ({ blob, filename }) }
  ```
  The Export menu and Save All pick it up automatically. `ctx` contains `{ app, scope, groups: [{ doc, pages }], name, threshold }`.
- **Field name in imported annotations:** add it to `ALIASES` in `js/io/annotation-schema.js`.
- **Setting:** add a default to `DEFAULTS` in `js/core/settings.js` and a control in `js/ui/settings-panel.js`. For a number set with a slider, also add its range to `RANGES` in the same file. Sliders read their range from there, and stored values are kept inside it. To react to changes, use `app.settings.watch(['yourKey'], fn)`.
- **Statistics pages table:** column widths are fixed in `css/panels.css` (`.ptable .c-…`); the Page column takes the rest. Long names end in an ellipsis with the full name in a tooltip, so the table never scrolls sideways because of a long file name. Every header shows its full name on one line. In narrow spaces the Accepted share column, then Status, then the Accepted total (Characters − Pending) are hidden (container queries) before the table would need to scroll.
- **Review rule or filter:** edit `js/model/review.js`. `FILTERS`, `matches()` and `counts()` feed the text panel chips, Tab navigation, page status and statistics. Each filter lists the groups it shows (`groups`); `matches()` and the text panel's dimming styles are both built from that list, so a new filter needs no CSS.
- **Panel shown over the workspace** (like Settings or Statistics): use `sidePanel(root, app, { id, label, onOpen })` from `js/ui/side-panel.js` for showing, hiding, Escape and focus, and open it with `app.store.setPanel(id)`.
- **Keyboard shortcut:** add it in `js/ui/shortcuts.js` and call a command method.
- **Tooltip:** give any element `data-tip="…"` (shown below), `data-tip-up="…"` (above) or add `data-tip-side="right"`. `js/ui/tooltip.js` draws it on top of everything and keeps it inside the window. For text that may be cut off with an ellipsis, use `data-tip-overflow` (optionally with the full text as its value): the tooltip then appears only while the text, or one of the element's children, is actually truncated, and wraps long text such as file names.
- **Pane widths:** the divider between the image and text panes stops at each pane's minimum width. For the image pane, `Viewer.minWidth()` in `js/ui/viewer.js` measures the room the zoom bar and page overview need. For the text pane, it is `TEXT_MIN_WIDTH` in `js/app.js`.
- **Debugging:** `window.OVSApp` exposes the running app, for example `OVSApp.store.currentPage()`.

## Performance

The app is built to stay responsive on book-scale work (thousands of characters per page, hundreds of pages):

- **Text panel:** a change restyles only the characters it affects (class names are written only when they change). Filter dimming is pure CSS on the panel (`data-filter` plus each character's group class), so switching filters touches no character. Lines out of view use `content-visibility: auto` and skip style, layout and paint until scrolled to. That setting also clips a line to its own box, so lines with a hovered, selected or edited character, or an insertion, render normally (`.lift`), as do all lines in insert mode: highlights, shadows, the confidence label and the editor can overlap neighbouring lines. "Insert here" targets exist only in insert mode.
- **Image boxes:** drawn on one screen-sized canvas, batched into one path per style, skipping boxes outside the view, at most once per frame.
- **Undo and redo** update only the characters or lines the change touched, like the edit itself.
- **Derived data** (lines, reading order, lookup by id) is cached per immutable character array in `js/model/page-index.js`, so it is computed once per change.
- **Images:** imported images are measured four at a time (the browser decodes them off the main thread). Thumbnails are decoded straight to thumbnail size and only for cards near view. Full-size page images are cached for the 12 most recently used pages; the page on screen is never released.
- **Auto-save** writes only the pages that changed, each image once, and retries anything a failed write did not store.
- **Exports** are written page by page as Blob parts (JSON, CSV, hOCR), never as one string, so a book's export is not limited by the browser's maximum string length. Exports of 20 pages or more show a "Preparing…" message, and builds that take long per page (searchable PDF) report `ctx.progress(done, total)`.

Measured on a 300-page book with 806,400 characters (one folder, one JSON per page): import 4.5 s, opening a page 0.2–0.3 s, statistics over all pages 0.2 s, auto-save of one edited page under 0.1 s, restore on reload 1.8 s. Exports: Parquet 1.4 s (1.2 MB), JSON 0.9 s (163 MB), SQLite 3.6 s (85 MB), CSV 1.1 s, searchable PDF 30 s.

## Input formats

- **Images:** PNG, JPEG, WebP, AVIF, GIF, BMP, and TIFF where the browser can decode it (Safari can; Chrome and Firefox can't).
- **PDF:** each page becomes one page. Rendering uses PDF.js.
- **Annotations:** JSON, Parquet (`.parquet`, `.pq`) or SQLite (`.sqlite`, `.sqlite3`, `.db`, `.db3`), matched to images by file name (with a manual mapping in the import dialog if needed).
  - **SQLite:** the app reads its own SQLite files (see below). From other databases it picks the table or view whose columns best describe characters, with the same field detection as JSON and Parquet, so a database with other tables in it works too (even one with an unrelated table called `annotations`). Databases in WAL mode work. A file that is not a SQLite database, or has no table of characters, is reported in the import dialog.
  - **Several documents in one file:** Parquet and SQLite files that hold several documents (a `document` column) are split, so each document gets its own annotation.
  - Nested structures (`pages → lines → words → characters`) and flat tables both work.
  - Common field names are detected automatically: `text`/`char`, `conf`/`confidence`/`score`, `bbox`/`polygon`/`x0,y0,x1,y1`/`x,y,w,h`, `line`, `page`, `image`, and others.
  - **Rotated text** (stamps, seals, skewed lines) is read from a four-corner polygon per character: `polygon`, `quad`, `points`, `vertices` or `rotated_box`. The format can be `[[x, y] × 4]`, `[x, y × 4]`, `[{x, y} × 4]`, or the same written as a JSON string. Corners are expected in reading order (top-left, top-right, bottom-right, bottom-left). Rotated characters:
    - get turned outlines on the image, and hovering follows their true shape;
    - are shown upright in the inspector's magnifier, which also shows their angle;
    - are read along their own direction, so the words and spaces come out right at any angle and on curves;
    - appear straightened in the text where they sit on the page: each stamp or seal is a paragraph of its own, placed among the other lines by its height on the page, with each line centred on its original position.
  - Confidence can be on a 0–1 or 0–100 scale. Box coordinates can be pixels or normalised (0–1).
  - Empty values (`null`, NULL, empty strings) mean "not given": a character without coordinates gets no box (never a box at 0, 0), and one without a confidence stays unscored.
- **Document names** are kept unique: a second `scan.png` becomes `scan (2).png`. Exports identify documents by name, so this keeps them apart in multi-document files.
- **Folders:** drop a folder or use **Import → Folder**. Images and annotation files are paired by name.
- **One annotation file per page:** files named after a page of a multi-page document (`page_0001.json` beside `page_0001.jpg`), or that name only images of one document, are combined into a single annotation for that document (`mergePageFiles()` in `js/io/importer.js`). It runs after every `add()`, so pages and their files can arrive in any order, also for documents that are already open.

### Adding files

- **Import menu:** adds images, PDFs, folders or annotation files to the open project at any time.
- **Dragging and dropping:** only works on the dedicated drop areas, never anywhere else in the window:
  - the **Add files** area at the bottom of the Documents panel (a small icon when the panel is collapsed);
  - the drop zone on the start screen;
  - the drop zones in the import dialog.

  While files are being dragged, the drop areas light up. Dropping anywhere else does nothing. Clicking a drop area opens the import dialog.

  Dropped files (images, PDFs, annotation files) work everywhere. Dropped *folders* also work when the app is served from a local web server. When `index.html` is opened directly from disk, Chrome does not let a page read a dropped folder, so the app says so and points to **Import → Import folder**, which works in both cases.

  The rule is set in `js/ui/file-drop.js`. To make another element a drop area, call `dropTarget(element, onEntries)`.

## Validated output (`ocr-validation-studio/2`)

The **Validated annotations** JSON keeps everything needed to resume work. Re-importing it restores your progress.

```json
{
  "format": "ocr-validation-studio/2",
  "threshold": 0.75,
  "document": "letter.png", "kind": "image", "annotation_source": "letter.json",
  "pages": [{ "page": 1, "image": "letter.png", "width": 1240, "height": 1754, "coordinate_unit": "px",
    "lines": [{ "id": 1, "direction": "ltr", "characters": [{
      "index": 0, "text": "l", "ocr_text": "1", "conf": 0.83,
      "bbox": [x0, y0, x1, y1], "ocr_bbox": [x0, y0, x1, y1], "bbox_source": "ocr",
      "status": "accepted", "review": "corrected", "corrected": true, "manually_added": false, "verified": true
    }]}]}]
}
```

A file with several documents has `"documents": [ … ]` instead, with one entry per document in the shape above.

`review` names the character's group: `accepted_by_confidence`, `accepted_by_user`, `corrected`, `manually_added` or `pending`.

Rotated characters also carry `"polygon": [[x, y] × 4]`.

The Parquet and CSV exports use one row per character with these columns: `document, page, image, line, char_index, text, ocr_text, conf, status, review, corrected, manually_added, verified, x0, y0, x1, y1, rotated_box, bbox_source, coordinate_unit, joined`. `joined` is true for a character that must not get a space before it on import (see *Removing a character*); in the JSON it is written only where true. `rotated_box` holds the four corners of rotated characters as JSON (empty otherwise); x0–y1 are always the upright bounds.

### SQLite (`.validated.sqlite`)

One database for any number of documents. It suits whole books: indexed, compact, and opened by every programming language and many desktop tools.

| Table | Columns |
|---|---|
| `meta` | `key`, `value`: format, threshold, exported_at, application |
| `documents` | `id`, `name`, `kind`, `annotation_source` |
| `pages` | `id`, `document_id`, `page`, `image`, `width`, `height`, `coordinate_unit` |
| `characters` | `id`, `page_id`, `line`, `char_index`, `text`, `ocr_text`, `conf`, `status`, `review`, `corrected`, `manually_added`, `verified`, `x0`, `y0`, `x1`, `y1`, `rotated_box`, `bbox_source`, `joined` |

Indexes cover characters by page and by review group. The view **`annotations`** joins everything into one flat row per character, with the same columns as the CSV/Parquet export plus `page_width` and `page_height`. For example:

```sql
SELECT document, page, count(*) FROM annotations WHERE review = 'pending' GROUP BY document, page;
```

SQLite runs in the browser through sql.js (WebAssembly). Its binary is embedded in `vendor/sql-wasm-binary.js`, so it also works when `index.html` is opened from disk. The format lives in `js/io/annotation-sqlite.js`. The list of annotation file extensions (for the file pickers and for recognising dropped files) is `ANNOTATION_EXT` in `js/io/importer.js`; add an extension there and both follow.

Other exports: TXT, DOCX, text PDF, searchable PDF (the original image with an invisible text layer, written word by word so a viewer's search finds whole words, parts of words and phrases, and highlights them on the scan; rotated words are written at their angle), ALTO XML v4 and hOCR.

## New project, saving and auto-save

- **New project:** the toolbar button closes everything and returns to the start screen.
  - If there are no unsaved changes, it does this straight away.
  - If there are unsaved changes, it first asks you to choose one of three options:
    - **Save:** run Save All, then start the new project. If saving does not finish (for example, the folder picker was closed), the current project stays open.
    - **Discard:** start the new project without saving.
    - **Cancel:** return to the current project. Esc and clicking outside the dialog also cancel.

  "Unsaved changes" are the edits made since the last Save All, which is the number on the Save All button. Settings such as the threshold are kept. The dialog is built with `js/ui/choice-dialog.js`, which can be reused for other questions.

- **Auto-save:** your own documents are saved to the browser (IndexedDB) a moment after each change, and are restored when you reopen the page. They stay in this browser profile only. Page images are stored once, separately from the characters, so an edit only writes the changed page's text and boxes, not the scan again.
- **Sample documents are never auto-saved.**
  - **Try with sample documents** always opens fresh samples. When a project is open, it goes through New project first, so the previous project's cache is cleared (after asking about unsaved changes).
  - Reopening the app after working on samples shows the start screen.
  - While only samples are open, the toolbar shows **Sample · not kept**.
  - If you add your own files to a sample project, only your files are saved and restored.
  - Sample documents carry `sample: true` (set by `ImportSession(app, { sample: true })`), and `js/io/autosave.js` skips them. Samples cached by earlier versions are recognised by name and removed on startup.
- **Save All (`Ctrl+S`):**
  - In Chromium browsers (Chrome, Edge), it writes one validated file per document into a folder you choose, in the format its annotation came in: JSON, Parquet or SQLite.
  - Everywhere else, it downloads the files, as a zip when there is more than one.

## Browser notes

- The folder picker for Save All needs a Chromium browser. Elsewhere, Save All falls back to downloads.
- Dropping a whole folder needs the app to be served over http (for example `python3 -m http.server`). Opened from disk, use **Import → Import folder** for folders. Dropping files works either way.
- TIFF only opens in browsers that decode it natively. Elsewhere, convert TIFFs to PNG first.
- Auto-save is unavailable in private windows that block IndexedDB. The save indicator in the toolbar shows a crossed-out cloud when that happens.

## Licenses

OCR Validation Studio is released under the [Apache License 2.0](../LICENSE).

The bundled libraries keep their own licenses, in `vendor/LICENSE.*`:

- PDF.js: Apache-2.0
- JSZip: MIT/GPLv3
- jsPDF: MIT
- hyparquet: MIT
- sql.js 1.13.0 (SQLite 3.49): MIT

DejaVu Sans Mono is under the Bitstream Vera / DejaVu license. IBM Plex and Courier Prime are under the SIL Open Font License.
