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
 *   click          select the element under the cursor (click elsewhere to change)
 *   ↑ / ↓          widen to the parent / narrow back down
 *   ← / →          previous / next sibling
 *   Enter          capture the selection and copy it
 *   Esc            drop the selection; again to leave
 */
(() => {
  'use strict';
  if (globalThis.__domCapturePicker) {
    globalThis.__domCapturePicker.toggle();
    return;
  }
  const DC = globalThis.__domCapture;
  if (!DC) return;

  const OPTION_LABELS = [
    ['states', 'Hover & focus states', 'Carry :hover, :focus and :active rules'],
    ['backdrop', 'Page background', 'Give a transparent element the background it sat on'],
    ['pinWidth', 'Lock width', 'Keep the width the element had on the page'],
    ['fonts', 'Web fonts', 'Bring @font-face rules along (embedded when the font server requires it)'],
    ['embedAssets', 'Embed all images & fonts', 'Inline every asset as a data: URI — bigger, but works offline'],
  ];
  const defaults = Object.fromEntries(OPTION_LABELS.map(([key]) => [key, DC.DEFAULTS[key]]));
  const storage = globalThis.chrome?.storage?.sync;

  // Everything the mouse can tell a page. Handled (and stopped) on window, in the
  // capture phase, so it works whoever the browser decided the target was.
  const MOUSE_EVENTS = [
    'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu',
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
    .tag { position: fixed; top: 0; left: 0; pointer-events: none; display: none; max-width: min(520px, 90vw);
      font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; color: #fff; background: #6d5efc; padding: 5px 7px;
      border-radius: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-shadow: 0 2px 8px rgba(0,0,0,.25); }
    .tag b { font-weight: 400; opacity: .75; margin-left: 6px; }
    .tag.locked { background: #b45309; }
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
    .nav .moves { display: flex; gap: 6px; }
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
    active: false,
    mode: 'pick', // pick (follows the mouse) | select (pinned by a click) | busy | done
    target: null,
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
      this.active = true;
      if (storage) {
        try {
          Object.assign(this.options, await storage.get(defaults));
        } catch {
          /* keep defaults */
        }
      }
      if (!this.active) return;
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
      this.active = false;
      cancelAnimationFrame(this.raf);
      window.removeEventListener('keydown', this.onKey, true);
      for (const type of MOUSE_EVENTS) window.removeEventListener(type, this.onMouse, true);
      this.host?.remove();
      this.host = this.target = this.peek = this.result = this.point = null;
      this.trail = [];
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
        h('button', { onclick: () => this.toggleMenu(), title: 'Capture options' }, 'Options'),
        h('button', { onclick: () => this.stop(), title: 'Close' }, 'Close'),
      );

      // Shown once something is selected: walk the tree with clicks instead of pixel-hunting.
      this.moveButtons = {};
      const move = (act, label, title) => (this.moveButtons[act] = h('button', { 'data-act': act, title, onclick: (button) => this.go(button.__el) }, label));
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
        this.crumbs,
      );
      this.panel = h('div', { class: 'panel', role: 'status' });

      for (const el of [this.catcher, this.box, this.tag, this.menu, this.nav, this.bar, this.panel]) el.style.pointerEvents = 'auto';
      this.box.style.pointerEvents = this.tag.style.pointerEvents = 'none';
      root.append(this.catcher, this.box, this.tag, this.menu, this.nav, this.bar, this.panel);
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
      if (!this.point) return;
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

    setMode(mode) {
      this.mode = mode;
      this.peek = null;
      this.catcher.classList.toggle('idle', mode !== 'pick' && mode !== 'select');
      this.box.classList.toggle('locked', mode === 'select');
      this.tag.classList.toggle('locked', mode === 'select');
      this.box.classList.toggle('done', mode === 'done');
      this.bar.style.display = mode === 'done' ? 'none' : 'flex';
      this.captureButton.style.display = mode === 'select' ? '' : 'none';
      this.nav.classList.toggle('open', mode === 'select');
      this.panel.classList.toggle('open', mode === 'done');
      this.menu.classList.remove('open');
      if (mode === 'pick') {
        this.barHint.replaceChildren('Click an element to select it  ·  ', h('kbd', {}, 'Esc'), ' to quit');
      } else if (mode === 'select') {
        this.barHint.replaceChildren('Adjust the selection, then  ', h('kbd', {}, 'Enter'), '  or');
      } else if (mode === 'busy') {
        this.barHint.replaceChildren(h('span', { class: 'spin' }), 'Capturing styles…');
      }
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
    select(el) {
      this.target = el;
      if (this.mode !== 'select') this.setMode('select');
      this.peek = null;
      const moves = this.movesFrom(el);
      for (const [act, button] of Object.entries(this.moveButtons)) {
        button.__el = moves[act];
        button.toggleAttribute('disabled', !moves[act]);
      }
      const chain = [];
      for (let a = el; a; a = parentOf(a)) chain.unshift(a);
      const shown = chain.slice(innerWidth < 700 ? -3 : -5);
      this.crumbs.replaceChildren(shown.length < chain.length ? '… › ' : '');
      for (const a of shown) {
        const crumb = h('button', { title: DC.describe(a), onclick: () => this.go(a) }, DC.describe(a));
        crumb.__el = a;
        if (a === el) crumb.className = 'on';
        this.crumbs.append(crumb, a === el ? '' : ' › ');
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
      if (!el || !this.target || el === this.target) return;
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
      if (control) {
        if (e.type === 'click') this.activate(control);
      } else if (e.type === 'mousemove') this.onMove(e);
      else if (e.type === 'click') this.onClick(e);
      else if (e.type === 'contextmenu') this.stop();
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
      if (e.key === 'Escape') {
        swallow();
        if (this.mode !== 'select') return this.stop();
        this.setModePick();
        if (this.point) this.target = this.elementAt(...this.point); // straight back to following the mouse
        return;
      }
      if ((this.mode !== 'pick' && this.mode !== 'select') || !this.target) return;
      const act = { ArrowUp: 'parent', ArrowDown: 'child', ArrowLeft: 'prev', ArrowRight: 'next' }[e.key];
      if (act) {
        swallow();
        // Pins the selection too: a nudge of the mouse must not undo the climb.
        if (this.mode === 'pick') this.select(this.target);
        this.go(this.moveButtons[act].__el);
      } else if (e.key === 'Enter') {
        swallow();
        this.captureTarget();
      }
    },

    drawBox() {
      const el = this.peek || this.target;
      this.box.classList.toggle('peek', !!this.peek);
      if (!el || !el.isConnected) {
        this.box.style.display = this.tag.style.display = 'none';
        return;
      }
      const r = el.getBoundingClientRect();
      this.box.style.display = 'block';
      this.box.style.width = `${Math.max(r.width, 2)}px`;
      this.box.style.height = `${Math.max(r.height, 2)}px`;
      this.box.style.transform = `translate(${r.left}px, ${r.top}px)`;

      const text = DC.describe(el);
      const size = `${Math.round(r.width)} × ${Math.round(r.height)}`;
      if (this.tag.dataset.k !== text + size) {
        this.tag.dataset.k = text + size;
        this.tag.replaceChildren(text, h('b', {}, size));
      }
      this.tag.style.display = this.mode === 'done' ? 'none' : 'block';
      const top = r.top >= 28 ? r.top - 26 : Math.min(r.bottom + 4, innerHeight - 26);
      this.tag.style.transform = `translate(${Math.max(4, Math.min(r.left, innerWidth - 200))}px, ${Math.max(4, top)}px)`;
    },

    async captureTarget() {
      const el = this.target;
      if (!el) return;
      this.setMode('busy');
      // Let the "Capturing…" state paint before the synchronous style walk.
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      try {
        const result = (this.result = await DC.capture(el, this.options));
        this.log = result.debugLog;
        const copied = await copyText(result.snippet);
        if (!copied) this.log += '\n\n--- clipboard ---\nwriteText and execCommand("copy") both failed';
        if (!this.active) return;
        this.showResult(result, copied);
      } catch (err) {
        console.error('[DOM Capture]', err);
        if (this.active) this.showError(err);
      }
    },

    showResult(result, copied) {
      const { stats } = result;
      const kb = stats.bytes < 10240 ? `${(stats.bytes / 1024).toFixed(1)} KB` : `${Math.round(stats.bytes / 1024)} KB`;
      const title = h('h1', copied ? {} : { class: 'err' }, h('i', {}, copied ? '✓' : '!'), copied ? 'Copied to clipboard' : 'Captured — but the clipboard was blocked');
      const actions = h(
        'div',
        { class: 'actions' },
        h('button', { class: 'primary', onclick: () => this.setModePick() }, 'Pick another'),
        h('button', { onclick: () => this.adjust(), title: 'Back to this selection — to take its parent instead, say' }, 'Adjust selection'),
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
      );
      const remarks = [...result.warnings, ...(result.notes || [])];
      if (remarks.length) this.panel.append(h('ul', {}, ...remarks.slice(0, 5).map((w) => h('li', {}, w))));
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

    async copyLog(button) {
      const label = button.textContent;
      const ok = await copyText(this.log || 'No log recorded.');
      button.textContent = ok ? 'Log copied ✓' : 'Clipboard blocked';
      setTimeout(() => (button.textContent = label), 1500);
    },

    setModePick() {
      this.result = null;
      this.target = null;
      this.trail = [];
      this.setMode('pick');
    },

    adjust() {
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

  globalThis.__domCapturePicker = picker;
  picker.start();
})();
