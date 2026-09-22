/*
 * DOM Capture — element picker.
 *
 * A full-viewport overlay (in a closed shadow root, styled through a
 * constructable stylesheet so page CSS and CSP cannot touch it) that highlights
 * whatever is under the cursor. Because the overlay itself receives the mouse,
 * the page never sees :hover or clicks while picking — so the element is
 * captured in its resting state and nothing on the page gets triggered.
 *
 * Things that only exist once the page has been actuated — an open dropdown, a
 * popover, a modal dialog — can be picked too: open them, then start the picker
 * (Alt+Shift+C keeps them open). The overlay is itself a popover, so it sits in
 * the top layer above them, and every mouse event is swallowed on `window`
 * before the page's "click outside" handlers can close anything.
 *
 * Clicking does not capture straight away: it pins the selection, and a small
 * panel offers Parent / Child / Previous / Next buttons and the ancestor trail,
 * so a wrapper that has no pixel of its own to click on can still be reached.
 *
 * The selection can also be changed in place — the page is live: its text can be
 * edited, it can be moved elsewhere in the DOM (pointed at, or nudged past a
 * sibling), and the last capture can be pasted into this or any other page with
 * its styles (they go in as a constructable stylesheet, so a page's CSP cannot
 * block them). Every change can be undone.
 *
 *   click          select the element under the cursor (click elsewhere to change)
 *   ↑ / ↓          widen to the parent / narrow back down
 *   ← / →          previous / next sibling
 *   Enter / ⌘C     capture the selection and copy it
 *   E              edit its text in place (Enter keeps, Esc discards)
 *   drag           move it: press on the selection, drag to where it goes, release to drop
 *   M              the same without holding the button: point at where it goes, click to drop
 *   Shift + ↑ / ↓  swap it with the previous / next sibling
 *   Delete         remove it from the page
 *   X / ⌘X         cut: capture it and take it off this page, to paste on another (any tab or window)
 *   V / ⌘V         paste the last capture: point at where it goes, click to drop
 *   ⌘Z             undo the last edit, move, cut, paste or delete
 *   Esc            drop the selection; again to leave
 *
 * Iframes: this script goes into every frame the extension may touch. In a frame it runs headless —
 * only the highlight overlay, no toolbar — and the top frame's picker drives it: hovering an
 * <iframe> that has one opens a hole in the top overlay so the mouse reaches the frame, whose
 * picker then hovers, selects, edits and moves its own elements and reports what it did upstairs.
 * The toolbar's buttons and keys are forwarded to whichever frame holds the selection. Messages
 * travel through the extension (background relay), never through the page.
 */
