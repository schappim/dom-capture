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
 *   click / Enter  capture the highlighted element and copy it
 *   ↑ / ↓          widen to the parent / narrow back down
 *   Esc            leave
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
    .box.done { border-color: #10b981; background: rgba(16, 185, 129, .16); }
    .tag { position: fixed; top: 0; left: 0; pointer-events: none; display: none; max-width: min(520px, 90vw);
      font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; color: #fff; background: #6d5efc; padding: 5px 7px;
      border-radius: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-shadow: 0 2px 8px rgba(0,0,0,.25); }
    .tag b { font-weight: 400; opacity: .75; margin-left: 6px; }
    .bar, .panel { position: fixed; left: 50%; transform: translateX(-50%); color: #e5e7eb; background: rgba(17, 24, 39, .94);
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

  const h = (tag, props = {}, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    el.append(...children);
    return el;
  };

  const picker = {
    active: false,
    mode: 'pick', // pick | busy | done
    target: null,
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
      this.host = this.target = this.result = this.point = null;
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
        h('button', { onclick: () => this.menu.classList.toggle('open'), title: 'Capture options' }, 'Options'),
        h('button', { onclick: () => this.stop(), title: 'Close (Esc)' }, 'Close'),
      );
      this.panel = h('div', { class: 'panel', role: 'status' });

      for (const el of [this.catcher, this.box, this.tag, this.menu, this.bar, this.panel]) el.style.pointerEvents = 'auto';
      this.box.style.pointerEvents = this.tag.style.pointerEvents = 'none';
      root.append(this.catcher, this.box, this.tag, this.menu, this.bar, this.panel);
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
      this.catcher.classList.toggle('idle', mode !== 'pick');
      this.box.classList.toggle('done', mode === 'done');
      this.bar.style.display = mode === 'done' ? 'none' : 'flex';
      this.panel.classList.toggle('open', mode === 'done');
      this.menu.classList.remove('open');
      if (mode === 'pick') {
        this.barHint.replaceChildren(
          'Click an element to copy it  ·  ',
          h('kbd', {}, '↑'),
          ' ',
          h('kbd', {}, '↓'),
          ' parent / child  ·  ',
          h('kbd', {}, 'Esc'),
          ' to quit',
        );
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

    /** The button / checkbox row of our own UI at a point (or just the panel it is in). */
    controlAt(x, y) {
      const inside = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      };
      const layer = [this.menu, this.panel, this.bar].find(inside);
      return layer ? [...layer.querySelectorAll('button, label')].find(inside) || layer : null;
    },

    onMouse: (e) => picker.handleMouse(e),
    handleMouse(e) {
      // Untrusted events are the page's own business — or a click we forwarded below.
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
      if (control) {
        if (e.type === 'click' && control.matches('button, label')) control.click();
      } else if (e.type === 'mousemove') this.onMove(e);
      else if (e.type === 'click' && this.mode === 'pick') this.captureTarget();
      else if (e.type === 'contextmenu') this.stop();
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
        return this.stop();
      }
      if (this.mode !== 'pick' || !this.target) return;
      if (e.key === 'ArrowUp') {
        swallow();
        const parent = DC.flatParent(this.target);
        if (parent && parent !== document.documentElement) {
          this.trail.push(this.target);
          this.target = parent;
        }
      } else if (e.key === 'ArrowDown') {
        swallow();
        const child = this.trail.pop() || DC.flatChildren(this.target, {}).find((n) => n.nodeType === 1 && n.getClientRects().length);
        if (child) this.target = DC.normalizeRoot(child); // (snaps back for children of an <svg>)
      } else if (e.key === 'Enter') {
        swallow();
        this.captureTarget();
      }
    },

    drawBox() {
      const el = this.target;
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
        h('button', { onclick: (e) => this.recopy(e.currentTarget) }, 'Copy again'),
        h('button', { onclick: () => this.download() }, 'Download .html'),
        h('button', { onclick: () => this.preview() }, 'Preview'),
        h('button', { onclick: (e) => this.copyLog(e.currentTarget), title: 'Timeline, options and warnings — handy for bug reports' }, 'Copy debug log'),
        h('button', { onclick: () => this.stop() }, 'Done'),
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
          h('button', { class: 'primary', onclick: (e) => this.copyLog(e.currentTarget) }, 'Copy debug log'),
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
      this.setMode('pick');
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
