// Fidelity tests: capture elements from fixture pages in real Chrome, render the
// snippet in an empty page, and compare pixels / computed styles.
//
//   npm test            run everything
//   npm test -- basic   only tests whose name contains "basic"
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');
const outDir = path.join(here, 'output');
const captureJs = path.join(here, '..', 'extension', 'src', 'capture.js');
const filter = process.argv[2] || '';

const TYPES = { '.woff2': 'font/woff2', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.js': 'text/javascript' };

function serve({ cors }) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const blocked = url.pathname.startsWith('/nocors/');
      const file = path.join(fixtures, path.basename(url.pathname));
      try {
        let body = await readFile(file);
        if (file.endsWith('.html')) body = Buffer.from(String(body).replaceAll('__CORS_PORT__', String(corsPort)));
        const headers = { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' };
        if (cors && !blocked) headers['access-control-allow-origin'] = '*';
        res.writeHead(200, headers).end(body);
      } catch {
        res.writeHead(404).end('not found');
      }
    });
    server.listen(0, () => resolve(server));
  });
}

let corsPort = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  \x1b[32m✓\x1b[0m' : '  \x1b[31m✗\x1b[0m'} ${name}${!ok && detail ? `\n      ${detail}` : ''}`);
}

async function capture(page, selector, opts = {}) {
  return page.evaluate(
    async ([sel, o]) => {
      if (o.closedRoots) o.getShadowRoot = (el) => window.__closedRoots?.get(el);
      return window.__domCapture.capture(document.querySelector(sel), o);
    },
    [selector, { id: 'dcx', ...opts }],
  );
}

/** Fraction of pixels that differ noticeably between two PNG buffers. */
async function pixelDiff(page, a, b) {
  return page.evaluate(
    async ([pa, pb]) => {
      const load = async (b64) => createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const [ia, ib] = await Promise.all([load(pa), load(pb)]);
      if (Math.abs(ia.width - ib.width) > 1 || Math.abs(ia.height - ib.height) > 1) {
        return { ratio: 1, note: `size ${ia.width}x${ia.height} vs ${ib.width}x${ib.height}` };
      }
      const w = Math.min(ia.width, ib.width);
      const h = Math.min(ia.height, ib.height);
      const data = (img) => {
        const c = new OffscreenCanvas(w, h).getContext('2d');
        c.drawImage(img, 0, 0);
        return c.getImageData(0, 0, w, h).data;
      };
      const da = data(ia);
      const db = data(ib);
      let bad = 0;
      for (let i = 0; i < da.length; i += 4) {
        if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 60) bad++;
      }
      return { ratio: bad / (w * h), note: `${ia.width}x${ia.height}` };
    },
    [a.toString('base64'), b.toString('base64')],
  );
}

async function run() {
  await mkdir(outDir, { recursive: true });
  const main = await serve({ cors: false });
  const cdn = await serve({ cors: true });
  corsPort = cdn.address().port;
  const origin = `http://localhost:${main.address().port}`;

  const browser = await chromium.launch({ channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 1 });

  const open = async (fixture) => {
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log('   page error:', e.message));
    await page.goto(`${origin}/${fixture}`);
    await page.addScriptTag({ path: captureJs });
    return page;
  };
  /** Render a captured page in a fresh tab that has none of the source CSS. */
  const render = async (result, name) => {
    await writeFile(path.join(outDir, `${name}.html`), result.page);
    const page = await context.newPage();
    await page.setContent(result.page, { waitUntil: 'load' });
    return page;
  };
  const compare = async (name, src, srcSel, out, threshold = 0.004) => {
    const a = await src.locator(srcSel).screenshot();
    const b = await out.locator('.dcx').first().screenshot();
    await writeFile(path.join(outDir, `${name}.source.png`), a);
    await writeFile(path.join(outDir, `${name}.captured.png`), b);
    const { ratio, note } = await pixelDiff(out, a, b);
    check(`${name}: renders the same (${(ratio * 100).toFixed(2)}% pixels differ, ${note})`, ratio <= threshold);
  };

  const tests = {
    async 'basic card'() {
      const page = await open('basic.html');
      const result = await capture(page, '#card');
      const out = await render(result, 'basic-card');
      await compare('basic-card', page, '#card', out);
      const s = result.snippet;

      check('no <script>, inline handlers, inline style or page classes leak', !/<script|onclick|onsubmit|style="letter|card__/.test(s));
      const pageClasses = await page.evaluate(() => [...new Set([...document.querySelectorAll('[class]')].flatMap((el) => [...el.classList]))]);
      // Every class token in the markup and every class selector in the CSS.
      const [cssPart, markupPart] = s.replace(/<!--.*?-->/s, '').split('</style>');
      const used = new Set([
        ...[...markupPart.matchAll(/\sclass="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)),
        ...[...cssPart.replace(/\{[^}]*\}/g, '{}').matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]),
      ]);
      const leaked = pageClasses.filter((c) => used.has(c));
      check('every class in the output is a generated one', [...used].every((c) => /^dcx(-\d+)?$/.test(c)), [...used].join(' '));
      check(`none of the page's ${pageClasses.length} class names appear anywhere in the output`, leaked.length === 0, leaked.join(', '));
      check('header comment names the tag only', s.startsWith('<!-- DOM Capture: <article> from '));
      const auto = await page.evaluate(async () => {
        document.querySelector('.badge').classList.add('dcq');
        const seen = new Set();
        for (let i = 0; i < 3; i++) seen.add((await window.__domCapture.capture(document.querySelector('.badge'))).snippet.match(/class="(dc\w{4}) /)?.[1]);
        return [...seen];
      });
      check('generated prefix is random per capture and unused by the page', auto.length === 3 && auto.every((id) => /^dc\w{4}$/.test(id)));
      check('display:none subtree dropped', !s.includes('never shown'));
      check('root resets with all: initial, descendants with all: unset', /\.dcx-1 \{ all: initial;/.test(s) && s.includes('all: unset;'));
      check('percent / fr / unitless values survive (not frozen to px)', s.includes('repeat(3, 1fr)') && /line-height: 1\.5/.test(s) && /width: calc\(50% - 6px\)/.test(s));
      check('identical elements share a class', (s.match(/class="dcx-\d+">(A|C|D)</g) || []).length === 3 && new Set(s.match(/class="(dcx-\d+)">(?:A|C|D)</g).map((m) => m.split('"')[1])).size === 1);
      check('::before / ::after / ::marker / ::placeholder captured', /::before \{[^}]*content: ""/.test(s) && /::after \{[^}]*content: " →"/.test(s) && /::marker \{ color: rgb\(244, 114, 182\)/.test(s) && /::placeholder \{[^}]*font-style: italic/.test(s));
      check('pseudo-element keeps authored auto width (no frozen px)', !/::before \{[^}]*\bwidth:/.test(s.match(/\.dcx-1::before \{[^}]*\}/)?.[0] || 'width:'));
      check('@keyframes carried (same-origin + CORS sheet)', s.includes('@keyframes spin') && s.includes('@keyframes pulse'));
      check('@font-face carried with absolute URL, unused face skipped', s.includes(`${origin}/fonts/demo-sans.woff2`) && !s.includes('unused.woff2'));
      check('external <use> symbol + gradient pulled in', /<symbol id="icon-star"/.test(s) && /<linearGradient id="grad-out"/i.test(s) && /stop-color: rgb\(99, 102, 241\)/.test(s));
      check('fill: currentColor stays a keyword', /fill: currentcolor/.test(s));
      check('animated element captured at its un-animated base', !/\.dcx-\d+ \{[^}]*animation-name: spin[^}]*transform:/.test(s) && !/\.dcx-\d+ \{[^}]*transform:[^}]*animation-name: spin/.test(s));
      check('only font faces for weights/styles in use are carried', s.includes('demo-sans.woff2') && !s.includes('demo-sans-thin.woff2') && s.includes('demo-sans-italic.woff2'));
      check('external <use href="sprite.svg#heart"> inlined next to the root', /<use href="#dcx-heart-1"/.test(s) && /<symbol id="dcx-heart-1"/.test(s) && !s.includes('sprite.svg'));
      check('mask image embedded as data: URI (cross-origin masks need CORS)', /mask-image: url\("data:image\/svg\+xml;base64,/.test(s));
      check('font without CORS headers embedded; note explains why', /font-family: "Local Mono"; src: url\("data:font\/woff2;base64,/.test(s) && result.notes.some((n) => n.includes('embedded')));
      check('svg geometry stays in attributes', !/\bd: path\(/.test(s) && s.includes('d="M5 35 L30 10 L60 25 L95 5"'));
      check('links absolutized', s.includes(`href="${origin}/reports/q3"`));
      check('form state frozen', s.includes('value="typed by user"') && /type="checkbox"[^>]*checked/.test(s) && /<option[^>]*selected[^>]*>Pro/.test(s) && />live notes<\/textarea>/.test(s));
      check('canvas became an image', /<img[^>]+src="data:image\/png/.test(s) && !s.includes('<canvas'));
      check('picture source dropped, currentSrc used, lazy removed', !s.includes('<source') && s.includes(`src="${origin}/pixel.svg"`) && !s.includes('loading='));
      check('blocked cross-origin sheet reported', result.warnings.some((w) => w.includes('blocked.css')));
      check('backdrop colour recorded for the standalone page', result.page.includes('background: rgb(15, 23, 42)'));

      // Interactive states, checked for real by hovering in the rendered copy.
      const hoverColor = async (pg, sel, prop = 'color') => {
        await pg.locator(sel).first().hover();
        await pg.waitForTimeout(350);
        return pg.locator(sel).first().evaluate((el, p) => getComputedStyle(el)[p], prop);
      };
      const btnClass = await out.locator('button').first().getAttribute('class');
      check(':hover with var() resolved', (await hoverColor(out, 'button', 'backgroundColor')) === 'rgb(55, 48, 163)', btnClass);
      check(':hover inside @media (hover:hover)', (await hoverColor(out, 'footer')) === 'rgb(226, 232, 240)');
      check(':hover from CORS-enabled cross-origin sheet', /:hover \{ background: rgb\(14, 165, 233\)|:hover \{ background: #0ea5e9/.test(s));
      check(':hover via CSS nesting + nested @media (utility-CSS style)', (await hoverColor(out, 'footer span')) === 'rgb(1, 200, 100)');
      await out.locator('button').nth(1).hover();
      await out.waitForTimeout(100);
      check('ancestor :hover (.group:hover .child)', (await out.locator('button').nth(1).locator('span').evaluate((el) => getComputedStyle(el).color)) === 'rgb(251, 191, 36)');
      check(':hover::after pseudo rule', (await out.locator('button').nth(1).evaluate((el) => getComputedStyle(el, '::after').content)) === '"!"');
      await out.locator('input[type=email]').focus();
      check(':focus rule', (await out.locator('input[type=email]').evaluate((el) => getComputedStyle(el).outlineStyle)) === 'solid');
      check('non-matching @media rule ignored', !/color: red/.test(s));
      await page.close();
      await out.close();
    },

    async 'basic sub-element + options'() {
      const page = await open('basic.html');
      // An inline-ish child deep in the tree: inherited context must come along.
      const result = await capture(page, '.card__body');
      const out = await render(result, 'basic-paragraph');
      await compare('basic-paragraph', page, '.card__body', out, 0.01);
      check('inherited font + colour materialized on root', /font-family: "Demo Sans"/.test(result.snippet) && /color: rgb\(203, 213, 225\)/.test(result.snippet));
      check('transparent root receives page backdrop', /background-color: rgb\(15, 23, 42\)|background-color: rgb\(30, 41, 59\)/.test(result.snippet));

      const kept = await capture(page, '.grid', { states: false, backdrop: false, pinWidth: false });
      check('states:false emits no :hover', !kept.snippet.includes(':hover'));
      check('pinWidth:false leaves width alone', !/\.dcx-1 \{[^}]*\bwidth: \d/.test(kept.snippet));

      const noFonts = await capture(page, '#card', { fonts: false });
      check('fonts:false carries no @font-face', !noFonts.snippet.includes('@font-face') && noFonts.snippet.includes('font-family: "Demo Sans"'));

      const path = await capture(page, '.chart path');
      check('picking inside an <svg> snaps to the <svg>', /^<svg/m.test(path.snippet.split('</style>')[1].trim()));

      const embedded = await capture(page, '.pic', { embedAssets: true });
      check('embedAssets inlines images', /<img[^>]+src="data:image\/svg\+xml;base64/.test(embedded.snippet));
      await page.close();
      await out.close();
    },

    async 'hostile pages + debug log'() {
      const page = await open('clobber.html');
      const result = await capture(page, '#login');
      const out = await render(result, 'clobber-form');
      await compare('clobber-form', page, '#login', out);
      check('form whose controls shadow shadowRoot/attributes/childNodes/id… captures fully', result.stats.elements === 8 && result.snippet.includes('id="login"'));
      check('document.styleSheets shadowed by <iframe name>: state rules still found', /:hover \{ border-color/.test(result.snippet));
      check('successful capture carries a debug log with a timeline', /=== DOM Capture debug log ===/.test(result.debugLog) && /walked tree — 8 elements/.test(result.debugLog) && /--- result ---\nok/.test(result.debugLog));

      const failure = await page.evaluate(async () => {
        const original = CSS.supports;
        CSS.supports = () => { throw new Error('boom from test'); };
        try {
          await window.__domCapture.capture(document.querySelector('#login'));
          return null;
        } catch (e) {
          return { message: e.message, log: e.debugLog };
        } finally {
          CSS.supports = original;
        }
      });
      check('a failing capture rejects with a copyable debug log', failure?.message === 'boom from test' && /--- error ---\nError: boom from test/.test(failure.log) && /after step: .*baseline ready/.test(failure.log) && failure.log.includes('form#login'), failure?.log);
      const notElement = await page.evaluate(() => window.__domCapture.capture(null).catch((e) => e.debugLog));
      check('even a bad argument produces a log', /TypeError: capture\(\) needs an element/.test(notElement || ''));
      await page.close();
      await out.close();
    },

    async 'web components'() {
      const page = await open('components.html');
      const result = await capture(page, '#stage', { closedRoots: true });
      const out = await render(result, 'components-stage');
      await compare('components-stage', page, '#stage', out);
      const s = result.snippet;

      check('shadow content inlined (open root)', s.includes('Ada Lovelace') && s.includes('shadow root on a plain div'));
      check('closed shadow root inlined', s.includes('closed root:') && s.includes('light child of closed host'));
      check('slot fallback content used when nothing is slotted', s.includes('Anonymous') && s.includes('No bio yet.'));
      check('unslotted light DOM omitted', !s.includes('never rendered'));
      check('nested component + adopted stylesheet', /<pill-tag-snapshot/.test(s) && /::before \{[^}]*content: "#"/.test(s));
      check('custom elements renamed so they cannot re-upgrade', !/<user-card[\s>]/.test(s) && /<user-card-snapshot/.test(s));
      check('no <style> from shadow roots in markup', (s.match(/<style/g) || []).length === 1);
      check('slot / part plumbing attributes removed', !/\sslot="/.test(s));

      const def = await out.evaluate(() => {
        // Even if the destination defines the same element, the copy is inert.
        customElements.define('user-card', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'open' }); } });
        return document.body.innerText.includes('Ada Lovelace');
      });
      check('copy survives destination defining <user-card>', def);

      await out.locator('text=math').first().hover();
      await out.waitForTimeout(350);
      check(':hover rule from an adopted stylesheet inside a shadow root', (await out.locator('text=math').first().evaluate((el) => getComputedStyle(el.closest('span[class]') || el).backgroundColor)) === 'rgb(17, 24, 39)');
      await out.locator('h3').first().hover();
      check('ancestor :hover inside shadow root', (await out.locator('h3').first().evaluate((el) => getComputedStyle(el).color)) === 'rgb(190, 18, 60)');

      // A single component picked directly, and an element *inside* a shadow tree.
      const card = await capture(page, '#open-card');
      const outCard = await render(card, 'components-card');
      await compare('components-card', page, '#open-card', outCard);
      const inner = await page.evaluate(async () => {
        const el = document.querySelector('#open-card').shadowRoot.querySelector('.row');
        return window.__domCapture.capture(el, { id: 'dcx' });
      });
      const outInner = await render(inner, 'components-inner');
      const a = await page.locator('#open-card .row').screenshot();
      const b = await outInner.locator('.dcx').first().screenshot();
      const d = await pixelDiff(outInner, a, b);
      check(`root inside a shadow tree renders the same (${(d.ratio * 100).toFixed(2)}%)`, d.ratio <= 0.01, d.note);

      const noHook = await capture(page, '#secret');
      check('without chrome.dom a closed root degrades to light DOM', noHook.snippet.includes('light child of closed host') && !noHook.snippet.includes('closed root:'));
      await page.close();
      await out.close();
    },
  };

  for (const [name, fn] of Object.entries(tests)) {
    if (!name.includes(filter)) continue;
    console.log(`\n${name}`);
    try {
      await fn();
    } catch (e) {
      check(`${name}: threw`, false, e.stack);
    }
  }

  await browser.close();
  main.close();
  cdn.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed — outputs in test/output/`);
  process.exit(failed ? 1 : 0);
}

run();
