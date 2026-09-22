# DOM Capture

> Point at any element on a page, click it, and get that element — **with every style it and its descendants need** — on your clipboard as self-contained HTML.

Paste the result into an empty `.html` file and it renders the same, with no dependency on the original site's stylesheets, class names or JavaScript.

Works on plain pages and on pages built from **web components** — open *and* closed shadow roots, slots, `::slotted`, `:host`, `::part`, adopted stylesheets, nested components.

```
┌─ page ──────────────────┐            ┌─ clipboard ─────────────┐
│  ╔═══════════════════╗  │            │  <style> … </style>     │
│  ║  the element you  ║  │   click →  │  <article class="dc…">  │
│  ║  pointed at       ║  │            │      …                  │
│  ╚═══════════════════╝  │            │  </article>             │
└─────────────────────────┘            └─────────────────────────┘
   500 stylesheets, 40 classes,           one <style>, no page
   3 shadow roots, 2 CDNs                 classes, nothing external
```

---

## Install

1. Open `chrome://extensions` and switch on **Developer mode**.
2. **Load unpacked** → choose the `extension/` folder.
3. Pin the DOM Capture icon if you like.

Needs a Chromium-based browser, version 120 or newer.

**Permissions:** `activeTab` + `scripting` (it only ever touches the tab you invoke it on), `clipboardWrite`, and `storage` for your options and for the last capture (so it can be pasted on another page). No host permissions up front, no background activity, nothing leaves your machine. Access to one more site is asked for only when you capture an `<iframe>` from it and press **Allow** (see [Iframes](#iframes)).

## Use

1. Click the toolbar icon, or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd>.
2. Move the mouse — the element under the cursor is outlined and labelled with its tag and size.
3. **Click** to select it. The outline turns amber and stays put, and a small panel appears above the toolbar.
4. Adjust the selection if the element you want is hard to hit — a wrapper with no pixel of its own, say:
   **↑ Parent** / **↓ Child** walk up and down the tree (Child retraces the way you came up), **← Previous** / **Next →** step through siblings, and the ancestor trail underneath jumps straight to any ancestor. Hovering a button previews where it leads. Clicking another element on the page moves the selection there.
5. Press **Capture** (or <kbd>Enter</kbd>). The snippet is on your clipboard straight away.

| Key | |
| --- | --- |
| <kbd>Click</kbd> | select the highlighted element |
| <kbd>↑</kbd> / <kbd>↓</kbd> | widen to the parent (climbs out of slots and shadow roots too) / narrow back down |
| <kbd>←</kbd> / <kbd>→</kbd> | previous / next sibling |
| <kbd>Enter</kbd> / <kbd>⌘</kbd><kbd>C</kbd> | capture the selection |
| <kbd>E</kbd> | edit its text in place |
| drag / <kbd>M</kbd> | move it elsewhere on the page |
| <kbd>Shift</kbd>+<kbd>↑</kbd> / <kbd>↓</kbd> | swap it with the previous / next sibling |
| <kbd>X</kbd> / <kbd>⌘</kbd><kbd>X</kbd> | cut: capture it and take it off the page, to paste on another |
| <kbd>V</kbd> / <kbd>⌘</kbd><kbd>V</kbd> | paste the last capture into this page |
| <kbd>Delete</kbd> | remove it from the page |
| <kbd>⌘</kbd><kbd>Z</kbd> | undo the last edit, move, cut, paste or delete |
| <kbd>Esc</kbd> | drop the selection; again to quit |
| right-click | quit |

(<kbd>Ctrl</kbd> where there is no <kbd>⌘</kbd>.)

While you pick, an invisible overlay receives the mouse, so the page never sees your hover or click: links don't navigate, menus don't open, and the element is captured in its resting, un-hovered state.

After a capture you can **Adjust selection** (go back and take the parent instead, say), **Copy again**, **Download .html** (a complete standalone page), **Preview** it in a new tab, or **Pick another**.

### Changing the page: edit, move, cut & paste, delete

The selection panel also lets you change the live page. Nothing is saved anywhere — reload and it is gone — but it is a quick way to rearrange, rewrite or mock something up, and to build a page out of pieces of others. Every change has an **Undo** (<kbd>⌘</kbd><kbd>Z</kbd>).

- **Edit text** (<kbd>E</kbd>) makes the selection editable in place — text only, no accidental bold or pasted markup. <kbd>Enter</kbd> keeps the change (<kbd>⌘</kbd><kbd>Enter</kbd> in a `<textarea>`), <kbd>Esc</kbd> discards it, and clicking elsewhere keeps it. A text field or textarea is edited as itself. While you type, the page's own keyboard shortcuts stay out of the way.
- **Move** — **drag** the element (any element: pressing on something that isn't selected picks it up) to where it goes and release, or press <kbd>M</kbd>, point, and click. Near an element's top or bottom edge (left or right in a row) means *before* / *after* it; the middle of a container means *inside*. Over a list, a stack or a flex row, the drop snaps to the nearest gap between its children, so pointing between two items puts it between them. An insertion line and a label say exactly what will happen before you let go. <kbd>Shift</kbd>+<kbd>↑</kbd> / <kbd>↓</kbd> swaps it with a neighbour without any pointing.

  An element moved under a **different parent keeps its look**: every style its old context gave it — a descendant rule's padding, an inherited font, a `.stack > * + *` margin — is pinned inline wherever the new context would have changed it. A reorder among siblings is left alone, so `:first-child`-style rules still do their job.
- **Cut** (<kbd>X</kbd>) captures the selection, takes it off this page and keeps it to paste — in any tab or window. Undo brings it back.
- **Paste** (<kbd>V</kbd>) puts the last capture into the page — this one or any other, the styles come along — with the same drag-free pointing as Move. The capture is kept in the extension's local storage, so it survives navigating and closing tabs. Its CSS goes in as a constructable stylesheet with every declaration `!important`: the page's Content-Security-Policy cannot block it and the page's own `!important` rules cannot restyle it. The markup goes through `DOMParser`, so Trusted Types policies do not object either.
- **Delete** (<kbd>Delete</kbd>) removes the selection; its parent becomes the selection.

### Capturing dropdowns, popovers and dialogs

Anything that only exists once the page has been actuated: **open it first, then press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd>.** The shortcut leaves focus on the page so the menu stays open — clicking the toolbar button takes focus away, which closes many menus.

The overlay joins the browser's top layer, so it sits above `popover` elements and `<dialog>`s — including ones inside shadow roots, and ones that open *after* the picker started. Every mouse event is swallowed before the page's "click outside" handlers or the browser's popover light-dismiss can close what you are picking.

Menus held open purely by CSS `:hover` still close, because the page gets no hover.

---

### Iframes

An `<iframe>` is captured together with the document it is showing right now: that document is captured by the same engine, from inside the frame, and travels as the iframe's `srcdoc` — styles, shadow DOM, nested frames and all, without its scripts. The `src` would be no use anywhere else: embedded apps (an admin app, a payment form, a dashboard widget) sign their URLs per session and refuse to load outside their host.

`activeTab` reaches the page and its same-origin frames. A frame from **another site** needs that site granted: the result panel then shows **Allow & capture the iframe too**, Chrome asks once for that site only, and the capture runs again with the frame inlined. Until then the iframe keeps its `src` and the panel says so. A frame's contents go from the frame to the extension and never through `window.postMessage`, so the embedding page cannot use your capture to read a cross-origin frame.

Pick the iframe itself (or anything around it — use **↑ Parent**). Picking a single element *inside* a frame is not supported yet.

## What you paste

```html
<!-- DOM Capture: <article> from https://example.com/pricing -->
<style>
@font-face { … }
@keyframes spin { … }
.dck3f9-1 { all: initial; display: block; padding: 20px; border-radius: 12px; … }
.dck3f9-1::before { content: ""; position: absolute; … }
.dck3f9-2 { all: unset; display: flex; align-items: center; gap: 12px; }
.dck3f9-7:hover { background: rgb(55, 48, 163); transform: translateY(-1px); }
…
</style>
<article class="dck3f9 dck3f9-1" id="card"><header class="dck3f9-2">…</header>…</article>
```

- **None of the page's class names are reused.** Every `class` in the output is generated (`dc` + 4 random characters, checked to be unused on the page, so two captures never collide either). The original `class` attributes, inline `style`s, `on*` handlers and `<script>`s are dropped; the header comment names only the tag.
- Identical elements share one class, so lists and grids stay compact.
- Custom elements are renamed (`<user-card>` → `<user-card-snapshot>`) so a destination page that happens to define the same element can't re-upgrade and wipe the captured content.

## Options

Behind the **Options** button in the picker bar.

| Option | Default | |
| --- | --- | --- |
| Hover & focus states | on | carry `:hover`, `:focus`, `:focus-visible`, `:focus-within`, `:active` rules |
| Page background | on | if the element is transparent, give it the background colour it was sitting on — white text from a dark page stays readable |
| Lock width | on | pin the root to the width it had on the page (it no longer has its column/flex parent to size it) |
| Web fonts | on | bring the `@font-face` rules for the weights and styles actually used |
| Embed all images & fonts | off | inline every asset as a `data:` URI — larger, but fully offline |

---

## How it works

`extension/src/capture.js` is the serializer; `extension/src/picker.js` is the UI.

**1. A predictable baseline.** Each captured element gets a class whose rule starts with `all: unset` (the root: `all: initial`). That cancels user-agent styles *and* whatever the destination page does to `p`, `button`, `h2`… so an element with no declaration is fully predictable: inherited properties take the parent's value, the rest take the CSS initial value.

**2. Typed OM instead of `getComputedStyle`.** `element.computedStyleMap()` returns *computed* values — `width: 50%`, `margin: 0 auto`, `grid-template-columns: repeat(3, 1fr)`, `line-height: 1.5`, `translate(10%)` — where `getComputedStyle` would freeze them into pixels. The copy therefore stays fluid. Only properties that differ from the baseline are written (typically 5–15 per element rather than ~400), then folded into shorthands.

**3. Nothing hard-coded about CSS.** Initial values, which properties inherit, and which default to `currentcolor` are all measured at capture time in a scratch `about:blank` iframe, so new CSS properties work without an update.

**4. The flat tree.** The walker follows what is *rendered*: a shadow host's children are its shadow tree, a `<slot>`'s children are its assigned nodes (or its fallback content), unslotted light DOM is skipped. Closed shadow roots are reached through `chrome.dom.openOrClosedShadowRoot()`. Since computed styles already include the effect of `:host`, `::slotted()`, `::part()` and CSS variables crossing the boundary, the component renders the same with no JavaScript and no shadow DOM.

**5. Things computed style can't see** are recovered from the stylesheets of the document and of every shadow root involved — including `adoptedStyleSheets`, `@import`, `@media` / `@supports` / `@layer`, CSS nesting, and cross-origin sheets when the CDN sends CORS headers:

- `::before`, `::after`, `::marker`, `::placeholder`
- `:hover` / `:focus` / `:active` rules — including ancestor forms such as `.group:hover .child` and `a:hover::after` — re-targeted at the generated classes with `var()` resolved
- `@keyframes` — animated elements are read with their CSS animations momentarily detached, so the copy animates from the true base style rather than a mid-flight frame
- `@font-face`, picked with the CSS font-matching algorithm for the weights in use

**6. Things that would silently break on another origin are inlined automatically:** CSS `mask-image`s (cross-origin masks need CORS), web fonts whose server doesn't send `Access-Control-Allow-Origin: *`, SVG `<use href="sprite.svg#icon">` sprites (same-origin only), plus same-page `<symbol>`s, gradients and clip-paths referenced from outside the captured subtree.

**7. Live state is baked in:** input values, checked/selected state, `<canvas>` pixels (as an `<img>`), the `currentSrc` an `<img srcset>` actually chose. URLs are made absolute. `fill: currentColor` stays a keyword so icons follow hover colour changes.

Pages can't break the capture by naming elements after DOM properties (`<iframe name="styleSheets">`, a form control named `id` or `shadowRoot`…): those properties are read through the browser's native getters.

---

## When something goes wrong

If a capture fails, the panel shows the error and a **Copy debug log** button. The same button is on the success panel, for "it copied, but looks wrong" reports.

The log is plain text: extension version, page URL, browser, options, the picked element's ancestor trail and opening tag, a timed timeline of every capture step (stylesheets indexed per shadow root, elements walked, states matched, assets inlined…), warnings, and — on failure — the error, its stack, and the last step reached. It stays on your clipboard; nothing is sent anywhere.

## Known limits

- It is a **snapshot of the current viewport and state**: only `@media` rules that match right now are considered, `vw`/`rem`/`em` lengths arrive as pixels, and breakpoints don't travel. Percentages, `fr`, `auto`, flex and grid *do* stay fluid.
- Behaviour doesn't travel — no JavaScript, so dropdowns, tabs and carousels are captured as they looked.
- States that depend on a custom property changing (`.btn:hover { --bg: … }`), on `:host(:hover)`, on sibling combinators (`input:focus + label`), or nested inside `:not()` / `:is()` / `:has()` are skipped; so are `::selection`, scrollbar and `::first-letter` styles.
- Stylesheets on another origin *without* CORS headers can't be read, so hover rules, keyframes and fonts defined only there are missing — you get a warning naming the sheet. The element's resting appearance is unaffected.
- Sizing of `::before` / `::after` comes from `getComputedStyle` (pixels) unless a readable stylesheet shows it was `auto` or a percentage.
- Behind a **modal** `<dialog>` the browser makes everything else inert, the overlay included: picking still works, but the dialog's content does see your `:hover` while you pick.
- You cannot pick an element *inside* an `<iframe>` — only the iframe (with its whole document, see [Iframes](#iframes)) or something around it. A frame the extension cannot be injected into (a `data:` URL, a sandboxed frame on some sites) keeps its `src`.
- `<video>` and `blob:` media keep their URLs.
- Quirks-mode pages (no doctype) can differ by a few pixels once pasted into a standards-mode file.
- Moving an element under a different parent pins its computed styles, not its `::before` / `::after` or `:hover` rules; those still follow whatever the new context says. Changes made to a page live only until it is reloaded.
- Privileged pages (`chrome://`, the extension gallery, the PDF viewer) can't be scripted at all — the icon shows a red `!` there.

---

## Development

```sh
npm install
npx playwright install chromium   # once; the e2e run needs a build that can load unpacked extensions
npm test
```

| Script | |
| --- | --- |
| `npm test` | capture suite + end-to-end suite |
| `npm run test:capture` | capture suite only |
| `npm run test:e2e` | end-to-end suite only |
| `npm run test:sites` | manual smoke test against live pages (see below) |
| `npm run icons` | re-render the PNG icons from `scripts/icon.svg` |
| `npm run zip` | package `extension/` for distribution |

**`test/run.mjs`** captures elements from the fixture pages in a real browser, renders the snippet in an empty `about:blank` page and **pixel-diffs** it against the original (currently 0.00% difference), hovers and focuses the copy to verify states, and asserts on the generated markup and CSS — for example, that none of the page's class names appear in the output. `test/fixtures/components.html` is the web-components torture test; `clobber.html` is a page whose named elements shadow DOM properties.

**`test/e2e.mjs`** loads the real extension, drives the picker with mouse and keyboard, and reads the result from the clipboard — this is what proves closed shadow roots work through `chrome.dom`. `test/fixtures/dropdowns.html` covers picking inside an open popover, a click-outside dropdown in a closed shadow root, and a modal dialog. `edit.html` and `paste-target.html` cover editing text, moving (dragging, pointing, nudging — into gaps, across parents with the look kept, and undone), deleting, and pasting a capture into a page whose own `!important` CSS tries to restyle it.

**`test/e2e-frames.mjs`** captures same-origin, cross-origin and nested iframes (`test/fixtures/frames.html`), pastes the result and compares what the frames show — once with the extension allowed on the frames' site, once with the page's origin only, where the cross-origin frame must keep its `src` and the panel must offer to allow it.

**`test/real-sites.mjs`** is a manual, network-dependent smoke test. Its targets aren't checked in: copy `test/real-sites.example.json` to `test/real-sites.json` and list your own pages as `["name", "url", "css selector"]`. Screenshots land in `test/output/real/`.

## Licence

MIT — see [LICENSE](LICENSE).
