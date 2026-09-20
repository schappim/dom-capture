/*
 * DOM Capture — serializer.
 *
 * Turns a live element (and everything rendered inside it, including shadow
 * DOM / web components) into a self-contained snippet: a <style> block plus
 * markup that renders the same in a page that has none of the original CSS.
 *
 * How it works
 * ------------
 * 1. Every captured element gets a generated class whose rule starts with
 *    `all: unset` (the root uses `all: initial`). That wipes user-agent and
 *    destination-page styling, so what an element looks like with *no*
 *    declaration is fully predictable: inherited properties take the parent's
 *    value, everything else takes the CSS initial value.
 * 2. We read the element's computed style through the Typed OM
 *    (`computedStyleMap()`), which — unlike getComputedStyle — keeps `auto`,
 *    percentages, `repeat(3, 1fr)`, unitless line-height etc. instead of
 *    freezing them into pixels, and emit only the properties that differ from
 *    that predictable baseline. Identical rule bodies share a class.
 * 3. The tree is walked as the *flat tree*: shadow roots (open, and closed via
 *    chrome.dom) are inlined and <slot>s are replaced by their assigned nodes,
 *    so web components survive without their JavaScript.
 * 4. ::before/::after/::marker/::placeholder, :hover/:focus/:active rules,
 *    @keyframes and @font-face are recovered from the page's stylesheets.
 *
 * Exposes `globalThis.__domCapture.capture(element, options)`.
 */