(() => {
  'use strict';
  if (globalThis.__domCapturePicker) return; // installed once; the toolbar button toggles it through toggle()
  const DC = globalThis.__domCapture;
  if (!DC) return;
  const isTop = window.parent === window;

  const OPTION_LABELS = [
    ['states', 'Hover & focus states', 'Carry :hover, :focus and :active rules'],
    ['backdrop', 'Page background', 'Give a transparent element the background it sat on'],
    ['pinWidth', 'Lock width', 'Keep the width the element had on the page'],
    ['fonts', 'Web fonts', 'Bring @font-face rules along (embedded when the font server requires it)'],
    ['embedAssets', 'Embed all images & fonts', 'Inline every asset as a data: URI — bigger, but works offline'],
  ];
  const defaults = Object.fromEntries(OPTION_LABELS.map(([key]) => [key, DC.DEFAULTS[key]]));
  const storage = globalThis.chrome?.storage?.sync;
  /** Ask the background page for something; resolves to null when it cannot be reached (or is slow). */
  const ask = (msg, timeout = 4000) =>
    new Promise((resolve) => {
      const done = setTimeout(resolve, timeout, null);
      try {
        chrome.runtime.sendMessage(msg, (reply) => {
          void chrome.runtime.lastError;
          clearTimeout(done);
          resolve(reply ?? null);
        });
      } catch {
        resolve(null);
      }
    });

  // Everything the mouse can tell a page. Handled (and stopped) on window, in the
  // capture phase, so it works whoever the browser decided the target was.
  const MOUSE_EVENTS = [
    'pointerdown', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu',
    'pointermove', 'mousemove', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave',
    'mouseover', 'mouseout', 'mouseenter', 'mouseleave', 'gotpointercapture', 'lostpointercapture',
  ];

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .catcher { position: fixed; inset: 0; cursor: crosshair; }
    .catcher.idle { cursor: default; } /* still shields the page while busy / showing the result */
    .box { position: fixed; top: 0; left: 0; pointer-events: none; border: 2px solid #6d5efc; border-radius: 3px;
      background: rgba(109, 94, 252, .14); box-shadow: 0 0 0 1px rgba(255, 255, 255, .7), 0 0 0 9999px rgba(15, 23, 42, .08);
      transition: transform .07s ease-out, width .07s ease-out, height .07s ease-out, border-color .2s, background-color .2s;
      will-change: transform, width, height; display: none; }
    .box.locked { border-color: #f59e0b; background: rgba(245, 158, 11, .14); }
    .box.peek { border-style: dashed; }
    .box.done { border-color: #10b981; background: rgba(16, 185, 129, .16); }
    .box.editing { border-color: #10b981; border-style: dashed; background: transparent; box-shadow: none; transition: none; }
    .box.drop { border-color: #10b981; background: rgba(16, 185, 129, .18); }
    .box.drop.edge { border-color: rgba(16, 185, 129, .55); border-style: dashed; background: transparent; }
    .ghost { position: fixed; top: 0; left: 0; pointer-events: none; display: none; border: 2px dashed rgba(245, 158, 11, .9);
      border-radius: 3px; background: rgba(245, 158, 11, .1); }
    .ghost.lifted { background: rgba(245, 158, 11, .18); box-shadow: 0 12px 32px rgba(15, 23, 42, .3); opacity: .85; }
    .catcher.grab { cursor: grab; }
    .catcher.grabbing { cursor: grabbing; }
    .nav .acts button.danger { background: rgba(248, 113, 113, .16); color: #fecaca; }
    .nav .acts button.danger:hover { background: rgba(248, 113, 113, .32); }
    .mark { position: fixed; top: 0; left: 0; pointer-events: none; display: none; background: #10b981; border-radius: 2px;
      box-shadow: 0 0 0 1px rgba(255,255,255,.85), 0 0 10px rgba(16, 185, 129, .8); }
    .tag { position: fixed; top: 0; left: 0; pointer-events: none; display: none; max-width: min(520px, 90vw);
      font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; color: #fff; background: #6d5efc; padding: 5px 7px;
      border-radius: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-shadow: 0 2px 8px rgba(0,0,0,.25); }
    .tag b { font-weight: 400; opacity: .75; margin-left: 6px; }
    .tag.locked { background: #b45309; }
    .tag.editing, .tag.drop { background: #047857; }
    .bar, .nav, .panel { position: fixed; left: 50%; transform: translateX(-50%); color: #e5e7eb; background: rgba(17, 24, 39, .94);
      border: 1px solid rgba(255,255,255,.12); box-shadow: 0 12px 40px rgba(0,0,0,.4); backdrop-filter: blur(8px);
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
    .bar { bottom: 18px; display: flex; align-items: center; gap: 12px; padding: 8px 8px 8px 14px; border-radius: 999px; white-space: nowrap; }
    .bar .name { font-weight: 700; color: #fff; }
    .bar .hint { color: #9ca3af; }
    kbd { font: 600 11px/1 ui-monospace, Menlo, monospace; background: rgba(255,255,255,.12); border-radius: 4px; padding: 2px 5px; color: #e5e7eb; }
    button { all: unset; cursor: pointer; font: 600 12px/1 system-ui, sans-serif; padding: 8px 12px; border-radius: 999px;
      color: #e5e7eb; background: rgba(255,255,255,.1); }
    button:hover { background: rgba(255,255,255,.2); }
    button:focus-visible { outline: 2px solid #a5b4fc; outline-offset: 1px; }
    button.primary { background: #6d5efc; color: #fff; }
    button.primary:hover { background: #5b4ee0; }
    button[disabled] { opacity: .35; cursor: default; }
    button[disabled]:hover { background: rgba(255,255,255,.1); }
    .nav { bottom: 68px; display: none; flex-direction: column; align-items: center; gap: 8px; padding: 10px 12px;
      border-radius: 16px; max-width: calc(100vw - 32px); }
    .nav.open { display: flex; }
    .nav .moves, .nav .acts { display: flex; gap: 6px; flex-wrap: wrap; justify-content: center; }
    .nav .acts button { background: rgba(16, 185, 129, .16); color: #d1fae5; }
    .nav .acts button:hover { background: rgba(16, 185, 129, .3); }
    .crumbs { display: flex; align-items: center; gap: 2px; max-width: 100%; overflow: hidden; color: #6b7280;
      font: 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .crumbs button { font: inherit; color: #c4b5fd; background: none; padding: 5px 6px; border-radius: 6px;
      max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .crumbs button:hover { background: rgba(255,255,255,.12); }
    .crumbs button.on { color: #fff; background: #b45309; }
    .menu { position: fixed; left: 50%; bottom: 68px; transform: translateX(-50%); width: 320px; padding: 8px; border-radius: 14px;
      color: #e5e7eb; background: rgba(17, 24, 39, .97); border: 1px solid rgba(255,255,255,.12); box-shadow: 0 12px 40px rgba(0,0,0,.4);
      font: 13px/1.35 system-ui, sans-serif; display: none; }
    .menu.open { display: block; }
    .menu label { display: grid; grid-template-columns: 18px 1fr; gap: 2px 8px; padding: 7px 8px; border-radius: 8px; cursor: pointer; }
    .menu label:hover { background: rgba(255,255,255,.07); }
    .menu input { grid-row: span 2; margin: 2px 0 0; accent-color: #6d5efc; }
    .menu small { color: #9ca3af; font-size: 11.5px; }
    .panel { bottom: 18px; width: min(440px, calc(100vw - 32px)); padding: 16px; border-radius: 16px; display: none; }
    .panel.open { display: block; }
    .panel h1 { margin: 0 0 2px; font-size: 15px; font-weight: 700; color: #fff; display: flex; gap: 8px; align-items: center; }
    .panel h1 i { font-style: normal; width: 20px; height: 20px; border-radius: 50%; background: #10b981; color: #052e1b;
      display: inline-grid; place-items: center; font-size: 12px; font-weight: 900; }
    .panel h1.err i { background: #f87171; color: #450a0a; }
    .panel code { font: 12px/1.3 ui-monospace, Menlo, monospace; color: #c4b5fd; word-break: break-all; }
    .panel p { margin: 4px 0 0; color: #9ca3af; font-size: 12.5px; }
    .panel ul { margin: 10px 0 0; padding: 8px 10px 8px 26px; font-size: 12px; color: #fcd34d; background: rgba(251,191,36,.08); border-radius: 8px; }
    .panel li + li { margin-top: 4px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    .spin { display: inline-block; vertical-align: -2px; margin-right: 8px; width: 14px; height: 14px; border-radius: 50%; border: 2px solid rgba(255,255,255,.25); border-top-color: #fff; animation: r .7s linear infinite; }
    @keyframes r { to { transform: rotate(360deg); } }
  `;

  /** Has a box on screen — unlike a <slot> or a display: contents wrapper, which there is nothing to outline of. */
  const rendered = (n) => n.nodeType === 1 && !n.hasAttribute(DC.UI_ATTR) && n.getClientRects().length > 0;
  /** The nearest ancestor worth selecting, in the tree as rendered; null above <body>. */
  const parentOf = (el) => {
    let up = DC.flatParent(el);
    while (up && up !== document.body && up !== document.documentElement && !rendered(up)) up = DC.flatParent(up);
    return up && up !== document.documentElement ? up : null;
  };

  /** Elements that cannot hold children — a move or paste goes next to them, never into them. */
  const HOLLOW = new Set('img input br hr wbr area base col embed link meta param source track iframe canvas video audio textarea select script style template object picture math'.split(' '));
  const canHold = (el) => el.namespaceURI !== 'http://www.w3.org/2000/svg' && !HOLLOW.has(el.localName);
  /** A text field the user types into directly (rather than through contenteditable). */
  const isTextControl = (el) => el.localName === 'textarea' || (el.localName === 'input' && !/^(checkbox|radio|button|submit|reset|file|image|range|color|hidden)$/i.test(el.type));
  const editable = (el) => isTextControl(el) || canHold(el);
  /** Is `el` `node` itself or rendered inside it (through slots and shadow roots)? */
  const within = (node, el) => {
    for (let a = el; a; a = DC.flatParent(a)) if (a === node) return true;
    return false;
  };
  /** Do the siblings of `el` run left-to-right (inline content, a row flexbox)? Then before / after is left / right. */
  const inRow = (el) => {
    const d = getComputedStyle(el).display;
    if (d.startsWith('inline') || d === 'table-cell') return true;
    let p = DC.flatParent(el);
    while (p && getComputedStyle(p).display === 'contents') p = DC.flatParent(p);
    if (!p) return false;
    const pc = getComputedStyle(p);
    return (pc.display === 'flex' || pc.display === 'inline-flex') && pc.flexDirection.startsWith('row');
  };
  /** Put `nodes` before / after `ref`, or at the end of it (into its shadow root if it has one). */
  const put = (nodes, ref, where) => {
    if (where === 'before') ref.before(...nodes);
    else if (where === 'after') ref.after(...nodes);
    else (DC.shadowRootOf(ref, {}) || ref).append(...nodes);
  };
  /**
   * The same stylesheet with every declaration !important. The snippet's classes already beat a
   * page's tag and class rules on specificity, but a page's own !important rules
   * (`article { border: … !important }`) would still win — unless the pasted ones are important
   * too. Rebuilt as text from the parsed rules: the CSSOM lists `all` but cannot read or set it.
   */
  const insist = (rules) =>
    [...rules]
      .map((r) => {
        if (r instanceof CSSStyleRule) {
          const style = r.style;
          const props = [...style];
          const out = [];
          if (props.includes('all')) {
            const probe = ['math-depth', 'forced-color-adjust', 'color-scheme', 'text-size-adjust'].find((p) => !props.includes(p));
            out.push(`all: ${(probe && style.getPropertyValue(probe)) || 'initial'} !important`);
          }
          for (const p of props) if (p !== 'all') out.push(`${p}: ${style.getPropertyValue(p)} !important`);
          const nested = r.cssRules?.length ? ' ' + insist(r.cssRules) : '';
          return `${r.selectorText} { ${out.join('; ')}${nested} }`;
        }
        if (r instanceof CSSMediaRule) return `@media ${r.conditionText} { ${insist(r.cssRules)} }`;
        if (r instanceof CSSSupportsRule) return `@supports ${r.conditionText} { ${insist(r.cssRules)} }`;
        if (globalThis.CSSContainerRule && r instanceof CSSContainerRule) return `@container ${r.conditionText} { ${insist(r.cssRules)} }`;
        if (globalThis.CSSLayerBlockRule && r instanceof CSSLayerBlockRule) return `@layer ${r.name} { ${insist(r.cssRules)} }`;
        return r.cssText; // @keyframes, @font-face, @property…
      })
      .join('\n');
  /** Every computed longhand of `el` as a string — through the Typed OM, so `auto` and `%` stay themselves rather than becoming pixels. */
  const styleMap = (el) => {
    const m = {};
    for (const [prop, value] of el.computedStyleMap()) if (!prop.startsWith('--')) m[prop] = String(value);
    return m;
  };
  /** [element, its computed styles] for `root` and its rendered descendants (up to a limit — moving a whole page is not the idea). */
  const snapshotStyles = (root) => {
    const out = [];
    const walk = (el) => {
      if (out.length >= 600 || el.hasAttribute(DC.UI_ATTR)) return;
      out.push([el, styleMap(el)]);
      for (const c of DC.flatChildren(el, {})) if (c.nodeType === 1) walk(c);
    };
    walk(root);
    return out;
  };
  /** After a move: put back, inline, whatever the new context changed. Returns each touched element with its previous inline style. */
  const pinStyles = (before) => {
    const pinned = [];
    for (const [el, was] of before) {
      if (!el.isConnected) continue;
      const now = styleMap(el);
      let prev = null;
      for (const prop in was) {
        if (was[prop] === now[prop]) continue;
        if (prev === null) pinned.push([el, (prev = el.style.cssText)]);
        el.style.setProperty(prop, was[prop], 'important');
      }
    }
    return pinned;
  };
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const cmd = (e) => (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);
  const isFrame = (el) => el?.localName === 'iframe' && el.namespaceURI === 'http://www.w3.org/1999/xhtml';

  // ------------------------------------------------------------ talking to the pickers in other frames
  // Every frame's picker has a key. Messages go to the background page, which relays them to every
  // frame of the tab; each frame keeps the ones addressed to it ('*' is everyone, 'top' the top
  // frame). A parent learns which key an <iframe> element has by posting a nonce into it: the
  // frame answers with its key through the relay, so the page in between never reads anything.
  const PICK_MSG = 'dom-capture:pick';
  const KEY = crypto.randomUUID();
  const runtime = globalThis.chrome?.runtime?.id ? chrome.runtime : null;
  const send = (msg) => {
    try {
      runtime?.sendMessage({ type: PICK_MSG, from: KEY, ...msg }, () => void runtime.lastError);
    } catch {
      /* extension reloaded under us */
    }
  };

  const h = (tag, props = {}, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k === 'onclick') el.__run = v; // called by activate(): no click event ever reaches our UI
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    el.append(...children);
    return el;
  };

  const picker = {
    ui: isTop, // the top frame has the toolbar and panels; a frame's picker is only the highlight overlay
    active: false,
    mode: 'pick', // pick (follows the mouse) | select (pinned by a click) | edit | place | busy | done
    target: null,
    remote: null, // top only: { key, state } when the selection lives in a frame's picker
    hole: null, // the <iframe> the overlay currently lets the mouse through to
    frameKeys: new WeakMap(), // <iframe> element -> its picker's key
    keyFrames: new Map(), // key -> <iframe> element
    nonces: new Map(), // handshake nonce -> <iframe> element
    owner: false, // frame only: the top says this frame holds the selection
    inside: false, // frame only: the mouse is in here (the top was told)
    editing: null, // { el, saved, control, hadAttr } while the selection's text is being edited
    placing: null, // { kind: 'move' | 'paste', node?, from, drag } while pointing at where something goes
    press: null, // [x, y] of a mouse-down on the selection: dragging from there moves it
    drop: null, // { ref, where: 'before' | 'after' | 'inside', row } — where the pointer says it goes
    clip: null, // the last capture, kept in chrome.storage.local so it can be pasted on any page
    undos: [], // { what, undo() } for every edit, move and paste made on this page
    peek: null, // where the hovered Parent / Child / trail button would take the selection
    trail: [], // elements we climbed up from, so ↓ can go back
    options: { ...defaults },
    point: null,
    result: null,
    raisedOver: new WeakSet(), // what stayOnTop() has already climbed over

    toggle() {
      if (this.active) this.stop();
      else this.start();
    },

    async start() {
      if (this.starting || this.host) return;
      this.starting = true;
      this.active = true;
      if (storage && this.ui) {
        try {
          Object.assign(this.options, await storage.get(defaults));
        } catch {
          /* keep defaults */
        }
      }
      try {
        this.clip = (await chrome.storage.local.get('clip')).clip || null;
      } catch {
        this.clip = null;
      }
      this.starting = false;
      if (!this.active || this.host) return;
      this.build();
      this.setMode('pick');
      window.addEventListener('keydown', this.onKey, true);
      for (const type of MOUSE_EVENTS) window.addEventListener(type, this.onMouse, true);
      const tick = () => {
        if (!this.active) return;
        this.stayOnTop();
        this.drawBox();
        this.raf = requestAnimationFrame(tick);
      };
      tick();
    },

    stop() {
      if (this.editing) this.endEdit(true); // what was typed stays
      this.active = false;
      this.placing = this.drop = this.press = this.remote = this.hole = null;
      this.swallowClick = this.owner = this.inside = false;
      cancelAnimationFrame(this.raf);
      window.removeEventListener('keydown', this.onKey, true);
      for (const type of MOUSE_EVENTS) window.removeEventListener(type, this.onMouse, true);
      this.host?.remove();
      this.host = this.target = this.peek = this.result = this.point = null;
      this.trail = [];
      if (this.ui) this.syncFrames(); // (active: false — the frames' pickers go too)
      if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
    },

    build() {
      const host = (this.host = document.createElement('dom-capture-ui'));
      host.setAttribute(DC.UI_ATTR, '');
      host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important';
      // A popover, so the overlay can join dropdowns and dialogs in the top layer, where no z-index
      // reaches. "hint" rather than "manual" so that showing it closes nothing of the page's, and so
      // that a press on it counts as a press on a popover — see handleMouse().
      host.setAttribute('popover', 'hint');
      const root = host.attachShadow({ mode: 'closed' });
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];

      // Takes the hit-test (so the page gets no :hover) and shows the cursor; the events
      // themselves are dealt with in handleMouse().
      this.catcher = h('div', { class: 'catcher' });
      this.box = h('div', { class: 'box' });
      this.tag = h('div', { class: 'tag' });
      this.ghost = h('div', { class: 'ghost' }); // the element being moved, while pointing at its destination
      this.mark = h('div', { class: 'mark' }); // the insertion line for "before" / "after"
      this.catcher.style.pointerEvents = 'auto';
      for (const el of [this.box, this.tag, this.ghost, this.mark]) el.style.pointerEvents = 'none';
      if (!this.ui) {
        // A frame's picker: the highlight only. The top frame's toolbar speaks for it.
        root.append(this.catcher, this.ghost, this.box, this.mark, this.tag);
        document.documentElement.appendChild(host);
        this.raise();
        return;
      }

      this.menu = h('div', { class: 'menu' });
      for (const [key, title, help] of OPTION_LABELS) {
        const input = h('input', { type: 'checkbox' });
        input.checked = !!this.options[key];
        input.addEventListener('change', () => {
          this.options[key] = input.checked;
          storage?.set({ [key]: input.checked });
        });
        this.menu.append(h('label', {}, input, h('span', {}, title), h('small', {}, help)));
      }

      this.barHint = h('span', { class: 'hint' });
      this.bar = h(
        'div',
        { class: 'bar' },
        h('span', { class: 'name' }, 'DOM Capture'),
        this.barHint,
        (this.captureButton = h('button', { class: 'primary', 'data-act': 'capture', onclick: () => this.captureTarget(), title: 'Copy the selection (Enter)' }, 'Capture')),
        (this.pasteButton = h('button', { 'data-act': 'paste', onclick: () => this.startPlace('paste') }, 'Paste')),
        (this.undoButton = h('button', { 'data-act': 'undo', onclick: () => this.undo(), title: `Undo the last edit, move or paste (${isMac ? '⌘' : 'Ctrl+'}Z)` }, 'Undo')),
        h('button', { onclick: () => this.toggleMenu(), title: 'Capture options' }, 'Options'),
        h('button', { onclick: () => this.stop(), title: 'Close' }, 'Close'),
      );

      // Shown once something is selected: walk the tree with clicks instead of pixel-hunting.
      this.moveButtons = {};
      const move = (act, label, title) => (this.moveButtons[act] = h('button', { 'data-act': act, title, onclick: (button) => (button.__el ? this.go(button.__el) : this.goRemote(act)) }, label));
      this.crumbs = h('div', { class: 'crumbs' });
      this.nav = h(
        'div',
        { class: 'nav' },
        h(
          'div',
          { class: 'moves' },
          move('parent', '↑ Parent', 'Select the parent (↑)'),
          move('child', '↓ Child', 'Select the first child — or go back down the way you came (↓)'),
          move('prev', '← Previous', 'Select the previous sibling (←)'),
          move('next', 'Next →', 'Select the next sibling (→)'),
        ),
        h(
          'div',
          { class: 'acts' },
          (this.editButton = h('button', { 'data-act': 'edit', title: 'Edit its text in place (E) — Enter keeps the change, Esc discards it', onclick: () => this.startEdit() }, '✎ Edit text')),
          h('button', { 'data-act': 'move', title: 'Move it elsewhere on the page: drag it there, or press M, point at where it goes and click. Shift+↑ / Shift+↓ swaps it with a neighbour', onclick: () => this.startPlace('move') }, '⇅ Move…'),
          h('button', { 'data-act': 'cut', title: 'Move it to another page — in any tab or window (X): it comes off this page and is kept to paste there with V', onclick: () => this.captureTarget({ cut: true }) }, '✂ Cut'),
          h('button', { class: 'danger', 'data-act': 'delete', title: 'Remove it from the page (Delete)', onclick: () => this.removeNode() }, '🗑 Delete'),
        ),
        this.crumbs,
      );
      this.panel = h('div', { class: 'panel', role: 'status' });

      for (const el of [this.menu, this.nav, this.bar, this.panel]) el.style.pointerEvents = 'auto';
      root.append(this.catcher, this.ghost, this.box, this.mark, this.tag, this.menu, this.nav, this.bar, this.panel);
      document.documentElement.appendChild(host);
      this.raise();
    },

    /** (Re-)enter the top layer, which puts the overlay above everything already in it. */
    raise() {
      try {
        if (this.host.matches(':popover-open')) this.host.hidePopover();
        this.host.showPopover();
      } catch {
        /* no popover support — the z-index still covers everything outside the top layer */
      }
    },

    /** A popover or dialog opened after us lands above us; so does one that closed us on its way in. */
    stayOnTop() {
      if (!this.point || this.mode === 'edit') return; // (editing lets the mouse through to the page on purpose)
      const top = document.elementFromPoint(...this.point);
      if (!top) return;
      if (top === this.host) {
        this.raisedOver = new WeakSet();
        return;
      }
      // Behind a modal dialog the overlay is inert and never wins the hit-test, however high it
      // is drawn — so raise once per blocker, not once per frame.
      let blocker = top;
      for (let a = top; a; a = DC.flatParent(a)) if (a.localName === 'dialog' && a.matches(':modal')) blocker = a;
      if (this.raisedOver.has(blocker)) return;
      this.raisedOver.add(blocker);
      this.raise();
    },

    setMode(mode, { quiet = false } = {}) {
      const was = this.mode;
      this.mode = mode;
      this.peek = null;
      this.catcher.classList.toggle('idle', !['pick', 'select', 'place'].includes(mode));
      // Editing needs the mouse to reach the page (to place the caret); handleMouse() still keeps it off everything else.
      this.catcher.style.pointerEvents = mode === 'edit' ? 'none' : 'auto';
      this.box.classList.toggle('locked', mode === 'select');
      this.box.classList.toggle('editing', mode === 'edit');
      this.box.classList.toggle('done', mode === 'done');
      this.tag.classList.toggle('locked', mode === 'select');
      this.tag.classList.toggle('editing', mode === 'edit');
      if (mode !== 'place') {
        this.box.classList.remove('drop', 'edge');
        this.tag.classList.remove('drop');
        this.catcher.classList.remove('grabbing');
        this.ghost.classList.remove('lifted');
        this.ghost.style.display = this.mark.style.display = 'none';
        this.drop = null;
      }
      if (mode !== 'select') this.catcher.classList.remove('grab');
      if (!this.ui) {
        if (!quiet && mode !== 'select' && mode !== 'busy' && (mode !== was || mode === 'place')) this.report(); // (select() reports itself, with its moves)
        return;
      }
      this.bar.style.display = mode === 'done' ? 'none' : 'flex';
      this.captureButton.style.display = mode === 'select' ? '' : 'none';
      this.refreshBar();
      this.nav.classList.toggle('open', mode === 'select');
      this.panel.classList.toggle('open', mode === 'done');
      this.menu.classList.remove('open');
      const k = (key) => h('kbd', {}, key);
      if (mode === 'pick') {
        this.barHint.replaceChildren('Click an element to select it  ·  ', k('Esc'), ' to quit');
      } else if (mode === 'select') {
        this.barHint.replaceChildren('Adjust the selection, then  ', k('Enter'), '  or');
      } else if (mode === 'edit') {
        this.barHint.replaceChildren('Type away  ·  ', k(this.editing?.el.localName === 'textarea' ? `${isMac ? '⌘' : 'Ctrl'}+Enter` : 'Enter'), ' keeps it  ·  ', k('Esc'), ' discards');
      } else if (mode === 'place' && this.placing.drag) {
        this.barHint.replaceChildren('Drag it to where it goes: near an edge = before / after, the middle = inside  ·  release to drop  ·  ', k('Esc'), ' cancels');
      } else if (mode === 'place') {
        this.barHint.replaceChildren(`Point at where to ${this.placing.kind === 'move' ? 'move' : 'paste'} it: near an edge = before / after, the middle = inside  ·  click or `, k('Enter'), ' to drop  ·  ', k('Esc'), ' cancels');
      } else if (mode === 'busy') {
        this.barHint.replaceChildren(h('span', { class: 'spin' }), 'Capturing styles…');
      }
      this.syncFrames();
    },

    /** Top only: tell every frame's picker what is going on, so it can follow (or stay out of the way). */
    syncFrames() {
      if (!this.ui) return;
      send({
        to: '*',
        cmd: 'sync',
        active: this.active,
        mode: this.mode,
        placing: this.placing ? { kind: this.placing.kind, drag: !!this.placing.drag } : null,
        owner: this.remote?.key || null,
        options: this.options,
      });
    },

    /** The Paste and Undo buttons come and go with what there is to paste and to undo. */
    refreshBar() {
      if (!this.ui) return;
      const idle = this.mode === 'pick' || this.mode === 'select';
      this.pasteButton.style.display = idle && this.clip ? '' : 'none';
      if (this.clip) {
        this.pasteButton.textContent = `Paste <${this.clip.label.replace(/[#.].*/, '')}>`;
        this.pasteButton.title = `Paste the last capture — ${this.clip.label} from ${this.clip.url} — into this page (V): point at where it goes, click to drop`;
      }
      this.undoButton.style.display = idle && this.undos.length ? '' : 'none';
      if (this.undos.length) this.undoButton.textContent = `Undo ${this.undos[this.undos.length - 1].what}`;
    },

    /** Topmost page element at a point, looking through our overlay and into shadow roots. */
    elementAt(x, y) {
      let el = document.elementsFromPoint(x, y).find((e) => e !== this.host) || null;
      for (let i = 0; el && i < 20; i++) {
        const sr = DC.shadowRootOf(el, {});
        const inner = sr?.elementsFromPoint(x, y).find((e) => e.getRootNode() === sr);
        if (!inner) break;
        el = inner;
      }
      return el && DC.normalizeRoot(el);
    },

    toggleMenu() {
      this.menu.style.bottom = `${this.mode === 'select' ? 76 + this.nav.offsetHeight : 68}px`; // clear of the selection panel
      this.menu.classList.toggle('open');
    },

    /** Pin `el` as the selection and point the Parent / Child / sibling buttons and the trail at its relatives. */
    select(el, { quiet = false } = {}) {
      this.target = el;
      if (this.remote) {
        // The selection comes back to this document: the frame that had it lets go.
        send({ to: this.remote.key, cmd: 'drop' });
        this.remote = null;
        try {
          window.focus();
        } catch {
          /* fine */
        }
      }
      if (this.mode !== 'select') this.setMode('select', { quiet: true });
      this.peek = null;
      const moves = this.movesFrom(el);
      if (!this.ui) {
        if (!quiet) this.report(moves);
        return;
      }
      this.syncFrames();
      for (const [act, button] of Object.entries(this.moveButtons)) {
        button.__el = moves[act];
        button.toggleAttribute('disabled', !moves[act]);
      }
      this.editButton.toggleAttribute('disabled', !editable(el));
      this.refreshBar();
      const chain = [];
      for (let a = el; a; a = parentOf(a)) chain.unshift(a);
      this.renderCrumbs(chain.map((a) => [DC.describe(a), () => this.go(a), a === el, a]));
    },

    /** The ancestor trail under the buttons: [label, action, current, element?] per step, the last few of them. */
    renderCrumbs(steps) {
      const shown = steps.slice(innerWidth < 700 ? -3 : -5);
      this.crumbs.replaceChildren(shown.length < steps.length ? '… › ' : '');
      shown.forEach(([label, run, on, el], i) => {
        const crumb = h('button', { title: label, onclick: run }, label);
        if (el) crumb.__el = el;
        if (on) crumb.className = 'on';
        this.crumbs.append(crumb, i === shown.length - 1 ? '' : ' › ');
      });
    },

    // ------------------------------------------------------------ frames: the top side

    /** Top: the selection is in a frame — the toolbar now speaks for that frame's picker. */
    adoptRemote(key, state) {
      this.target = null;
      this.trail = [];
      this.placing = this.editing = null;
      this.remote = { key, state };
      this.setMode('select');
      this.renderRemote();
    },

    renderRemote() {
      const { key, state } = this.remote;
      const frameEl = this.keyFrames.get(key) || this.hole; // (a frame inside a frame: the outer one)
      for (const [act, button] of Object.entries(this.moveButtons)) {
        button.__el = null;
        let ok = !!state.moves[act];
        if (act === 'parent' && !ok && frameEl?.isConnected) {
          button.__el = frameEl; // above the frame's <body> comes the <iframe> itself, on this page
          ok = true;
        }
        button.toggleAttribute('disabled', !ok);
      }
      this.editButton.toggleAttribute('disabled', !state.editable);
      this.refreshBar();
      const steps = [];
      if (frameEl?.isConnected) for (let a = frameEl; a; a = parentOf(a)) steps.unshift([DC.describe(a), () => this.go(a), false, a]);
      state.chain.forEach((label, i) => steps.push([label, () => send({ to: key, cmd: 'crumb', index: i }), i === state.chain.length - 1]));
      this.renderCrumbs(steps);
    },

    goRemote(act) {
      if (this.remote) send({ to: this.remote.key, cmd: 'go', act });
    },

    /**
     * The mouse is over an <iframe>. If a picker of ours answers from inside it, the overlay lets
     * the mouse through to it (a hole) and that picker takes over; until it answers — or if it
     * never does, because the extension may not run there — the iframe is an element like any other.
     */
    enterFrame(el) {
      const key = this.frameKeys.get(el);
      if (!key) {
        if (![...this.nonces.values()].includes(el)) {
          const nonce = crypto.randomUUID();
          this.nonces.set(nonce, el);
          setTimeout(() => this.nonces.delete(nonce), 3000);
          try {
            el.contentWindow.postMessage({ [PICK_MSG]: nonce }, '*');
          } catch {
            this.nonces.delete(nonce);
          }
        }
        return false;
      }
      if (this.hole !== el) {
        this.hole = el;
        this.catcher.style.pointerEvents = 'none';
        if (this.mode === 'pick') this.target = null;
        if (this.ui) this.syncFrames(); // (the frame may have been installed after the last sync)
      }
      return true;
    },

    leaveFrame() {
      if (!this.hole) return;
      const key = this.frameKeys.get(this.hole);
      this.hole = null;
      if (this.mode !== 'edit') this.catcher.style.pointerEvents = 'auto';
      if (key) send({ to: key, cmd: 'leave' });
    },

    /** Top: something a frame's picker reported. */
    onEvent(msg) {
      const { event, from } = msg;
      if (event === 'hello') {
        const el = this.nonces.get(msg.nonce);
        if (!el) return;
        this.nonces.delete(msg.nonce);
        this.frameKeys.set(el, from);
        this.keyFrames.set(from, el);
        return;
      }
      if (!this.ui || !this.active) return;
      if (event === 'enter') {
        if (this.mode === 'pick') this.target = null; // the frame draws its own box now
        return;
      }
      if (event === 'state') {
        const st = msg.state;
        const mine = this.remote?.key === from;
        if (st.mode === 'select') {
          this.adoptRemote(from, st);
        } else if (st.mode === 'pick') {
          if (mine) {
            this.remote = null;
            if (this.mode === 'place') this.placing = null;
            this.setModePick();
          } else if (this.mode === 'place' && this.placing?.kind === 'paste' && !this.placing.drag) this.cancelPlace(); // a frame's Esc while pasting
        } else if (st.mode === 'edit' && mine) {
          this.remote.state = st;
          this.setMode('edit');
        } else if (st.mode === 'place' && (mine || st.kind === 'paste')) {
          if (mine) this.remote.state = st;
          this.placing = { kind: st.kind, node: null, from: mine ? 'select' : 'pick', drag: !!st.drag, remote: from };
          this.press = null;
          this.setMode('place');
        }
        return;
      }
      if (event === 'did') {
        this.undos.push({ what: msg.what, frame: from });
        this.refreshBar();
      } else if (event === 'undo') this.undo();
      else if (event === 'stop') this.stop();
      else if (event === 'key') this.handleKey({ ...msg.key, preventDefault() {}, stopImmediatePropagation() {} });
      else if (event === 'result') this.takeResult(msg.result, msg.cut);
      else if (event === 'error') this.showError(Object.assign(new Error(msg.message), { debugLog: msg.debugLog }));
    },

    /** A frame's picker captured its selection: copy, keep and show it exactly as for one of our own. */
    async takeResult(result, cut) {
      this.result = result;
      this.log = result.debugLog;
      const copied = await copyText(result.snippet);
      if (!copied) this.log += '\n\n--- clipboard ---\nwriteText and execCommand("copy") both failed';
      result.kept = await this.saveClip(result);
      result.cut = cut;
      if (this.active) this.showResult(result, copied);
    },

    // ------------------------------------------------------------ frames: the frame side

    /** Frame: what the top needs to know to speak for this picker. */
    report(moves) {
      const el = this.target?.isConnected ? this.target : null;
      const m = el && (moves || this.movesFrom(el));
      const chain = [];
      for (let a = el; a; a = parentOf(a)) chain.unshift(DC.describe(a));
      send({
        to: 'top',
        event: 'state',
        state: {
          mode: this.mode,
          desc: el && DC.describe(el),
          chain,
          moves: m ? { parent: !!m.parent, child: !!m.child, prev: !!m.prev, next: !!m.next } : {},
          editable: !!el && editable(el),
          kind: this.placing?.kind || null,
          drag: !!this.placing?.drag,
        },
      });
    },

    /** Frame: a command from the top frame's toolbar or keys. */
    onCommand(msg) {
      const { cmd } = msg;
      if (cmd === 'sync') return this.onSync(msg);
      if (!this.active) return;
      switch (cmd) {
        case 'leave':
          this.inside = false;
          if (this.mode === 'pick') this.target = null;
          else if (this.mode === 'place') this.drop = null;
          break;
        case 'drop':
          if (this.editing) this.endEdit(true);
          this.placing = null;
          this.setModePick({ quiet: true });
          break;
        case 'go':
          if (this.target) this.go(this.movesFrom(this.target)[msg.act]);
          break;
        case 'crumb': {
          const chain = [];
          for (let a = this.target; a; a = parentOf(a)) chain.unshift(a);
          if (chain[msg.index]) this.go(chain[msg.index]);
          break;
        }
        case 'capture':
          this.options = msg.options || this.options;
          this.captureTarget({ cut: !!msg.cut });
          break;
        case 'edit':
          this.startEdit();
          break;
        case 'commit':
          this.commitEdit();
          break;
        case 'cancelEdit':
          this.cancelEdit();
          break;
        case 'move':
          this.startPlace('move');
          break;
        case 'cancel':
          if (this.mode === 'place') this.cancelPlace();
          break;
        case 'release':
          if (this.placing?.drag) this.drop ? this.confirmDrop() : this.cancelPlace();
          break;
        case 'nudge':
          this.nudge(msg.dir);
          break;
        case 'delete':
          this.removeNode();
          break;
        case 'undo':
          this.undo();
          break;
      }
    },

    /** Frame: follow the top frame's mode — pick along, point at where to paste, or stay out of the way. */
    onSync(msg) {
      if (!msg.active) return void (this.active && this.stop());
      this.options = { ...this.options, ...(msg.options || {}) };
      if (!this.active) {
        this.start();
        return; // (start() is async: the next sync catches up)
      }
      if (!this.host) return;
      this.owner = msg.owner === KEY;
      const kind = msg.placing?.kind;
      if (msg.mode === 'place' && kind === 'paste') {
        if (this.mode !== 'place' || this.placing?.kind !== 'paste') {
          if (this.editing) this.endEdit(true);
          this.placing = { kind: 'paste', node: null, from: this.owner && this.mode === 'select' ? 'select' : 'pick', drag: false };
          this.setMode('place', { quiet: true });
        }
        return;
      }
      if (msg.mode === 'place' && kind === 'move' && !(this.owner && this.mode === 'place')) {
        // Something on another page (or in another frame) is on the move: nothing can land here.
        if (this.mode !== 'place') {
          this.placing = { kind: 'move', node: null, from: this.owner && this.mode === 'select' ? 'select' : 'pick', drag: false, foreign: true };
          this.setMode('place', { quiet: true });
        }
        return;
      }
      if (msg.mode !== 'place' && this.mode === 'place' && (this.placing?.foreign || this.placing?.kind === 'paste')) {
        const { from } = this.placing;
        this.placing = null;
        if (from === 'select' && this.owner && this.target?.isConnected) this.select(this.target, { quiet: true });
        else this.setModePick({ quiet: true });
      }
      if (!this.owner && (this.mode === 'select' || this.mode === 'edit' || (this.mode === 'place' && this.placing?.kind === 'move'))) {
        if (this.editing) this.endEdit(true);
        this.placing = null;
        this.setModePick({ quiet: true });
      }
    },

    /** Where each step leads from `el` in the tree as rendered (slots resolved, shadow roots entered). */
    movesFrom(el) {
      // The first child with a box — looking through boxless wrappers (<slot>, display: contents).
      const firstBox = (from, depth = 0) => {
        for (const n of DC.flatChildren(from, {})) {
          if (rendered(n)) return n;
          const inner = n.nodeType === 1 && depth < 6 && !n.hasAttribute(DC.UI_ATTR) ? firstBox(n, depth + 1) : null;
          if (inner) return inner;
        }
        return null;
      };
      const parent = parentOf(el);
      let child = this.trail[this.trail.length - 1] || firstBox(el);
      child = child && DC.normalizeRoot(child); // (snaps back for children of an <svg>)
      const siblings = parent ? DC.flatChildren(DC.flatParent(el), {}).filter(rendered) : [];
      const i = siblings.indexOf(el);
      return { parent, child: child !== el ? child : null, prev: (i > 0 && siblings[i - 1]) || null, next: (i >= 0 && siblings[i + 1]) || null };
    },

    /** Move the selection to a relative, remembering the way back down when climbing. */
    go(el) {
      if (!el) return;
      if (this.remote) {
        this.trail = []; // coming out of a frame: the <iframe> (or an ancestor of it) on this page
        return this.select(el);
      }
      if (!this.target || el === this.target) return;
      if (el === this.trail[this.trail.length - 1]) this.trail.pop();
      else {
        const climbed = [];
        let a = this.target;
        while (a && a !== el) {
          climbed.push(a);
          a = parentOf(a);
        }
        this.trail = a ? this.trail.concat(climbed) : [];
      }
      this.select(el);
    },

    /** The button / checkbox row of our own UI at a point (or just the panel it is in). */
    controlAt(x, y) {
      if (!this.ui) return null;
      const inside = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      };
      const layer = [this.menu, this.panel, this.nav, this.bar].find(inside);
      return layer ? [...layer.querySelectorAll('button, label')].find(inside) || layer : null;
    },

    onMouse: (e) => picker.handleMouse(e),
    handleMouse(e) {
      // Untrusted events are the page's own business.
      if (!e.isTrusted || !this.host) return;
      if (this.mode === 'edit') return this.handleEditMouse(e);
      e.preventDefault();
      e.stopImmediatePropagation();
      // A press and release on the same popover (or both outside of any) light-dismisses the page's
      // popover="auto" elements, and that cannot be cancelled. Capturing the pointer sends the
      // release to <html> (no popover) while the press went to the overlay (a hint popover): the
      // two never match, so nothing closes.
      if (e.type === 'pointerdown') {
        try {
          document.documentElement.setPointerCapture(e.pointerId);
        } catch {
          /* pointer already gone */
        }
      }
      // Our controls are found by geometry, not by event target: behind a modal dialog the overlay
      // is inert and the browser targets the dialog instead.
      const control = this.controlAt(e.clientX, e.clientY);
      if (e.type === 'mousemove') this.peek = (this.mode === 'select' && control?.__el) || null;
      // Dragging the selection moves it: a press on it, then movement, then release where it goes.
      // (Pointer events, not mouse events: cancelling pointerdown above stops mousedown/mousemove from ever coming.)
      if (e.type === 'pointerdown' && e.button === 0 && (this.mode === 'select' || this.mode === 'pick') && !control) {
        const el = this.mode === 'pick' || this.onTarget(e.clientX, e.clientY) ? this.target : this.elementAt(e.clientX, e.clientY);
        this.press = el ? [e.clientX, e.clientY, el] : null; // (dragging something that is not selected selects it first)
      }
      if (e.type === 'pointermove' && (this.press || this.placing?.drag)) this.onMove(e);
      if (e.type === 'pointerup' || e.type === 'pointercancel') {
        this.press = null;
        if (this.placing?.drag) {
          this.swallowClick = true; // the click that follows this release is not a new selection
          if (this.placing.remote) send({ to: this.placing.remote, cmd: 'release' }); // a drag that started in a frame, released out here
          else this.drop ? this.confirmDrop() : this.cancelPlace();
          return;
        }
      }
      if (e.type === 'click' && this.swallowClick) {
        this.swallowClick = false;
        return;
      }
      if (control) {
        if (e.type === 'click') this.activate(control);
      } else if (e.type === 'mousemove') this.onMove(e);
      else if (e.type === 'click') this.mode === 'place' ? this.confirmDrop() : this.onClick(e);
      else if (e.type === 'contextmenu') this.mode === 'place' ? this.cancelPlace() : this.ui ? this.stop() : send({ to: 'top', event: 'stop' });
    },

    onTarget(x, y) {
      const r = this.target?.isConnected && this.target.getBoundingClientRect();
      return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    },

    /** While editing, the element being edited gets the mouse (caret, selection); everything else on the page still does not. */
    handleEditMouse(e) {
      const control = this.controlAt(e.clientX, e.clientY);
      if (!control) {
        // The element being edited — or, for a frame's element, the frame — gets the mouse.
        const el = this.editing?.el || (this.remote && (this.keyFrames.get(this.remote.key) || this.hole));
        const r = el?.isConnected && el.getBoundingClientRect();
        const onIt = r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        if (onIt || (this.editing && e.composedPath().includes(this.editing.el))) return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type !== 'click') return;
      if (control) this.activate(control);
      else this.commitEdit(); // a click elsewhere on the page keeps the change, like leaving any field
    },

    /**
     * Do what a click on one of our controls would — without dispatching one. A synthetic click is
     * composed: it would travel through the page's document, where a "click outside" handler
     * takes it for a reason to close the very dropdown being captured.
     */
    activate(control) {
      if (control.localName === 'label') {
        const input = control.querySelector('input');
        input.checked = !input.checked;
        input.dispatchEvent(new Event('change'));
      } else if (!control.disabled) control.__run?.(control);
    },

    onClick(e) {
      // The first click pins what is highlighted; a later one moves the selection somewhere else.
      const el = this.mode === 'pick' ? this.target : this.mode === 'select' ? this.elementAt(e.clientX, e.clientY) : null;
      if (!el) return;
      if (el !== this.target) this.trail = [];
      this.select(el);
    },

    onMove(e) {
      this.point = [e.clientX, e.clientY];
      if (!this.ui && !this.inside) {
        this.inside = true;
        send({ to: 'top', event: 'enter' });
      }
      // Over an <iframe> with a picker of ours inside: open the overlay there and let it take over.
      const under = this.elementAt(e.clientX, e.clientY);
      if (isFrame(under) && !this.press && ['pick', 'select', 'place'].includes(this.mode) && this.enterFrame(under)) return;
      this.leaveFrame();
      if (this.mode === 'place') {
        this.drop = this.dropAt(e.clientX, e.clientY);
        return;
      }
      if (this.press) {
        if (!(e.buttons & 1)) this.press = null; // the release happened off-window
        else if (Math.hypot(e.clientX - this.press[0], e.clientY - this.press[1]) > 4) {
          const el = this.press[2];
          if (!el?.isConnected) return void (this.press = null);
          if (el !== this.target) this.trail = [];
          this.select(el);
          return this.startPlace('move', { drag: true });
        }
      }
      if (this.mode === 'select') {
        this.catcher.classList.toggle('grab', this.onTarget(e.clientX, e.clientY));
        return;
      }
      if (this.mode !== 'pick') return;
      const el = this.elementAt(e.clientX, e.clientY);
      if (el && el !== this.target) {
        this.target = el;
        this.trail = [];
      }
    },

    onKey: (e) => picker.handleKey(e),
    handleKey(e) {
      const swallow = () => {
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      if (this.mode === 'edit') {
        const textarea = this.editing?.el.localName === 'textarea';
        if (e.key === 'Escape') {
          swallow();
          this.cancelEdit();
        } else if (e.key === 'Enter' && !e.shiftKey && (textarea ? cmd(e) : !e.altKey)) {
          swallow();
          this.commitEdit();
        } else e.stopImmediatePropagation(); // the browser still types; the page's own hotkeys stay out of it
        return;
      }
      if (this.mode === 'place') {
        if (e.key === 'Escape') {
          swallow();
          this.cancelPlace();
        } else if (e.key === 'Enter') {
          swallow();
          this.confirmDrop();
        }
        return;
      }
      if (e.key === 'Escape') {
        swallow();
        if (this.mode !== 'select') return this.ui ? this.stop() : send({ to: 'top', event: 'stop' });
        this.setModePick();
        if (this.point) this.target = this.elementAt(...this.point); // straight back to following the mouse
        return;
      }
      if (this.mode !== 'pick' && this.mode !== 'select') return;
      const plain = !e.altKey && !e.ctrlKey && !e.metaKey;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (cmd(e) && key === 'z' && !e.shiftKey) {
        swallow();
        return this.ui ? this.undo() : send({ to: 'top', event: 'undo' });
      }
      if ((plain && key === 'v') || (cmd(e) && key === 'v')) {
        swallow();
        return this.startPlace('paste');
      }
      if (!this.target) {
        // A frame with nothing under the mouse or selected: the key is for the top frame's selection.
        if (!this.ui && this.mode === 'pick') send({ to: 'top', event: 'key', key: { key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey } });
        if (!this.remote) return;
      }
      const act = { ArrowUp: 'parent', ArrowDown: 'child', ArrowLeft: 'prev', ArrowRight: 'next' }[e.key];
      if (act) {
        swallow();
        // Pins the selection too: a nudge of the mouse must not undo the climb.
        if (this.mode === 'pick' && this.target) this.select(this.target);
        if (e.shiftKey) this.nudge(act === 'parent' || act === 'prev' ? -1 : 1); // Shift: move the element itself past a sibling
        else if (this.remote) this.moveButtons[act].__el ? this.go(this.moveButtons[act].__el) : this.goRemote(act);
        else {
          const to = this.movesFrom(this.target)[act];
          // A frame at its <body>: the next parent up is the <iframe> itself, which the top frame selects.
          if (!to && act === 'parent' && !this.ui) send({ to: 'top', event: 'key', key: { key: e.key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false } });
          else this.go(to);
        }
      } else if (e.key === 'Enter' || (cmd(e) && key === 'c')) {
        swallow();
        this.captureTarget();
      } else if ((plain && key === 'x') || (cmd(e) && key === 'x')) {
        swallow();
        if (this.mode === 'pick' && this.target) this.select(this.target);
        this.captureTarget({ cut: true });
      } else if (plain && (e.key === 'Delete' || e.key === 'Backspace')) {
        swallow();
        if (this.mode === 'pick' && this.target) this.select(this.target);
        this.removeNode();
      } else if (plain && key === 'e') {
        swallow();
        if (this.mode === 'pick' && this.target) this.select(this.target);
        this.startEdit();
      } else if (plain && key === 'm') {
        swallow();
        if (this.mode === 'pick' && this.target) this.select(this.target);
        this.startPlace('move');
      }
    },

    // ------------------------------------------------------------ editing the text in place

    startEdit() {
      if (this.remote) return send({ to: this.remote.key, cmd: 'edit' });
      const el = this.target;
      if (!el?.isConnected || !editable(el) || this.mode === 'edit') return;
      const control = isTextControl(el);
      // Kept as nodes, not as HTML: putting back a string would run into a page's Trusted Types policy.
      const saved = control ? el.value : [...el.childNodes].map((n) => n.cloneNode(true));
      this.editing = { el, saved, control, hadAttr: el.getAttribute('contenteditable') };
      if (!control) {
        el.setAttribute('contenteditable', 'plaintext-only'); // text only: no accidental bold, no pasted markup
        if (!el.isContentEditable) el.setAttribute('contenteditable', 'true');
      }
      this.setMode('edit');
      try {
        el.focus({ preventScroll: true });
        if (control) el.select();
        else {
          const range = document.createRange();
          range.selectNodeContents(el);
          const sel = getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } catch {
        /* not focusable after all — the user can still click into it */
      }
    },

    /** Take the element out of editing; `keep` decides whether what was typed stays. */
    endEdit(keep) {
      const { el, saved, control, hadAttr } = this.editing;
      this.editing = null;
      if (!keep) {
        if (control) el.value = saved;
        else el.replaceChildren(...saved);
      }
      if (!control) {
        if (hadAttr === null) el.removeAttribute('contenteditable');
        else el.setAttribute('contenteditable', hadAttr);
      }
      try {
        getSelection()?.removeAllRanges();
        el.blur();
      } catch {
        /* fine */
      }
      return { el, saved, control };
    },

    commitEdit() {
      if (!this.editing) return void (this.remote && send({ to: this.remote.key, cmd: 'commit' }));
      const { el, saved, control } = this.endEdit(true);
      const same = control ? el.value === saved : saved.length === el.childNodes.length && saved.every((n, i) => n.isEqualNode(el.childNodes[i]));
      if (!same) this.did('edit', () => (control ? (el.value = saved) : el.replaceChildren(...saved)));
      this.select(el);
    },

    cancelEdit() {
      if (!this.editing) return void (this.remote && send({ to: this.remote.key, cmd: 'cancelEdit' }));
      const { el } = this.endEdit(false);
      this.select(el);
    },

    /** Remember how to undo something just done to this document (and, from a frame, tell the top so Undo stays in order). */
    did(what, undo) {
      this.undos.push({ what, undo });
      if (!this.ui) send({ to: 'top', event: 'did', what });
      else this.refreshBar();
    },

    // ------------------------------------------------------------ moving and pasting

    /** Start pointing at a destination — for the selection ('move') or for the last capture ('paste'). */
    startPlace(kind, { drag = false } = {}) {
      if (this.mode !== 'pick' && this.mode !== 'select') return;
      if (kind === 'paste' && !this.clip) return;
      if (kind === 'move' && this.remote) return send({ to: this.remote.key, cmd: 'move' });
      if (kind === 'move' && !this.target?.isConnected) return;
      this.placing = { kind, node: kind === 'move' ? this.target : null, from: this.mode, drag, grabbed: drag && this.press ? this.press.slice(0, 2) : null };
      this.press = null;
      this.setMode('place');
      this.catcher.classList.toggle('grabbing', drag);
      this.ghost.classList.toggle('lifted', drag);
      this.drop = this.point ? this.dropAt(...this.point) : null;
    },

    /** Take the selection off the page (Undo brings it back). */
    removeNode() {
      if (this.remote) return send({ to: this.remote.key, cmd: 'delete' });
      const el = this.target;
      if (!el?.isConnected || el === document.body || this.mode !== 'select') return;
      const parent = el.parentNode;
      const next = el.nextSibling;
      const up = parentOf(el);
      el.remove();
      this.did('delete', () => parent.insertBefore(el, next?.parentNode === parent ? next : null));
      this.trail = [];
      if (up?.isConnected) this.select(up);
      else this.setModePick();
    },

    cancelPlace() {
      const { node, from, drag, remote } = this.placing || {};
      if (drag) this.swallowClick = true; // (the button is still down: its release must not reselect)
      this.placing = null;
      if (remote && this.ui) {
        send({ to: remote, cmd: 'cancel' });
        if (this.remote) return this.adoptRemote(this.remote.key, this.remote.state);
      }
      if (from === 'select' && node?.isConnected) this.select(node);
      else if (from === 'select' && this.target?.isConnected) this.select(this.target);
      else if (from === 'select' && this.remote) this.adoptRemote(this.remote.key, this.remote.state);
      else this.setModePick();
    },

    /** What the pointer at (x, y) means as a destination: which element, and before / after / inside it. */
    dropAt(x, y) {
      const el = this.elementAt(x, y);
      if (!el) return null;
      const moving = this.placing?.node;
      if (this.placing?.kind === 'move' && !moving) return null; // what is on the move lives in another document
      if (moving && within(moving, el)) return null; // nothing can go inside itself
      // Over a container — a list, a stack, a flex row — the drop goes into the nearest gap between
      // its children, so a spot in the padding or between two items means exactly that.
      if (canHold(el)) {
        const kids = DC.flatChildren(el, {}).filter((n) => rendered(n) && n !== moving);
        let best = null;
        for (const kid of kids) {
          const kr = kid.getBoundingClientRect();
          const row = inRow(kid);
          const [pos, lo, hi] = row ? [x, kr.left, kr.right] : [y, kr.top, kr.bottom];
          const [cross, clo, chi] = row ? [y, kr.top, kr.bottom] : [x, kr.left, kr.right];
          const gap = (pos < lo ? lo - pos : pos > hi ? pos - hi : 0) + (cross < clo ? clo - cross : cross > chi ? cross - chi : 0);
          if (!best || gap < best.gap) best = { kid, gap, row, where: pos < (lo + hi) / 2 ? 'before' : 'after' };
        }
        if (best) return { ref: DC.normalizeRoot(best.kid), where: best.where, row: best.row };
      }
      const r = el.getBoundingClientRect();
      const row = inRow(el);
      const t = row ? (x - r.left) / (r.width || 1) : (y - r.top) / (r.height || 1);
      let where;
      if (el === document.body) where = 'inside';
      else if (!canHold(el)) where = t < 0.5 ? 'before' : 'after';
      else where = t < 0.3 ? 'before' : t > 0.7 ? 'after' : 'inside';
      return { ref: el, where, row };
    },

    confirmDrop() {
      const d = this.drop;
      const { kind, node } = this.placing || {};
      if (!kind || !d?.ref?.isConnected) return;
      this.placing = null;
      if (kind === 'move') this.moveNode(node, d.ref, d.where);
      else this.paste(d.ref, d.where);
    },

    /**
     * Put `node` before / after / inside `ref`, remembering where it came from. Landing under a
     * different parent, it keeps its look: every style the old context gave it — a descendant
     * rule's padding, an inherited font, a `.stack > * + *` margin — is pinned inline where the new
     * context would have changed it. A reorder among siblings is left alone, so `:first-child`
     * rules can do their job.
     */
    moveNode(node, ref, where) {
      const parent = node.parentNode;
      const next = node.nextSibling;
      if (!parent || !node.isConnected || within(node, ref)) return;
      const dest = where === 'inside' ? DC.shadowRootOf(ref, {}) || ref : ref.parentNode;
      const before = dest !== parent ? snapshotStyles(node) : null;
      put([node], ref, where);
      const pinned = before ? pinStyles(before) : [];
      this.did('move', () => {
        for (const [el, css] of pinned) el.style.cssText = css;
        return parent.insertBefore(node, next?.parentNode === parent ? next : null);
      });
      this.trail = [];
      this.select(node);
    },

    /** Shift+↑ / Shift+↓: swap the selection with the sibling before / after it. */
    nudge(dir) {
      if (this.remote) return send({ to: this.remote.key, cmd: 'nudge', dir });
      const el = this.target;
      if (!el?.isConnected) return;
      const moves = this.movesFrom(el);
      const sibling = dir < 0 ? moves.prev : moves.next;
      if (sibling) this.moveNode(el, sibling, dir < 0 ? 'before' : 'after');
    },

    /**
     * Paste the last capture next to / into `ref`. Its <style> becomes a constructable stylesheet on
     * the tree scope the element lands in (document or shadow root): unlike a <style> element, a
     * page's Content-Security-Policy cannot block it. The markup goes through DOMParser, which no
     * Trusted Types policy objects to.
     */
    paste(ref, where) {
      const clip = this.clip;
      if (!clip || !ref?.isConnected) return;
      const doc = new DOMParser().parseFromString(clip.snippet, 'text/html');
      const css = [...doc.querySelectorAll('head > style, body > style')].map((s) => (s.remove(), s.textContent)).join('\n');
      const nodes = [...doc.body.childNodes].filter((n) => n.nodeType === 1).map((n) => document.adoptNode(n));
      if (!nodes.length) return;
      const scope = where === 'inside' ? DC.shadowRootOf(ref, {}) || ref.getRootNode() : ref.getRootNode();
      const sheet = new CSSStyleSheet();
      try {
        sheet.replaceSync(css);
        sheet.replaceSync(insist(sheet.cssRules));
      } catch {
        /* nothing usable — the markup still goes in */
      }
      scope.adoptedStyleSheets = [...scope.adoptedStyleSheets, sheet];
      put(nodes, ref, where);
      this.did('paste', () => {
        for (const n of nodes) n.remove();
        scope.adoptedStyleSheets = scope.adoptedStyleSheets.filter((s) => s !== sheet);
      });
      this.trail = [];
      this.select(nodes[0]);
    },

    undo() {
      const last = this.undos.pop();
      if (!last) return;
      if (last.frame) {
        send({ to: last.frame, cmd: 'undo' }); // it happened in a frame: that picker undoes it and reports
        return this.refreshBar();
      }
      let back = null;
      try {
        back = last.undo(); // (putting a node back returns it)
      } catch (err) {
        console.warn('[DOM Capture] could not undo:', err);
      }
      if (back instanceof Node && back.isConnected && back.nodeType === 1) this.select(back);
      else if (this.mode === 'select' && this.target?.isConnected) this.select(this.target);
      else this.setModePick();
      this.refreshBar();
    },

    /** Keep the capture where any page can get at it, so it can be pasted there. */
    async saveClip(result) {
      const clip = { snippet: result.snippet, label: result.label, url: location.href, at: Date.now() };
      try {
        await chrome.storage.local.set({ clip });
        this.clip = clip;
        return true;
      } catch (err) {
        console.warn('[DOM Capture] the capture was not kept for pasting:', err);
        this.clip = clip; // (still pasteable on this page)
        return false;
      }
    },

    /** Fit one of our fixed boxes to a rect. */
    fit(box, r) {
      box.style.display = 'block';
      box.style.width = `${Math.max(r.width, 2)}px`;
      box.style.height = `${Math.max(r.height, 2)}px`;
      box.style.transform = `translate(${r.left}px, ${r.top}px)`;
    },

    drawBox() {
      if (this.mode === 'place') return this.drawDrop();
      const el = this.peek || (this.remote ? null : this.target); // (a frame's selection is drawn by the frame)
      this.box.classList.toggle('peek', !!this.peek);
      if (!el || !el.isConnected) {
        this.box.style.display = this.tag.style.display = 'none';
        return;
      }
      const r = el.getBoundingClientRect();
      this.fit(this.box, r);

      const text = (this.mode === 'edit' ? 'Editing ' : '') + DC.describe(el);
      const size = `${Math.round(r.width)} × ${Math.round(r.height)}`;
      if (this.tag.dataset.k !== text + size) {
        this.tag.dataset.k = text + size;
        this.tag.replaceChildren(text, h('b', {}, size));
      }
      this.tag.style.display = this.mode === 'done' ? 'none' : 'block';
      const top = r.top >= 28 ? r.top - 26 : Math.min(r.bottom + 4, innerHeight - 26);
      this.tag.style.transform = `translate(${Math.max(4, Math.min(r.left, innerWidth - 200))}px, ${Math.max(4, top)}px)`;
    },

    /** Pointing at a destination: outline the element being moved, and show where the drop would land. */
    drawDrop() {
      const moving = this.placing?.node;
      if (moving?.isConnected) {
        const r = moving.getBoundingClientRect();
        const [gx, gy] = this.placing.grabbed || [0, 0];
        // While dragging, the ghost travels with the pointer; otherwise it marks where the element is.
        const [dx, dy] = this.placing.drag && this.point ? [this.point[0] - gx, this.point[1] - gy] : [0, 0];
        this.fit(this.ghost, { left: r.left + dx, top: r.top + dy, width: r.width, height: r.height });
      } else this.ghost.style.display = 'none';
      const d = this.drop;
      if (!d?.ref?.isConnected) {
        this.box.style.display = this.tag.style.display = this.mark.style.display = 'none';
        return;
      }
      const r = d.ref.getBoundingClientRect();
      this.fit(this.box, r);
      this.box.classList.add('drop');
      this.box.classList.toggle('edge', d.where !== 'inside');
      if (d.where === 'inside') this.mark.style.display = 'none';
      else if (d.row) this.fit(this.mark, { left: (d.where === 'before' ? r.left : r.right) - 2, top: r.top, width: 4, height: r.height });
      else this.fit(this.mark, { left: r.left, top: (d.where === 'before' ? r.top : r.bottom) - 2, width: r.width, height: 4 });
      const verb = this.placing.kind === 'move' ? 'Move' : 'Paste';
      const text = `${verb} ${d.where === 'inside' ? 'into' : d.where} ${DC.describe(d.ref)}`;
      if (this.tag.dataset.k !== text) {
        this.tag.dataset.k = text;
        this.tag.replaceChildren(text);
      }
      this.tag.classList.add('drop');
      this.tag.style.display = 'block';
      const top = r.top >= 28 ? r.top - 26 : Math.min(r.bottom + 4, innerHeight - 26);
      this.tag.style.transform = `translate(${Math.max(4, Math.min(r.left, innerWidth - 200))}px, ${Math.max(4, top)}px)`;
    },

    async captureTarget({ cut = false } = {}) {
      if (this.remote) {
        this.setMode('busy');
        return send({ to: this.remote.key, cmd: 'capture', cut, options: this.options });
      }
      const el = this.target;
      if (!el?.isConnected) return;
      this.setMode('busy', { quiet: true });
      // Let the "Capturing…" state paint before the synchronous style walk.
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      try {
        // Frames that loaded after the toolbar click need the capture script too.
        await ask({ type: 'dom-capture:refresh-frames' }, 1500);
        const result = (this.result = await DC.capture(el, this.options));
        this.log = result.debugLog;
        const takeOff = () => {
          // Off this page, and kept — Undo brings it back here, V puts it on any other page.
          const parent = el.parentNode;
          const next = el.nextSibling;
          el.remove();
          this.did('cut', () => parent.insertBefore(el, next?.parentNode === parent ? next : null));
        };
        if (!this.ui) {
          // A frame: the top frame copies, keeps and shows it.
          const { snippet, page, label, stats, warnings, notes, debugLog, blockedFrames } = result;
          const doCut = cut && el.isConnected && el !== document.body;
          if (doCut) takeOff();
          send({ to: 'top', event: 'result', result: { snippet, page, label, stats, warnings, notes: notes || [], debugLog, blockedFrames: blockedFrames || [] }, cut: doCut });
          if (doCut) this.setModePick({ quiet: true });
          else this.setMode('select', { quiet: true });
          return;
        }
        const copied = await copyText(result.snippet);
        if (!copied) this.log += '\n\n--- clipboard ---\nwriteText and execCommand("copy") both failed';
        result.kept = await this.saveClip(result);
        if (cut && el.isConnected && el !== document.body) {
          takeOff();
          result.cut = true;
        }
        if (!this.active) return;
        this.showResult(result, copied);
      } catch (err) {
        console.error('[DOM Capture]', err);
        if (!this.active) return;
        if (this.ui) this.showError(err);
        else {
          send({ to: 'top', event: 'error', message: String(err?.message || err), debugLog: err?.debugLog || String(err?.stack || err) });
          this.setMode('select', { quiet: true });
        }
      }
    },

    showResult(result, copied) {
      const { stats } = result;
      const kb = stats.bytes < 10240 ? `${(stats.bytes / 1024).toFixed(1)} KB` : `${Math.round(stats.bytes / 1024)} KB`;
      const title = h('h1', copied ? {} : { class: 'err' }, h('i', {}, copied ? '✓' : '!'), result.cut ? 'Cut — ready to paste on another page' : copied ? 'Copied to clipboard' : 'Captured — but the clipboard was blocked');
      const actions = h(
        'div',
        { class: 'actions' },
        h('button', { class: 'primary', onclick: () => this.setModePick() }, 'Pick another'),
        result.cut ? h('button', { onclick: () => this.undo(), title: 'Put it back where it was' }, 'Undo cut') : h('button', { onclick: () => this.adjust(), title: 'Back to this selection — to take its parent instead, say' }, 'Adjust selection'),
        h('button', { onclick: (button) => this.recopy(button) }, 'Copy again'),
        h('button', { onclick: () => this.download() }, 'Download .html'),
        h('button', { onclick: () => this.preview() }, 'Preview'),
        h('button', { onclick: (button) => this.copyLog(button), title: 'Timeline, options and warnings — handy for bug reports' }, 'Copy debug log'),
        h('button', { 'data-act': 'done', onclick: () => this.stop() }, 'Done'),
      );
      this.panel.replaceChildren(
        title,
        h('code', {}, `<${result.label}>`),
        h('p', {}, `${stats.elements} element${stats.elements === 1 ? '' : 's'} · ${stats.rules} CSS rules · ${kb}. Paste it into any HTML file — the styles travel with it.`),
        h(
          'p',
          {},
          result.cut
            ? `It is off this page (Undo puts it back). ${result.kept ? 'Switch to the page it goes on — any tab or window — start DOM Capture there and press V, then point at where it goes.' : 'It was too big to keep for pasting, but it is on your clipboard.'}`
            : result.kept
              ? 'Or paste it into a page: open the page, start DOM Capture and press V, then point at where it goes.'
              : 'Too big to keep for pasting into other pages (it is still on your clipboard).',
        ),
      );
      const remarks = [...result.warnings, ...(result.notes || [])];
      if (remarks.length) this.panel.append(h('ul', {}, ...remarks.slice(0, 5).map((w) => h('li', {}, w))));
      if (result.blockedFrames?.length) {
        const sites = result.blockedFrames.map((o) => new URL(o).host).join(', ');
        const allow = h('button', { class: 'primary', 'data-act': 'allow-frames', onclick: (button) => this.allowFrames(button), title: `Let DOM Capture read ${sites}, then capture again` }, 'Allow & capture the iframe too');
        actions.prepend(allow);
        actions.querySelector('.primary + .primary')?.classList.remove('primary');
      }
      this.panel.append(actions);
      this.setMode('done');
    },

    showError(err) {
      this.log = err?.debugLog || `=== DOM Capture debug log ===\npage: ${location.href}\nbrowser: ${navigator.userAgent}\n\n--- error ---\n${err?.stack || err}`;
      this.panel.replaceChildren(
        h('h1', { class: 'err' }, h('i', {}, '!'), 'Could not capture that element'),
        h('code', {}, String(err?.message || err)),
        h('p', {}, 'Copy the debug log and send it along with the page URL — it says exactly where the capture stopped.'),
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'primary', onclick: (button) => this.copyLog(button) }, 'Copy debug log'),
          h('button', { onclick: () => this.setModePick() }, 'Try another'),
          h('button', { onclick: () => this.stop() }, 'Close'),
        ),
      );
      this.setMode('done');
    },

    /** The capture met an <iframe> from a site the extension may not read: ask for that site, then go again. */
    async allowFrames(button) {
      const reply = await ask({ type: 'dom-capture:allow-frames', origins: this.result?.blockedFrames || [] }, 120000);
      if (!this.active || this.mode !== 'done') return;
      if (reply?.ok) this.captureTarget();
      else button.textContent = reply?.asking ? 'Waiting for your OK in the new window…' : 'Not allowed — the iframe keeps its src';
    },

    async copyLog(button) {
      const label = button.textContent;
      const ok = await copyText(this.log || 'No log recorded.');
      button.textContent = ok ? 'Log copied ✓' : 'Clipboard blocked';
      setTimeout(() => (button.textContent = label), 1500);
    },

    setModePick({ quiet = false } = {}) {
      this.result = null;
      this.target = null;
      this.trail = [];
      if (this.remote) {
        send({ to: this.remote.key, cmd: 'drop' });
        this.remote = null;
      }
      this.setMode('pick', { quiet });
    },

    adjust() {
      if (this.remote) return this.adoptRemote(this.remote.key, this.remote.state);
      if (!this.target?.isConnected) return this.setModePick();
      this.result = null;
      this.select(this.target);
    },

    async recopy(button) {
      if (!this.result) return;
      const ok = await copyText(this.result.snippet);
      button.textContent = ok ? 'Copied ✓' : 'Clipboard blocked';
      setTimeout(() => (button.textContent = 'Copy again'), 1500);
    },

    pageUrl() {
      if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = URL.createObjectURL(new Blob([this.result.page], { type: 'text/html' }));
      return this.blobUrl;
    },

    download() {
      if (!this.result) return;
      const name = this.result.label.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40) || 'element';
      const a = h('a', { href: this.pageUrl(), download: `${name}.html` });
      a.click();
    },

    preview() {
      if (this.result) window.open(this.pageUrl(), '_blank', 'noopener');
    },
  };

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* not focused / insecure context — fall back */
    }
    const ta = document.createElement('textarea');
    ta.setAttribute(DC.UI_ATTR, '');
    ta.value = text;
    ta.style.cssText = 'all:initial!important;position:fixed!important;top:0!important;left:-9999px!important;opacity:0!important';
    document.documentElement.appendChild(ta);
    const previous = document.activeElement;
    let ok = false;
    try {
      ta.select();
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    previous?.focus?.({ preventScroll: true });
    return ok;
  }

  // Messages: relayed picker traffic, the retry after "Allow", and a capture made in another tab.
  runtime?.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === PICK_MSG) {
      if (msg.from === KEY) return;
      if (msg.to === 'top' || msg.event === 'hello') {
        if (isTop || msg.event === 'hello') picker.onEvent(msg);
      } else if (msg.to === KEY || msg.to === '*') {
        if (!isTop) picker.onCommand(msg);
      }
    } else if (msg.type === 'dom-capture:retry' && isTop && picker.active && picker.mode === 'done') picker.captureTarget();
  });
  chrome?.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local' || !('clip' in changes)) return;
    picker.clip = changes.clip.newValue || null;
    if (picker.active) picker.refreshBar();
  });
  // A parent's handshake: it posted a nonce into this window; the answer goes through the extension.
  if (!isTop) {
    window.addEventListener('message', (e) => {
      const nonce = e.data?.[PICK_MSG];
      if (typeof nonce !== 'string' || e.source !== window.parent) return;
      e.stopImmediatePropagation();
      send({ to: '*', event: 'hello', nonce });
    });
  }

  globalThis.__domCapturePicker = picker;
})();