(() => {
  'use strict';
  if (globalThis.__domCapture) return;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const HTML_NS = 'http://www.w3.org/1999/xhtml';
  const UI_ATTR = 'data-dom-capture-ui';

  const DEFAULTS = {
    states: true, // carry :hover / :focus / :active rules
    fonts: true, // carry @font-face rules (embedded when their server forbids cross-site use)
    embedAssets: false, // inline *every* image and font as data: URIs (masks + CORS-less fonts always are)
    pinWidth: true, // lock the root to the width it had on the page
    backdrop: true, // give a transparent root the background it was sitting on
    frames: true, // replace each <iframe>'s src by a capture of the document it is showing
    asFrame: false, // (internal) the root is the <body> of such a document: `page` is what goes in srcdoc
    id: null, // class prefix; random when null
    getShadowRoot: null, // test hook standing in for chrome.dom
    fetchTimeout: 2500,
    maxAssetBytes: 1.5 * 1024 * 1024,
  };

  const SKIP_TAGS = new Set(['script', 'style', 'link', 'meta', 'noscript', 'template', 'base', 'head', 'title']);
  // display:none by default, but still meaningful to keep.
  const KEEP_HIDDEN = new Set(['area', 'datalist', 'source', 'track', 'param', 'rp', 'option', 'optgroup']);
  const NO_PSEUDO = new Set([
    'img', 'input', 'textarea', 'select', 'video', 'audio', 'iframe', 'canvas', 'br', 'embed', 'object', 'svg',
    'progress', 'meter',
  ]);
  const NO_CHILDREN = new Set(['iframe', 'canvas', 'textarea']);
  // Elements that may host an author shadow root (plus any custom element).
  const SHADOW_HOSTS = new Set([
    'article', 'aside', 'blockquote', 'body', 'div', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'main',
    'nav', 'p', 'section', 'span',
  ]);
  const URL_ATTRS = new Set(['href', 'src', 'poster', 'action', 'formaction', 'data', 'background', 'xlink:href']);
  const DROP_ATTRS = new Set(['style', 'nonce', 'integrity', 'autofocus', 'is', 'slot', 'loading']);
  // SVG geometry lives in attributes; Chrome also exposes it as CSS properties.
  const SVG_GEOMETRY = new Set(['d', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'width', 'height']);
  // getComputedStyle reports *used* pixel values for these; for pseudo-elements
  // (no Typed OM) we only trust them when a stylesheet actually declares them.
  const PSEUDO_SIZE_PROPS = new Set([
    'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'top', 'right', 'bottom', 'left',
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  ]);
  const MARKER_PROPS = ['color', 'font-family', 'font-size', 'font-style', 'font-weight', 'content'];
  const PLACEHOLDER_PROPS = [
    'color', 'opacity', 'font-family', 'font-size', 'font-style', 'font-weight', 'letter-spacing', 'text-transform',
  ];
  // Paints that are very often `currentColor` (icons). Typed OM resolves the
  // keyword, so when one equals the element's own text colour we emit the
  // keyword again — the icon then follows :hover colour changes and <use> sites.
  const PAINT_PROPS = new Set(['fill', 'stroke', 'stop-color', 'flood-color', 'lighting-color']);
  // Internal bookkeeping properties, and a shorthand Chrome lists next to its own longhands.
  const SKIP_PROPS = new Set(['-webkit-locale', '-webkit-text-decorations-in-effect', 'text-decoration']);
  const STATES = new Set(['hover', 'focus', 'focus-visible', 'focus-within', 'active']);
  const STATE_RE = /:(hover|focus-visible|focus-within|focus|active)(?![\w-])/i;

  // `transition-delay: 0s, 0s` says nothing more than the initial `0s`.
  const LIST_DEFAULT_RE = /^(transition|animation)-/;
  const isLogicalProp = (p) => /(^|-)(block|inline)(-|$)/.test(p) || /^border-(start|end)-(start|end)-radius$/.test(p);
  const isTransparent = (c) => !c || c === 'transparent' || /^rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\)$/.test(c);

  // ------------------------------------------------------- clobber-proofing
  //
  // Named elements shadow DOM properties: <iframe name="styleSheets"> replaces
  // document.styleSheets, and a form control named "id", "attributes",
  // "shadowRoot"… replaces that property on its <form>. Reading through the
  // prototype's own getter always reaches the real thing.
  const nativeGetter = (proto, prop) => {
    const get = Object.getOwnPropertyDescriptor(proto, prop)?.get;
    return get ? (obj) => get.call(obj) : (obj) => obj[prop];
  };
  const dom = {
    shadowRoot: nativeGetter(Element.prototype, 'shadowRoot'),
    attributes: nativeGetter(Element.prototype, 'attributes'),
    id: nativeGetter(Element.prototype, 'id'),
    assignedSlot: nativeGetter(Element.prototype, 'assignedSlot'),
    childNodes: nativeGetter(Node.prototype, 'childNodes'),
    parentElement: nativeGetter(Node.prototype, 'parentElement'),
    docSheets: nativeGetter(Document.prototype, 'styleSheets'),
    docAdopted: nativeGetter(Document.prototype, 'adoptedStyleSheets'),
    frameWindow: nativeGetter(HTMLIFrameElement.prototype, 'contentWindow'),
    rootSheets: nativeGetter(ShadowRoot.prototype, 'styleSheets'),
    rootAdopted: nativeGetter(ShadowRoot.prototype, 'adoptedStyleSheets'),
  };
  const isScope = (node) => node instanceof Document || node instanceof ShadowRoot;
  /** Every stylesheet of a document or shadow root, adopted ones included. */
  function sheetsOf(scope) {
    const isDoc = scope instanceof Document;
    const out = [];
    for (const read of isDoc ? [dom.docSheets, dom.docAdopted] : [dom.rootSheets, dom.rootAdopted]) {
      try {
        out.push(...Array.from(read(scope) || []));
      } catch {
        /* not available on this node */
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- parsing

  /** Split on `sep` at nesting depth 0, outside strings, honouring escapes. */
  function splitTop(str, sep) {
    const parts = [];
    let depth = 0;
    let quote = null;
    let cur = '';
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === '\\') {
        cur += ch + (str[i + 1] ?? '');
        i++;
        continue;
      }
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '(' || ch === '[') {
        depth++;
      } else if (ch === ')' || ch === ']') {
        depth--;
      } else if (ch === sep && depth === 0) {
        parts.push(cur);
        cur = '';
        continue;
      }
      cur += ch;
    }
    parts.push(cur);
    return parts.map((s) => s.trim()).filter(Boolean);
  }

  /** "a > b c" -> { compounds: ['a','b','c'], combinators: ['>',' '] } */
  function parseComplex(selector) {
    const compounds = [];
    const combinators = [];
    let depth = 0;
    let quote = null;
    let cur = '';
    const sel = selector.trim();
    for (let i = 0; i < sel.length; i++) {
      const ch = sel[i];
      if (ch === '\\') {
        cur += ch + (sel[i + 1] ?? '');
        i++;
        continue;
      }
      if (quote) {
        if (ch === quote) quote = null;
        cur += ch;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      if (depth === 0 && /[\s>+~]/.test(ch)) {
        let comb = ' ';
        let j = i;
        for (; j < sel.length && /[\s>+~]/.test(sel[j]); j++) if (sel[j] !== ' ' && !/\s/.test(sel[j])) comb = sel[j];
        if (!cur) return null; // relative selector
        compounds.push(cur);
        combinators.push(comb);
        cur = '';
        i = j - 1;
        continue;
      }
      cur += ch;
    }
    if (!cur) return null;
    compounds.push(cur);
    return { compounds, combinators };
  }

  /** Pull top-level state pseudo-classes out of one compound selector. */
  function stripStates(compound) {
    let depth = 0;
    let quote = null;
    let rest = '';
    let states = '';
    for (let i = 0; i < compound.length; i++) {
      const ch = compound[i];
      if (ch === '\\') {
        rest += ch + (compound[i + 1] ?? '');
        i++;
        continue;
      }
      if (quote) {
        if (ch === quote) quote = null;
        rest += ch;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === ':' && depth === 0 && compound[i + 1] !== ':' && compound[i - 1] !== ':') {
        const m = /^[a-z-]+/i.exec(compound.slice(i + 1));
        if (m && STATES.has(m[0].toLowerCase()) && compound[i + 1 + m[0].length] !== '(') {
          states += ':' + m[0].toLowerCase();
          i += m[0].length;
          continue;
        }
      }
      rest += ch;
    }
    return { rest, states };
  }

  const joinCompounds = (compounds, combinators, count) => {
    let out = compounds[0];
    for (let i = 1; i < count; i++) out += (combinators[i - 1] === ' ' ? ' ' : ` ${combinators[i - 1]} `) + compounds[i];
    return out;
  };

  /**
   * Classify one complex selector. Returns null when it is irrelevant or uses
   * something we cannot faithfully re-target (state inside :not()/:is()/:has(),
   * sibling combinators after the stateful compound, exotic pseudo-elements…).
   */
  function analyzeSelector(selector) {
    const parsed = parseComplex(selector);
    if (!parsed) return null;
    const { compounds, combinators } = parsed;
    let pseudoEl = '';
    const last = compounds[compounds.length - 1];
    const pm = /::?(before|after)$/i.exec(last);
    if (pm && last[pm.index - 1] !== '\\') {
      pseudoEl = '::' + pm[1].toLowerCase();
      compounds[compounds.length - 1] = last.slice(0, pm.index) || '*';
    }
    if (compounds.some((c) => /(^|[^\\])::/.test(c))) return null;
    if (compounds.some((c) => /:host|:scope/i.test(c))) return null;

    let stateIdx = -1;
    let states = '';
    for (let i = 0; i < compounds.length; i++) {
      const r = stripStates(compounds[i]);
      if (STATE_RE.test(r.rest)) return null; // state nested in a functional pseudo
      if (r.states) {
        if (stateIdx !== -1) return null; // states on two different compounds
        stateIdx = i;
        states = r.states;
      }
      compounds[i] = r.rest || '*';
    }
    const n = compounds.length;
    if (stateIdx === -1) {
      return pseudoEl ? { kind: 'pseudo', pseudoEl, stripped: joinCompounds(compounds, combinators, n) } : null;
    }
    for (let i = stateIdx; i < combinators.length; i++) if (combinators[i] !== ' ' && combinators[i] !== '>') return null;
    return {
      kind: 'state',
      pseudoEl,
      states,
      stripped: joinCompounds(compounds, combinators, n),
      anchorPrefix: stateIdx === n - 1 ? null : joinCompounds(compounds, combinators, stateIdx + 1),
    };
  }

  function parseDeclarations(cssText) {
    const out = [];
    for (const part of splitTop(cssText, ';')) {
      const idx = part.indexOf(':');
      if (idx < 1) continue;
      const prop = part.slice(0, idx).trim();
      let value = part.slice(idx + 1).trim();
      const important = /!\s*important$/i.test(value);
      if (important) value = value.replace(/!\s*important$/i, '').trim();
      out.push({ prop, value, important });
    }
    return out;
  }

  /** Substitute var() references. Returns null when a variable has no value. */
  function resolveVars(value, lookup, depth = 0) {
    if (depth > 12) return null;
    let out = '';
    let i = 0;
    while (i < value.length) {
      const idx = value.toLowerCase().indexOf('var(', i);
      if (idx === -1) {
        out += value.slice(i);
        break;
      }
      out += value.slice(i, idx);
      let d = 1;
      let j = idx + 4;
      for (; j < value.length && d > 0; j++) {
        if (value[j] === '(') d++;
        else if (value[j] === ')') d--;
      }
      const inner = value.slice(idx + 4, j - 1);
      const comma = inner.indexOf(',');
      const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
      const fallback = comma === -1 ? null : inner.slice(comma + 1).trim();
      let resolved = lookup(name);
      if (resolved) resolved = resolveVars(resolved, lookup, depth + 1);
      if (!resolved && fallback !== null) resolved = resolveVars(fallback, lookup, depth + 1);
      if (!resolved) return null;
      out += resolved;
      i = j;
    }
    return out;
  }

  function absolutizeCssUrls(text, base) {
    return text.replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (whole, _q, url) => {
      if (!url || /^(data:|blob:|#|about:)/i.test(url)) return whole;
      try {
        return `url("${new URL(url, base).href}")`;
      } catch {
        return whole;
      }
    });
  }

  const parseFamilies = (value) =>
    splitTop(value || '', ',').map((f) => f.replace(/^["']|["']$/g, '').trim().toLowerCase());

  // --------------------------------------------------------------- baseline

  /**
   * A scratch document (an about:blank iframe, so page CSS cannot interfere)
   * used to learn initial values, which properties inherit, which default to
   * currentcolor, and the odd user-agent default.
   */
  class Baseline {
    constructor() {
      const iframe = document.createElement('iframe');
      iframe.setAttribute(UI_ATTR, '');
      iframe.setAttribute('aria-hidden', 'true');
      iframe.tabIndex = -1;
      iframe.style.cssText =
        'all:initial!important;position:fixed!important;left:-9999px!important;top:0!important;' +
        'width:200px!important;height:200px!important;border:0!important;visibility:hidden!important;' +
        'pointer-events:none!important';
      document.documentElement.appendChild(iframe);
      this.host = iframe;
      let doc = null;
      try {
        doc = iframe.contentDocument;
      } catch {
        /* opaque origin */
      }
      let mount = doc && doc.body;
      if (!mount) {
        // Fallback: probe inside the page itself, shielded by `all: initial`.
        iframe.remove();
        doc = document;
        mount = document.createElement('div');
        mount.setAttribute(UI_ATTR, '');
        mount.style.cssText = 'all:initial!important;display:none!important';
        document.documentElement.appendChild(mount);
        this.host = mount;
      }
      this.doc = doc;
      this.mount = mount;
      this.parent = doc.createElement('div');
      this.child = doc.createElement('div');
      this.parent.style.cssText = 'all:initial';
      this.child.style.cssText = 'all:initial';
      this.parent.appendChild(this.child);
      mount.appendChild(this.parent);

      const view = doc.defaultView || window;
      const cs = view.getComputedStyle(this.child);
      this.props = Array.from(cs).filter((p) => !p.startsWith('--') && !isLogicalProp(p) && !SKIP_PROPS.has(p));
      this.propSet = new Set(this.props);
      this.initial = readTyped(this.child, this.propSet);
      this.initialResolved = Object.create(null);
      for (const p of this.props) this.initialResolved[p] = cs.getPropertyValue(p);

      // Which properties default to currentcolor? (Typed OM resolves the
      // keyword to an rgb() value, so ask by changing `color` and watching.)
      this.child.style.cssText = 'all:initial;color:rgb(1, 2, 3)';
      const tinted = readTyped(this.child, this.propSet);
      this.currentColorProps = new Set(
        this.props.filter((p) => p !== 'color' && tinted[p] === 'rgb(1, 2, 3)' && this.initial[p] !== 'rgb(1, 2, 3)'),
      );
      this.child.style.cssText = 'all:unset';
      this.inherited = new Map();
      for (const p of this.currentColorProps) this.isInherited(p, 'rgb(4, 5, 6)');
      this.uaCache = new Map();
    }

    /** true / false, or null when `sample` could not tell us. Cached. */
    isInherited(prop, sample) {
      if (this.inherited.has(prop)) return this.inherited.get(prop);
      let result = null;
      try {
        this.parent.style.setProperty(prop, sample);
        const pv = readOne(this.parent, prop);
        if (pv !== undefined && pv !== this.initial[prop]) result = readOne(this.child, prop) === pv;
      } catch {
        /* leave null */
      }
      this.parent.style.cssText = 'all:initial';
      if (result !== null) this.inherited.set(prop, result);
      return result;
    }

    /** Computed style of a bare `tag` — i.e. what the user agent alone gives it. */
    uaDefaults(ns, tag) {
      const key = `${ns}|${tag}`;
      if (!this.uaCache.has(key)) {
        let vals = null;
        try {
          const el = this.doc.createElementNS(ns || HTML_NS, tag);
          this.mount.appendChild(el);
          vals = readTyped(el, this.propSet);
          el.remove();
        } catch {
          /* unknown tag */
        }
        this.uaCache.set(key, vals);
      }
      return this.uaCache.get(key);
    }

    dispose() {
      this.host.remove();
    }
  }

  /**
   * Run `fn` with the element's CSS animations momentarily detached, so we read
   * the underlying style rather than a mid-flight frame (the copy carries the
   * @keyframes and re-animates from that base). Only done for animations whose
   * keyframes we can actually carry; script-driven animations stay baked in.
   */
  function withoutCssAnimations(el, pseudo, carried, fn) {
    const detached = [];
    try {
      if (typeof CSSAnimation !== 'undefined' && el.getAnimations) {
        for (const anim of el.getAnimations({ subtree: true })) {
          const effect = anim.effect;
          if (!(anim instanceof CSSAnimation) || !effect || effect.target !== el) continue;
          if ((effect.pseudoElement || null) !== pseudo || !carried.has(anim.animationName)) continue;
          detached.push([anim, effect]);
          anim.effect = null;
        }
      }
    } catch {
      /* Web Animations unavailable */
    }
    try {
      return fn();
    } finally {
      for (const [anim, effect] of detached) anim.effect = effect;
    }
  }

  const stringifyTyped = (vals) => (vals.length === 1 ? vals[0].toString() : vals.map(String).join(', '));

  function readTyped(el, propSet) {
    const out = Object.create(null);
    let map = null;
    try {
      map = el.computedStyleMap();
    } catch {
      /* fall through */
    }
    if (!map) {
      const cs = getComputedStyle(el);
      for (const p of propSet) out[p] = cs.getPropertyValue(p);
      return out;
    }
    for (const [prop, vals] of map) if (propSet.has(prop)) out[prop] = stringifyTyped(vals);
    return out;
  }

  function readOne(el, prop) {
    const vals = el.computedStyleMap().getAll(prop);
    return vals.length ? stringifyTyped(vals) : undefined;
  }

  // ------------------------------------------------------------- flat tree

  function shadowRootOf(el, opts) {
    if (el.namespaceURI !== HTML_NS) return null;
    const open = dom.shadowRoot(el);
    if (open) return open;
    if (!el.localName.includes('-') && !SHADOW_HOSTS.has(el.localName)) return null;
    let root = null;
    try {
      if (opts.getShadowRoot) root = opts.getShadowRoot(el);
      else if (globalThis.chrome?.dom?.openOrClosedShadowRoot) root = chrome.dom.openOrClosedShadowRoot(el);
    } catch {
      /* not a host */
    }
    return root instanceof ShadowRoot ? root : null;
  }

  /** Children as rendered: shadow tree instead of light DOM, slots resolved. */
  function flatChildren(el, opts) {
    const sr = shadowRootOf(el, opts);
    if (sr) return Array.from(dom.childNodes(sr));
    if (el.localName === 'slot' && el.namespaceURI === HTML_NS && typeof el.assignedNodes === 'function') {
      const assigned = el.assignedNodes();
      if (assigned.length) return assigned;
    }
    return Array.from(dom.childNodes(el));
  }

  function flatParent(el) {
    if (dom.assignedSlot(el)) return dom.assignedSlot(el);
    if (dom.parentElement(el)) return dom.parentElement(el);
    const root = el.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  }

  const isSkippable = (el) =>
    SKIP_TAGS.has(el.localName) ||
    el.hasAttribute(UI_ATTR) ||
    (el.localName === 'source' && dom.parentElement(el)?.localName === 'picture');

  function discoverScopes(root, opts) {
    const scopes = new Set([document]);
    if (isScope(root.getRootNode())) scopes.add(root.getRootNode());
    const visit = (el) => {
      const sr = shadowRootOf(el, opts);
      if (sr) scopes.add(sr);
      for (const child of flatChildren(el, opts)) if (child.nodeType === 1 && !isSkippable(child)) visit(child);
    };
    visit(root);
    return scopes;
  }

  // ----------------------------------------------------- stylesheet index

  async function fetchText(url, timeout) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ctl.signal, credentials: 'omit' });
      if (!res.ok) throw new Error(String(res.status));
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  const mediaMatches = (text) => {
    if (!text) return true;
    try {
      return matchMedia(text).matches;
    } catch {
      return false;
    }
  };

  function resolveNesting(selectorText, parentSel) {
    if (!parentSel) return selectorText;
    return splitTop(selectorText, ',')
      .map((s) => (/(^|[^\\])&/.test(s) ? s.replace(/(^|[^\\])&/g, `$1:is(${parentSel})`) : `:is(${parentSel}) ${s}`))
      .join(', ');
  }

  /**
   * Index the stylesheets of one scope (the document or a shadow root):
   * stateful rules, ::before/::after rules, @keyframes and @font-face.
   */
  async function indexScope(scope, opts, warnings) {
    const index = { stateRules: [], pseudoRules: [], keyframes: new Map(), fontFaces: [], complete: true };
    let order = 0;

    const addStyle = (selectorText, style, base) => {
      for (const sel of splitTop(selectorText, ',')) {
        if (!STATE_RE.test(sel) && !/::?(before|after)\s*$/i.test(sel)) continue;
        const info = analyzeSelector(sel);
        if (!info) continue;
        if (info.kind === 'pseudo') {
          index.pseudoRules.push({ ...info, style });
        } else if (opts.states) {
          index.stateRules.push({ ...info, style, base, order: order++ });
        }
      }
    };

    const walkRules = (rules, base, parentSel) => {
      for (const rule of rules) {
        if (rule instanceof CSSStyleRule) {
          const sel = resolveNesting(rule.selectorText, parentSel);
          addStyle(sel, rule.style, base);
          if (rule.cssRules?.length) walkRules(rule.cssRules, base, sel);
        } else if (rule instanceof CSSKeyframesRule) {
          index.keyframes.set(rule.name, rule.cssText);
        } else if (rule instanceof CSSFontFaceRule) {
          index.fontFaces.push({ rule, base });
        } else if (rule instanceof CSSImportRule) {
          if (rule.styleSheet && mediaMatches(rule.media?.mediaText)) walkSheet(rule.styleSheet);
        } else if (rule instanceof CSSMediaRule) {
          if (mediaMatches(rule.media.mediaText)) walkRules(rule.cssRules, base, parentSel);
        } else if (rule instanceof CSSSupportsRule) {
          let ok = false;
          try {
            ok = CSS.supports(rule.conditionText);
          } catch {
            /* unsupported */
          }
          if (ok) walkRules(rule.cssRules, base, parentSel);
        } else if (typeof CSSLayerBlockRule !== 'undefined' && rule instanceof CSSLayerBlockRule) {
          walkRules(rule.cssRules, base, parentSel);
        } else if (typeof CSSNestedDeclarations !== 'undefined' && rule instanceof CSSNestedDeclarations) {
          if (parentSel) addStyle(parentSel, rule.style, base);
        }
      }
    };

    const pending = [];
    const walkSheet = (sheet) => {
      if (sheet.disabled || !mediaMatches(sheet.media?.mediaText)) return;
      const base = sheet.href || sheet.ownerNode?.baseURI || document.baseURI;
      let rules = null;
      try {
        rules = sheet.cssRules;
      } catch {
        /* cross-origin */
      }
      if (rules) return walkRules(rules, base, null);
      if (!sheet.href) return void (index.complete = false);
      // Cross-origin sheet: re-fetch it (works whenever the CDN sends CORS headers).
      pending.push(
        fetchText(sheet.href, opts.fetchTimeout)
          .then((text) => {
            const copy = new CSSStyleSheet();
            copy.replaceSync(text);
            walkRules(copy.cssRules, sheet.href, null);
          })
          .catch(() => {
            index.complete = false;
            warnings.add(`Could not read stylesheet ${sheet.href} (cross-origin); hover states, fonts or animations defined there are missing.`);
          }),
      );
    };

    for (const sheet of sheetsOf(scope)) walkSheet(sheet);
    await Promise.all(pending);
    return index;
  }

  // ------------------------------------------------------------ the walker

  class Capture {
    constructor(root, opts) {
      this.root = root;
      this.opts = opts;
      this.id = opts.id || uniquePrefix();
      this.warnings = new Set();
      this.notes = [];
      this.records = new Map(); // source element -> record
      this.list = [];
      this.fontUsage = new Map(); // family -> Set("weight|style") actually used
      this.animations = new Set();
      this.refIds = new Set();
      this.externalUses = []; // <use href="sprite.svg#icon">
      this.frames = []; // <iframe>s, whose documents get captured by the copy of this script running inside them
      this.blockedFrames = new Set(); // origins the extension would need access to for that
      this.dropped = 0;
      this.frameElements = 0;
      this.supportCache = new Map();
      this.outDoc = document.implementation.createHTMLDocument('');
      this.t0 = performance.now();
      this.steps = [];
    }

    /** One line in the debug log's timeline. */
    step(name, detail = '') {
      this.steps.push(`${String(Math.round(performance.now() - this.t0)).padStart(6)} ms  ${name}${detail ? ` — ${detail}` : ''}`);
    }

    /** Plain-text report the picker lets the user copy when something goes wrong. */
    debugLog(error) {
      return buildDebugLog({ capture: this, root: this.root, opts: this.opts, error });
    }

    async run() {
      const { root, opts } = this;
      this.indices = new Map();
      this.step('start');
      await Promise.all(
        [...discoverScopes(root, opts)].map(async (scope) => {
          this.indices.set(scope, await indexScope(scope, opts, this.warnings));
        }),
      );

      for (const [scope, index] of this.indices) {
        this.step(
          `indexed ${scope instanceof Document ? 'document' : `shadow root of <${scope.host?.localName}>`}`,
          `${sheetsOf(scope).length} sheets, ${index.stateRules.length} state rules, ${index.pseudoRules.length} pseudo rules, ` +
            `${index.keyframes.size} keyframes, ${index.fontFaces.length} font faces${index.complete ? '' : ', INCOMPLETE (unreadable sheet)'}`,
        );
      }
      this.keyframeNames = new Set();
      for (const index of this.indices.values()) for (const name of index.keyframes.keys()) this.keyframeNames.add(name);

      this.B = new Baseline();
      this.step('baseline ready', `${this.B.props.length} properties, probe in ${this.B.doc === document ? 'page (iframe unavailable)' : 'iframe'}`);
      let outRoot;
      try {
        outRoot = this.walk(root, null, false, true);
        this.step('walked tree', `${this.list.length} elements`);
        this.captureReferences();
        this.step('references', `${this.refIds.size} ids, ${this.externalUses.length} external <use>`);
        this.adjustRoot(this.records.get(root));
      } finally {
        this.B.dispose();
      }
      const stateMatches = opts.states ? this.collectStates() : [];
      this.step('states matched', String(stateMatches.length));
      this.assignClasses();
      this.step('classes assigned', `${this.rules.length} distinct`);

      let css = this.buildCss(stateMatches);
      const holder = this.outDoc.createElement('div');
      holder.appendChild(outRoot);
      await this.inlineExternalUses();
      if (this.holder) holder.appendChild(this.holder);
      this.step('css built', `${css.length} chars`);
      css = await this.embedAssets(css, holder);
      this.step('assets inlined');
      if (this.frames.length) {
        const inlined = await this.captureFrames();
        this.step('frames', `${inlined} of ${this.frames.length} inlined${this.blockedFrames.size ? ` — no access to ${[...this.blockedFrames].join(', ')}` : ''}`);
      }

      const label = describe(root);
      // What we write into the output names the tag only — no page class names.
      const name = root.localName;
      const markup = holder.innerHTML;
      const header = `<!-- DOM Capture: <${name}> from ${location.href.replace(/--/g, '- -')} -->`;
      const snippet = `${header}\n<style>\n${css.replace(/<\//g, '<\\/')}\n</style>\n${markup}\n`;
      const page =
        '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
        `<title>&lt;${escapeHtml(name)}&gt; — captured from ${escapeHtml(location.hostname || 'page')}</title>\n` +
        (opts.asFrame
          ? `<style>html, body { height: 100%; margin: 0; }${this.canvasColor() ? ` html { background: ${this.canvasColor()}; }` : ''}</style>\n`
          : `<style>body { margin: 0; padding: 24px;${this.backdropColor ? ` background: ${this.backdropColor};` : ''} }</style>\n`) +
        `</head>\n<body>\n${snippet}</body>\n</html>\n`;
      this.step('done', `${snippet.length} chars`);
      if (this.dropped) this.warnings.add(`${this.dropped} declaration(s) could not be serialized and were skipped.`);
      return {
        snippet,
        page,
        label,
        blockedFrames: [...this.blockedFrames],
        stats: {
          elements: this.list.length + this.frameElements,
          rules: this.ruleCount,
          bytes: new Blob([snippet]).size,
        },
        warnings: [...this.warnings],
        notes: this.notes,
      };
    }

    supports(prop, value) {
      const key = prop + '\u0000' + value;
      let ok = this.supportCache.get(key);
      if (ok === undefined) {
        ok = value !== '' && CSS.supports(prop, value);
        this.supportCache.set(key, ok);
      }
      return ok;
    }

    walk(src, parentRec, parentIsSvg, isRoot = false) {
      const { B, opts } = this;
      const vals = withoutCssAnimations(src, null, this.keyframeNames, () => readTyped(src, B.propSet));
      const isHtml = src.namespaceURI === HTML_NS;
      if (!isRoot && isHtml && vals.display === 'none' && !KEEP_HIDDEN.has(src.localName)) return null;

      const svgInner = src.namespaceURI === SVG_NS && parentIsSvg;
      const out = this.cloneShallow(src, isRoot);
      const rec = {
        src,
        out,
        vals,
        isRoot,
        svgInner,
        parent: parentRec,
        decls: this.diffElement(src, out, vals, parentRec?.vals, svgInner, isRoot),
        pseudos: [],
        sigs: [],
        cls: null,
      };
      this.records.set(src, rec);
      this.list.push(rec);
      this.noteUsage(vals['font-family'], vals['animation-name'], vals['font-weight'], vals['font-style']);
      if (!svgInner && !NO_PSEUDO.has(src.localName)) this.capturePseudos(rec);
      else if (src.localName === 'input' || src.localName === 'textarea') this.capturePlaceholder(rec);

      if (out.localName !== 'img' && !NO_CHILDREN.has(src.localName)) {
        const childIsSvg = src.namespaceURI === SVG_NS && src.localName !== 'foreignObject';
        for (const node of flatChildren(src, opts)) {
          if (node.nodeType === 3) {
            out.appendChild(this.outDoc.createTextNode(node.data));
          } else if (node.nodeType === 1 && !isSkippable(node)) {
            const child = this.walk(node, rec, childIsSvg);
            if (child) out.appendChild(child);
          }
        }
      }
      return out;
    }

    noteUsage(fontFamily, animationName, weight = '400', style = 'normal') {
      const variant = `${parseInt(weight, 10) || 400}|${/italic|oblique/.test(style) ? 'italic' : 'normal'}`;
      for (const f of parseFamilies(fontFamily)) {
        if (!this.fontUsage.has(f)) this.fontUsage.set(f, new Set());
        this.fontUsage.get(f).add(variant);
      }
      if (animationName && animationName !== 'none') {
        for (const n of splitTop(animationName, ',')) if (n !== 'none') this.animations.add(n.replace(/^["']|["']$/g, ''));
      }
    }

    noteRefs(value) {
      if (!value.includes('url(')) return;
      for (const m of value.matchAll(/url\(\s*["']?#([^"')]+)["']?\s*\)/g)) this.refIds.add(m[1]);
    }

    // -- markup ------------------------------------------------------------

    cloneShallow(src, isRoot) {
      const doc = this.outDoc;
      const isHtml = src.namespaceURI === HTML_NS;
      let tag = src.localName;
      if (isHtml && (tag === 'html' || tag === 'body')) tag = 'div';
      // A destination page could define the same custom element and upgrade
      // it, replacing our flattened content — so captured ones get a new name.
      else if (isHtml && tag.includes('-')) tag = `${tag}-snapshot`;

      if (isHtml && tag === 'canvas') {
        try {
          const img = doc.createElement('img');
          img.setAttribute('src', src.toDataURL());
          img.setAttribute('alt', src.getAttribute('aria-label') || '');
          if (dom.id(src)) img.setAttribute('id', dom.id(src));
          return img;
        } catch {
          this.warnings.add('A <canvas> is cross-origin tainted and was captured empty.');
        }
      }

      const out = doc.createElementNS(src.namespaceURI, tag);
      for (const attr of dom.attributes(src)) {
        const name = attr.name;
        const lower = name.toLowerCase();
        if (lower.startsWith('on') || DROP_ATTRS.has(lower)) continue;
        if (lower === 'class') continue; // the page's class names never travel; ours replace them
        if (tag === 'slot' && lower === 'name') continue;
        let value = attr.value;
        if (URL_ATTRS.has(lower)) {
          if (/^\s*javascript:/i.test(value)) continue;
          if (lower.endsWith('href') && value.startsWith('#')) {
            if (src.namespaceURI === SVG_NS) this.refIds.add(value.slice(1));
          } else if (tag === 'use' && src.namespaceURI === SVG_NS && value.includes('#') && !/^data:/i.test(value)) {
            try {
              value = new URL(value, src.baseURI).href;
              this.externalUses.push({ out, name, ns: attr.namespaceURI, url: value });
            } catch {
              /* keep as written */
            }
          } else if (value && !/^(data:|blob:|mailto:|tel:|#)/i.test(value)) {
            try {
              value = new URL(value, src.baseURI).href;
            } catch {
              /* keep as written */
            }
          }
        }
        try {
          out.setAttributeNS(attr.namespaceURI, name, value);
        } catch {
          /* attribute name not serializable */
        }
      }

      if (isHtml) this.freezeState(src, out, tag);
      if (isHtml && tag === 'iframe' && this.opts.frames) this.frames.push({ src, out });
      return out;
    }

    /**
     * An <iframe src> pasted somewhere else shows a login page, an error, or nothing (embedded apps
     * are signed per session) — so the document it is showing right now travels along as srcdoc.
     */
    async captureFrames() {
      let inlined = 0;
      await Promise.all(
        this.frames.map(async ({ src, out }) => {
          const reply = await askFrame(src, this.opts);
          if (reply.page) {
            inlined++;
            out.setAttribute('srcdoc', reply.page);
            for (const name of ['src', 'sandbox', 'allow', 'loading', 'referrerpolicy', 'csp']) out.removeAttribute(name);
            this.frameElements += reply.elements || 0;
            for (const w of reply.warnings || []) this.warnings.add(`In an <iframe>: ${w}`);
            for (const origin of reply.blockedFrames || []) this.blockedFrames.add(origin);
            return;
          }
          let origin = null;
          try {
            const url = new URL(src.src, src.baseURI);
            if (/^https?:$/.test(url.protocol) && url.origin !== location.origin) origin = url.origin;
          } catch {
            /* no usable src */
          }
          if (reply.unreachable && origin) this.blockedFrames.add(origin);
          else this.warnings.add(`The contents of an <iframe> could not be captured (${reply.error || 'its document did not answer'}) — it still points at its src.`);
        }),
      );
      if (this.blockedFrames.size) this.warnings.add(`DOM Capture has no access to the <iframe> from ${[...this.blockedFrames].join(', ')}, so it still points at its src.`);
      return inlined;
    }

    /** What the viewport of this document is painted with: the root's background, else the body's. */
    canvasColor() {
      for (const el of [document.documentElement, document.body]) {
        const bg = el && getComputedStyle(el).getPropertyValue('background-color');
        if (bg && !isTransparent(bg)) return bg;
      }
      return null;
    }

    /** Bake live state (chosen image, form values) into attributes. */
    freezeState(src, out, tag) {
      if (tag === 'img') {
        if (src.currentSrc) {
          out.setAttribute('src', src.currentSrc);
          out.removeAttribute('srcset');
          out.removeAttribute('sizes');
        }
      } else if (tag === 'input') {
        const type = (src.getAttribute('type') || 'text').toLowerCase();
        if (type === 'checkbox' || type === 'radio') {
          if (src.checked) out.setAttribute('checked', '');
          else out.removeAttribute('checked');
        } else if (type !== 'password' && type !== 'file' && type !== 'hidden') {
          out.setAttribute('value', src.value);
        } else if (type === 'password') {
          out.removeAttribute('value');
        }
      } else if (tag === 'textarea') {
        out.textContent = src.value;
      } else if (tag === 'option') {
        if (src.selected) out.setAttribute('selected', '');
        else out.removeAttribute('selected');
      } else if (tag === 'video' || tag === 'audio') {
        out.removeAttribute('autoplay');
      }
    }

    // -- styles ------------------------------------------------------------

    /** Declarations an element needs on top of its `all: unset` baseline. */
    diffElement(src, out, vals, parentVals, svgInner, isRoot) {
      const B = this.B;
      const decls = new Map();
      const emit = (prop, value) => {
        if (!this.supports(prop, value)) {
          value = getComputedStyle(src).getPropertyValue(prop);
          if (!this.supports(prop, value)) return void this.dropped++;
        }
        decls.set(prop, value);
        this.noteRefs(value);
      };

      // Elements inside <svg> are not reset, so their baseline is the UA style.
      const ua = B.uaDefaults(out.namespaceURI, out.localName);
      for (const prop of B.props) {
        const v = vals[prop];
        if (v === undefined) continue;
        const init = (svgInner && ua?.[prop]) || B.initial[prop];

        if (prop === 'unicode-bidi') {
          // `all` never resets unicode-bidi, so the UA value survives.
          if (v !== (ua ? ua[prop] : init)) emit(prop, v);
          continue;
        }
        if (LIST_DEFAULT_RE.test(prop) && splitTop(v, ',').every((item) => item === init)) continue;
        if (svgInner) {
          // No reset inside <svg> (it would wipe `d`, `cx`, … which Chrome
          // maps from attributes), so attributes keep working on their own.
          if (SVG_GEOMETRY.has(prop)) {
            if (!src.hasAttribute(prop) && v !== init) emit(prop, v);
            continue;
          }
          if (src.hasAttribute(prop)) {
            emit(prop, v); // CSS may have overridden the presentation attribute
            continue;
          }
        }

        const pv = isRoot || !parentVals ? init : parentVals[prop];

        if (PAINT_PROPS.has(prop) && v === vals.color && v !== init) {
          const parentOwn = parentVals && parentVals[prop] === parentVals.color;
          if (!parentOwn || src.hasAttribute(prop)) emit(prop, 'currentcolor');
          continue;
        }
        if (B.currentColorProps.has(prop)) {
          const own = v === vals.color;
          const parentOwn = isRoot || !parentVals || parentVals[prop] === parentVals.color;
          const inherited = B.inherited.get(prop) === true;
          if (own) {
            if (inherited && !parentOwn) emit(prop, 'currentcolor');
          } else if (!(inherited && !parentOwn && v === pv)) {
            emit(prop, v);
          }
          continue;
        }

        if (v === init && v === pv) continue;
        if (v !== init && v !== pv) {
          emit(prop, v);
          continue;
        }
        const inherited = B.isInherited(prop, v !== init ? v : pv);
        if (inherited ? v !== pv : v !== init) emit(prop, v);
      }
      return decls;
    }

    /** Same idea for pseudo-elements, which only getComputedStyle can read. */
    diffPseudo(el, pseudo, declared) {
      const B = this.B;
      const cs = getComputedStyle(el, pseudo);
      const own = getComputedStyle(el);
      const decls = new Map();
      const color = cs.getPropertyValue('color');
      const hasTransform = cs.getPropertyValue('transform') !== 'none';
      for (const prop of B.props) {
        const v = cs.getPropertyValue(prop);
        if (!v) continue;
        if (PSEUDO_SIZE_PROPS.has(prop) && declared) {
          const authored = declared.get(prop);
          if (authored === undefined || authored === 'auto') continue;
          // A percentage is worth more than the pixels it happened to resolve to.
          if (authored.includes('%') && !/var\(|rem/i.test(authored) && this.supports(prop, authored)) {
            decls.set(prop, authored);
            continue;
          }
        }
        if ((prop === 'transform-origin' || prop === 'perspective-origin') && !hasTransform) continue;
        if (prop === 'unicode-bidi' && v === 'normal') continue;
        const init = B.initialResolved[prop];
        const pv = own.getPropertyValue(prop);
        if (B.currentColorProps.has(prop)) {
          if (v !== color && !(B.inherited.get(prop) === true && v === pv)) decls.set(prop, v);
          continue;
        }
        if (v === init && v === pv) continue;
        if (v !== init && v !== pv) {
          if (this.supports(prop, v)) decls.set(prop, v);
          continue;
        }
        const inherited = B.isInherited(prop, v !== init ? v : pv);
        if ((inherited ? v !== pv : v !== init) && this.supports(prop, v)) decls.set(prop, v);
      }
      for (const v of decls.values()) this.noteRefs(v);
      this.noteUsage(cs.getPropertyValue('font-family'), cs.getPropertyValue('animation-name'), cs.getPropertyValue('font-weight'), cs.getPropertyValue('font-style'));
      return decls;
    }

    /** Which sizing longhands do stylesheets declare for el's ::before/::after? */
    declaredPseudoProps(el, pseudo) {
      const index = this.indices.get(el.getRootNode());
      // Hosts and slotted nodes are also styled by :host / ::slotted rules we
      // do not match here — be conservative and keep the resolved values.
      if (!index || dom.assignedSlot(el) || shadowRootOf(el, this.opts)) return null;
      const props = new Map(); // longhand -> authored value ('' when it hides behind var())
      for (const rule of index.pseudoRules) {
        if (rule.pseudoEl !== pseudo) continue;
        try {
          if (el.matches(rule.stripped)) for (const p of rule.style) props.set(p, rule.style.getPropertyValue(p));
        } catch {
          /* selector we cannot evaluate */
        }
      }
      // With an unreadable stylesheet around, only trust this when we did find
      // the rules that create the pseudo-element.
      return index.complete || props.size ? props : null;
    }

    capturePseudos(rec) {
      const el = rec.src;
      for (const pseudo of ['::before', '::after']) {
        const content = getComputedStyle(el, pseudo).getPropertyValue('content');
        if (!content || content === 'none' || content === 'normal') continue;
        const declared = this.declaredPseudoProps(el, pseudo);
        const decls = withoutCssAnimations(el, pseudo, this.keyframeNames, () => this.diffPseudo(el, pseudo, declared));
        decls.set('content', content);
        rec.pseudos.push({ pseudo, decls: collapseShorthands(decls, (p, v) => this.supports(p, v)) });
      }
      if ((rec.vals.display || '').includes('list-item')) {
        const cs = getComputedStyle(el, '::marker');
        const own = getComputedStyle(el);
        this.noteUsage(cs.getPropertyValue('font-family'), '', cs.getPropertyValue('font-weight'), cs.getPropertyValue('font-style'));
        const decls = new Map();
        for (const p of MARKER_PROPS) {
          const v = cs.getPropertyValue(p);
          if (v && v !== own.getPropertyValue(p) && !(p === 'content' && v === 'normal')) decls.set(p, v);
        }
        if (decls.size) rec.pseudos.push({ pseudo: '::marker', decls });
      }
      this.capturePlaceholder(rec);
    }

    capturePlaceholder(rec) {
      const el = rec.src;
      if ((el.localName !== 'input' && el.localName !== 'textarea') || !el.hasAttribute('placeholder')) return;
      const cs = getComputedStyle(el, '::placeholder');
      const own = getComputedStyle(el);
      this.noteUsage(cs.getPropertyValue('font-family'), '', cs.getPropertyValue('font-weight'), cs.getPropertyValue('font-style'));
      const decls = new Map();
      for (const p of PLACEHOLDER_PROPS) {
        const v = cs.getPropertyValue(p);
        if (v && (p === 'color' || p === 'opacity' || v !== own.getPropertyValue(p))) decls.set(p, v);
      }
      if (decls.size) rec.pseudos.push({ pseudo: '::placeholder', decls });
    }

    /**
     * SVG paint servers, clip paths, <symbol>s… referenced by id from inside
     * the capture but living elsewhere on the page: bring them along.
     */
    captureReferences() {
      const scope = this.root.getRootNode();
      const seen = new Set();
      for (let pass = 0; pass < 6; pass++) {
        const todo = [...this.refIds].filter((id) => !seen.has(id));
        if (!todo.length) break;
        for (const id of todo) {
          seen.add(id);
          const target = (scope.getElementById ? scope.getElementById(id) : null) || document.getElementById(id);
          if (!target || target.namespaceURI !== SVG_NS) continue;
          let inside = false;
          for (let a = target; a; a = dom.parentElement(a)) if (this.records.has(a)) inside = true;
          if (inside) continue;
          const parent = dom.parentElement(target);
          const parentRec = parent ? { vals: readTyped(parent, this.B.propSet) } : null;
          const out = this.walk(target, parentRec, true);
          if (!out) continue;
          this.defs().appendChild(out);
        }
      }
    }

    /** A zero-size <svg><defs> that travels next to the root for referenced SVG bits. */
    defs() {
      if (!this.holder) {
        const holder = (this.holder = this.outDoc.createElementNS(SVG_NS, 'svg'));
        holder.setAttribute('aria-hidden', 'true');
        holder.setAttribute('width', '0');
        holder.setAttribute('height', '0');
        holder.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
        holder.appendChild(this.outDoc.createElementNS(SVG_NS, 'defs'));
      }
      return this.holder.firstChild;
    }

    /**
     * <use href="/sprite.svg#icon"> only works same-origin, so it would break
     * anywhere else: fetch the sprite and inline the referenced element.
     */
    async inlineExternalUses() {
      const docs = new Map();
      const done = new Map();
      for (const use of this.externalUses) {
        const [file, frag] = use.url.split('#');
        try {
          if (!done.has(use.url)) {
            if (!docs.has(file)) {
              docs.set(file, fetchText(file, this.opts.fetchTimeout).then((t) => new DOMParser().parseFromString(t, 'image/svg+xml')));
            }
            const target = (await docs.get(file)).getElementById(decodeURIComponent(frag));
            if (!target) throw new Error('missing');
            const copy = this.outDoc.importNode(target, true);
            for (const el of [copy, ...copy.querySelectorAll('*')]) {
              if (el.localName === 'script') el.remove();
              for (const a of [...el.attributes]) if (/^on/i.test(a.name)) el.removeAttribute(a.name);
            }
            const newId = `${this.id}-${frag.replace(/[^\w-]/g, '')}-${done.size + 1}`;
            copy.setAttribute('id', newId);
            this.defs().appendChild(copy);
            done.set(use.url, newId);
          }
          use.out.setAttributeNS(use.ns, use.name, '#' + done.get(use.url));
        } catch {
          this.warnings.add(`Could not inline the external SVG ${use.url}; that icon only renders on its original site.`);
        }
      }
    }

    /** The root loses its surroundings; compensate for what they provided. */
    adjustRoot(rec) {
      const { src, vals, decls } = rec;
      const cs = getComputedStyle(src);
      const display = vals.display || '';

      if (vals.position === 'absolute' || vals.position === 'fixed') {
        decls.set('position', 'relative');
        for (const side of ['top', 'right', 'bottom', 'left']) decls.delete(side);
      }
      if (this.opts.pinWidth && display !== 'inline' && display !== 'contents' && display !== 'none') {
        const width = cs.getPropertyValue('width');
        if (!/^[\d.]+px$/.test(vals.width || '') && /^[\d.]+px$/.test(width)) {
          decls.set('width', width);
          if ((vals['max-width'] || 'none') === 'none') decls.set('max-width', '100%');
        }
        const height = cs.getPropertyValue('height');
        if ((vals.height || '').includes('%') && /^[\d.]+px$/.test(height)) decls.set('height', height);
      }

      for (let a = flatParent(src); a; a = flatParent(a)) {
        const bg = getComputedStyle(a).getPropertyValue('background-color');
        if (!isTransparent(bg)) {
          this.backdropColor = bg;
          break;
        }
      }
      if (
        this.opts.backdrop &&
        this.backdropColor &&
        isTransparent(vals['background-color']) &&
        (vals['background-image'] || 'none') === 'none'
      ) {
        decls.set('background-color', this.backdropColor);
      }
    }

    // -- interactive states --------------------------------------------------

    collectStates() {
      const matches = [];
      const declCache = new Map();
      const scopeRoots = new Map(); // scope -> element/fragment to query
      for (const rec of this.list) {
        const scope = rec.src.getRootNode();
        if (!scopeRoots.has(scope)) scopeRoots.set(scope, scope === this.root.getRootNode() ? this.root : scope);
      }

      for (const [scope, queryRoot] of scopeRoots) {
        const index = this.indices.get(scope);
        if (!index) continue;
        for (const rule of index.stateRules) {
          let found;
          try {
            found = Array.from(queryRoot.querySelectorAll(rule.stripped));
            if (queryRoot.nodeType === 1 && queryRoot.matches(rule.stripped)) found.unshift(queryRoot);
          } catch {
            continue;
          }
          for (const el of found) {
            const rec = this.records.get(el);
            if (!rec) continue;
            let anchor = null;
            if (rule.anchorPrefix) {
              for (let a = dom.parentElement(el); a && !anchor; a = dom.parentElement(a)) {
                if (a.matches(rule.anchorPrefix)) anchor = this.records.get(a) || null;
                if (a === this.root) break;
              }
              if (!anchor) continue;
            }
            if (!declCache.has(rule)) declCache.set(rule, parseDeclarations(rule.style.cssText));
            const body = this.stateBody(declCache.get(rule), el, rule.base);
            if (!body) continue;
            const key = `${rule.order}|${rule.states}|${rule.pseudoEl}`;
            rec.sigs.push(`${anchor ? 'D' : 'S'}|${key}|${body}`);
            if (anchor) anchor.sigs.push(`A|${key}`);
            matches.push({ rule, rec, anchor, body });
          }
        }
      }
      matches.sort((a, b) => a.rule.order - b.rule.order);
      return matches;
    }

    stateBody(declarations, el, base) {
      const local = new Map();
      for (const d of declarations) if (d.prop.startsWith('--')) local.set(d.prop, d.value);
      let cs = null;
      const lookup = (name) => local.get(name) ?? (cs ||= getComputedStyle(el)).getPropertyValue(name).trim();
      const parts = [];
      for (const d of declarations) {
        if (d.prop.startsWith('--')) continue;
        let value = d.value;
        if (/var\(/i.test(value)) value = resolveVars(value, lookup);
        if (!value || !this.supports(d.prop, value)) continue;
        value = absolutizeCssUrls(value, base);
        this.noteRefs(value);
        if (d.prop === 'animation-name') this.noteUsage('', value);
        // A state may switch family or weight: make sure that face travels too.
        const cs2 = d.prop === 'font-family' || d.prop === 'font-weight' ? getComputedStyle(el) : null;
        if (cs2) this.noteUsage(d.prop === 'font-family' ? value : cs2.fontFamily, '', d.prop === 'font-weight' ? value : cs2.fontWeight, cs2.fontStyle);
        parts.push(`${d.prop}: ${value}${d.important ? ' !important' : ''};`);
      }
      return parts.join(' ');
    }

    // -- output ------------------------------------------------------------

    assignClasses() {
      const byKey = new Map();
      this.rules = [];
      for (const rec of this.list) {
        const decls = collapseShorthands(rec.decls, (p, v) => this.supports(p, v));
        const reset = rec.isRoot ? 'all: initial; ' : rec.svgInner ? '' : 'all: unset; ';
        let body = reset;
        for (const [p, v] of decls) body += `${p}: ${v}; `;
        body = body.trim();
        const pseudoText = rec.pseudos
          .map((p) => `${p.pseudo} { ${[...p.decls].map(([k, v]) => `${k}: ${v};`).join(' ')} }`)
          .join('\n');
        // A bare <span> has no user-agent styling to undo.
        const trivial = !decls.size && !pseudoText && !rec.sigs.length && (rec.svgInner || rec.out.localName === 'span');
        if (!trivial) {
          const key = [body, pseudoText, ...rec.sigs.slice().sort()].join('\n');
          let entry = byKey.get(key);
          if (!entry) {
            entry = { cls: `${this.id}-${byKey.size + 1}`, body, pseudos: rec.pseudos };
            byKey.set(key, entry);
            this.rules.push(entry);
          }
          rec.cls = entry.cls;
        }
        const classes = [];
        if (rec.isRoot) classes.push(this.id);
        if (rec.cls) classes.push(rec.cls);
        if (classes.length) rec.out.setAttribute('class', classes.join(' '));
      }
    }

    buildCss(stateMatches) {
      const lines = [];
      const docIndex = this.indices.get(document);

      for (const css of this.pickFontFaces(docIndex)) lines.push(css);
      const keyframes = new Map();
      for (const index of this.indices.values()) for (const [n, css] of index.keyframes) if (!keyframes.has(n)) keyframes.set(n, css);
      for (const name of this.animations) {
        if (keyframes.has(name)) lines.push(keyframes.get(name));
        else this.warnings.add(`@keyframes "${name}" was not found in a readable stylesheet.`);
      }

      for (const rule of this.rules) {
        if (rule.body) lines.push(`.${rule.cls} { ${rule.body} }`);
        for (const p of rule.pseudos) {
          lines.push(`.${rule.cls}${p.pseudo} { ${[...p.decls].map(([k, v]) => `${k}: ${v};`).join(' ')} }`);
        }
      }

      if (this.opts.states) {
        // `all: unset` also removed the browser's focus ring; hand it back
        // (page-defined :focus rules come later and still win).
        lines.push(`.${this.id}:focus-visible, .${this.id} :focus-visible { outline: revert; }`);
        const groups = new Map();
        for (const m of stateMatches) {
          const subject = `.${m.rec.cls}`;
          const selector = m.anchor
            ? `.${m.anchor.cls}${m.rule.states} ${subject}${m.rule.pseudoEl}`
            : `${subject}${m.rule.states}${m.rule.pseudoEl}`;
          const key = `${m.rule.order}|${m.body}`;
          if (!groups.has(key)) groups.set(key, { selectors: new Set(), body: m.body });
          groups.get(key).selectors.add(selector);
        }
        for (const g of groups.values()) lines.push(`${[...g.selectors].join(', ')} { ${g.body} }`);
      }
      this.ruleCount = lines.length;
      return lines.join('\n');
    }

    /**
     * @font-face rules the capture needs: per used family, the faces matching
     * the weights/styles actually in use — and of those only the ones the page
     * has loaded (drops unicode-range subsets for scripts that never appear).
     */
    pickFontFaces(index) {
      if (!index || !this.opts.fonts) return [];
      const familyOf = (rule) => parseFamilies(rule.style.getPropertyValue('font-family'))[0];
      const wanted = index.fontFaces.filter(({ rule }) => this.fontUsage.has(familyOf(rule)));
      if (!wanted.length) return [];

      const loaded = new Set();
      const sig = (f) => [parseFamilies(f.family)[0], f.weight, f.style, f.stretch, f.unicodeRange].join('|');
      try {
        for (const face of document.fonts) if (face.status === 'loaded') loaded.add(sig(face));
      } catch {
        /* FontFaceSet unavailable */
      }
      const isLoaded = ({ rule }) => {
        try {
          const s = rule.style;
          const descriptors = {};
          for (const [k, p] of [['weight', 'font-weight'], ['style', 'font-style'], ['stretch', 'font-stretch'], ['unicodeRange', 'unicode-range']]) {
            const v = s.getPropertyValue(p);
            if (v) descriptors[k] = v;
          }
          return loaded.has(sig(new FontFace(s.getPropertyValue('font-family'), 'url(data:,)', descriptors)));
        } catch {
          return false;
        }
      };
      const weightRange = (rule) => {
        const nums = (rule.style.getPropertyValue('font-weight') || '400')
          .replace(/normal/g, '400')
          .replace(/bold/g, '700')
          .match(/[\d.]+/g);
        const [lo, hi = lo] = (nums || ['400']).map(Number);
        return [lo, hi];
      };
      const isItalic = (rule) => /italic|oblique/.test(rule.style.getPropertyValue('font-style'));

      const byFamily = new Map();
      for (const f of wanted) {
        const fam = familyOf(f.rule);
        if (!byFamily.has(fam)) byFamily.set(fam, []);
        byFamily.get(fam).push(f);
      }
      const chosen = new Set();
      for (const [fam, faces] of byFamily) {
        for (const variant of this.fontUsage.get(fam)) {
          const [w, style] = variant.split('|');
          const weight = Number(w);
          const sameStyle = faces.filter((f) => isItalic(f.rule) === (style === 'italic'));
          const pool = sameStyle.length ? sameStyle : faces;
          // CSS font matching order: exact/in-range first; bold text then looks
          // heavier before lighter, light text lighter first, 400–500 up to 500 first.
          const rank = (f) => {
            const [lo, hi] = weightRange(f.rule);
            if (weight >= lo && weight <= hi) return 0;
            const above = lo > weight ? (lo - weight) / 1000 : null;
            const below = hi < weight ? (weight - hi) / 1000 : null;
            if (weight > 500) return above !== null ? 1 + above : 2 + below;
            if (weight < 400) return below !== null ? 1 + below : 2 + above;
            if (above !== null && lo <= 500) return 1 + above;
            return below !== null ? 2 + below : 3 + above;
          };
          const best = Math.min(...pool.map(rank));
          const matching = pool.filter((f) => rank(f) === best);
          const used = matching.filter(isLoaded);
          for (const f of used.length ? used : matching) chosen.add(f);
        }
      }
      return wanted.filter((f) => chosen.has(f)).map((f) => absolutizeCssUrls(f.rule.cssText, f.base));
    }

    /** Would this (font) URL stop loading once referenced from another origin? */
    async breaksCrossSite(url) {
      if (url.startsWith('blob:')) return true;
      try {
        // Already cross-origin for this page and evidently loading: CORS is in place.
        if (new URL(url).origin !== location.origin) return false;
        const res = await fetch(url, { method: 'HEAD' });
        return res.headers.get('access-control-allow-origin') !== '*';
      } catch {
        return true;
      }
    }

    /**
     * Inline assets as data: URIs. Some always are, because a plain URL would
     * silently break once the snippet lives on another origin:
     *   - mask images (cross-origin masks need CORS),
     *   - web fonts whose server does not send `Access-Control-Allow-Origin: *`.
     * With the embedAssets option, every image and font is inlined.
     */
    async embedAssets(css, holder) {
      const URL_RE = /url\("((?:https?:|blob:)[^"]+)"\)/g;
      const urls = new Set();
      const fontUrls = new Set();
      for (const face of css.matchAll(/@font-face\s*\{[^}]*\}/g)) for (const m of face[0].matchAll(URL_RE)) fontUrls.add(m[1]);
      let imgs = [];
      if (this.opts.embedAssets) {
        for (const m of css.matchAll(URL_RE)) urls.add(m[1]);
        imgs = Array.from(holder.querySelectorAll('img[src]'));
        for (const img of imgs) if (/^(https?:|blob:)/.test(img.getAttribute('src'))) urls.add(img.getAttribute('src'));
      } else {
        for (const decl of css.matchAll(/mask[a-z-]*:\s*([^;}]*)/g)) for (const m of decl[1].matchAll(URL_RE)) urls.add(m[1]);
        await Promise.all([...fontUrls].map(async (url) => (await this.breaksCrossSite(url)) && urls.add(url)));
      }
      if (!urls.size) return css;

      const data = new Map();
      let failed = 0;
      await Promise.all(
        [...urls].map(async (url) => {
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), this.opts.fetchTimeout * 2);
          try {
            const res = await fetch(url, { signal: ctl.signal });
            if (!res.ok) throw new Error(String(res.status));
            const blob = await res.blob();
            if (blob.size > this.opts.maxAssetBytes) throw new Error('too large');
            data.set(url, await blobToDataUrl(blob));
          } catch {
            failed++;
          } finally {
            clearTimeout(timer);
          }
        }),
      );
      const fonts = [...fontUrls].filter((u) => data.has(u));
      if (fonts.length && !this.opts.embedAssets) {
        const kb = Math.round(fonts.reduce((n, u) => n + data.get(u).length, 0) / 1024);
        this.notes.push(`${fonts.length} web font file(s) were embedded (${kb} KB) because their server does not let other sites load them.`);
      }
      if (failed) this.warnings.add(`${failed} asset(s) could not be embedded (cross-origin or too large) and still point at their URL.`);
      for (const img of imgs) if (data.has(img.getAttribute('src'))) img.setAttribute('src', data.get(img.getAttribute('src')));
      return css.replace(/url\("((?:https?:|blob:)[^"]+)"\)/g, (whole, url) => (data.has(url) ? `url("${data.get(url)}")` : whole));
    }
  }

  // ---------------------------------------------------------------- helpers

  const blobToDataUrl = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });

  const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  /** Four box sides -> the shortest shorthand value list. */
  function boxValues([t, r, b, l]) {
    if (r === l) {
      if (t === b) return t === r ? [t] : [t, r];
      return [t, r, b];
    }
    return [t, r, b, l];
  }

  const BOX_GROUPS = [
    ['margin', ['margin-top', 'margin-right', 'margin-bottom', 'margin-left']],
    ['padding', ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']],
    ['inset', ['top', 'right', 'bottom', 'left']],
    ['border-width', ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width']],
    ['border-style', ['border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style']],
    ['border-color', ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color']],
    [
      'border-radius',
      ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
    ],
  ];
  const hasTopLevelSpace = (v) => /\s/.test(v.replace(/\([^()]*(\([^()]*\)[^()]*)*\)/g, ''));

  /** Fold complete longhand groups into shorthands to keep the CSS readable. */
  function collapseShorthands(decls, supports) {
    const map = new Map(decls);
    const replace = (longhands, shorthand, value) => {
      if (!supports(shorthand, value)) return;
      const next = new Map();
      for (const [k, v] of map) {
        if (k === longhands[0]) next.set(shorthand, value);
        if (!longhands.includes(k)) next.set(k, v);
      }
      map.clear();
      for (const [k, v] of next) map.set(k, v);
    };
    for (const [shorthand, longhands] of BOX_GROUPS) {
      if (!longhands.every((p) => map.has(p))) continue;
      const values = longhands.map((p) => map.get(p));
      if (values.some(hasTopLevelSpace)) continue;
      replace(longhands, shorthand, boxValues(values).join(' '));
    }
    const border = ['border-width', 'border-style', 'border-color'];
    if (border.every((p) => map.has(p) && !hasTopLevelSpace(map.get(p)))) {
      replace(border, 'border', border.map((p) => map.get(p)).join(' '));
    }
    for (const [shorthand, a, b] of [['overflow', 'overflow-x', 'overflow-y'], ['gap', 'row-gap', 'column-gap']]) {
      if (map.has(a) && map.has(b)) {
        const va = map.get(a);
        const vb = map.get(b);
        replace([a, b], shorthand, va === vb ? va : `${va} ${vb}`);
      }
    }
    return map;
  }

  /** Short ancestor trail, e.g. "body > main#app > div.card" (debug log only). */
  function trail(el) {
    const parts = [];
    for (let a = el; a && a.nodeType === 1 && parts.length < 8; a = flatParent(a)) parts.unshift(describe(a));
    return parts.join(' > ');
  }

  function buildDebugLog({ capture: c, root, opts, error }) {
    const safe = (fn) => {
      try {
        return fn();
      } catch (e) {
        return `(unavailable: ${e.message})`;
      }
    };
    const lines = [
      '=== DOM Capture debug log ===',
      `version:   ${safe(() => globalThis.chrome?.runtime?.getManifest?.().version || 'dev')}`,
      `time:      ${new Date().toISOString()}`,
      `page:      ${location.href}`,
      `browser:   ${navigator.userAgent}`,
      `viewport:  ${innerWidth}×${innerHeight} @${devicePixelRatio}x, ${document.compatMode === 'CSS1Compat' ? 'standards' : 'QUIRKS'} mode`,
      `options:   ${safe(() => JSON.stringify(opts, (k, v) => (typeof v === 'function' ? '[function]' : v)))}`,
      `element:   ${safe(() => (root instanceof Element ? trail(root) : String(root)))}`,
      `markup:    ${safe(() => (root instanceof Element ? root.cloneNode(false).outerHTML.slice(0, 300) : ''))}`,
      `in shadow: ${safe(() => (root instanceof Element && root.getRootNode() instanceof ShadowRoot ? `yes, host <${root.getRootNode().host.localName}>` : 'no'))}`,
    ];
    if (c) {
      lines.push('', '--- timeline ---', ...c.steps);
      if (c.warnings.size) lines.push('', '--- warnings ---', ...c.warnings);
      if (c.notes.length) lines.push('', '--- notes ---', ...c.notes);
    }
    if (error) {
      lines.push('', '--- error ---', `${error.name || 'Error'}: ${error.message || error}`);
      if (c?.steps.length) lines.push(`after step: ${c.steps[c.steps.length - 1].trim()}`);
      if (error.stack) lines.push(String(error.stack).replace(/chrome-extension:\/\/[a-z]+\//g, ''));
    } else {
      lines.push('', '--- result ---', 'ok');
    }
    return lines.join('\n');
  }

  /** A class prefix that no class name on this page starts with or contains. */
  function uniquePrefix() {
    for (;;) {
      const id = 'dc' + Math.random().toString(36).slice(2, 6).padEnd(4, 'x');
      if (!document.querySelector(`[class*="${id}"]`)) return id;
    }
  }

  /** "div#hero.card.is-active" — for the picker UI only, never for the output. */
  function describe(el) {
    let s = el.localName;
    if (dom.id(el)) s += '#' + dom.id(el);
    const cls = Element.prototype.getAttribute.call(el, 'class') || '';
    const names = cls.split(/\s+/).filter(Boolean);
    if (names.length) s += '.' + names.slice(0, 3).join('.');
    if (names.length > 3) s += '…';
    return s;
  }

  /** Elements we refuse to use as a root get swapped for a sensible neighbour. */
  function normalizeRoot(el) {
    if (el === document.documentElement) el = document.body;
    // A lone <path> is useless without its <svg>.
    while (el.namespaceURI === SVG_NS && el.ownerSVGElement) el = el.ownerSVGElement;
    return el;
  }

  async function capture(element, options = {}) {
    const opts = { ...DEFAULTS, ...options };
    let job = null;
    try {
      if (!(element instanceof Element)) throw new TypeError('capture() needs an element');
      job = new Capture(normalizeRoot(element), opts);
      const result = await job.run();
      result.debugLog = job.debugLog();
      return result;
    } catch (error) {
      // Every failure carries a report the user can copy out of the picker.
      try {
        error.debugLog = buildDebugLog({ capture: job, root: job?.root || element, opts, error });
      } catch {
        /* frozen error object */
      }
      throw error;
    }
  }

  // ------------------------------------------------------------------ frames
  //
  // A document in an <iframe> is captured by the copy of this script running inside it (the
  // background page injects into every frame it may). The parent hands a nonce to the frame's
  // window; the answer comes back through the extension (runtime message, relayed by the
  // background page) and never through postMessage — the embedding page must not get to read
  // a cross-origin frame just because the user captured it.
  const FRAME_MSG = 'dom-capture:frame';
  const runtime = globalThis.chrome?.runtime?.id ? globalThis.chrome.runtime : null;
  const waiting = new Map(); // nonce -> callback
  const tell = (msg) => {
    try {
      runtime.sendMessage({ type: FRAME_MSG, ...msg }, () => void runtime.lastError);
    } catch {
      /* extension reloaded under us */
    }
  };

  function askFrame(iframe, opts) {
    const win = dom.frameWindow(iframe);
    if (!runtime || !win) return Promise.resolve({ error: runtime ? 'it has no document' : 'only the extension can look inside' });
    return new Promise((resolve) => {
      const nonce = crypto.randomUUID();
      let answered = false;
      const finish = (reply) => {
        waiting.delete(nonce);
        clearTimeout(noAnswer);
        clearTimeout(tooLong);
        resolve(reply);
      };
      waiting.set(nonce, (msg) => (msg.ack ? (answered = true) : finish(msg)));
      const noAnswer = setTimeout(() => answered || finish({ unreachable: true }), 1500);
      const tooLong = setTimeout(() => finish({ error: 'it took too long' }), 45000);
      const { states, fonts, embedAssets } = opts;
      win.postMessage({ [FRAME_MSG]: nonce, options: { states, fonts, embedAssets } }, '*');
    });
  }

  if (runtime) {
    runtime.onMessage.addListener((msg) => {
      if (msg?.type === FRAME_MSG) waiting.get(msg.nonce)?.(msg);
    });
    if (window.parent !== window) {
      window.addEventListener('message', async (e) => {
        const nonce = e.data?.[FRAME_MSG];
        if (typeof nonce !== 'string' || e.source !== window.parent) return;
        e.stopImmediatePropagation();
        tell({ nonce, ack: true });
        try {
          // (The page may have written this message itself: take booleans, nothing else.)
          const { states, fonts, embedAssets } = e.data.options || {};
          const result = await capture(document.body || document.documentElement, { states: !!states, fonts: !!fonts, embedAssets: !!embedAssets, asFrame: true, pinWidth: false, backdrop: false });
          tell({ nonce, page: result.page, elements: result.stats.elements, warnings: result.warnings, blockedFrames: result.blockedFrames });
        } catch (err) {
          tell({ nonce, error: String(err?.message || err) });
        }
      });
    }
  }

  globalThis.__domCapture = { capture, describe, normalizeRoot, flatParent, flatChildren, shadowRootOf, DEFAULTS, UI_ATTR };
})();
