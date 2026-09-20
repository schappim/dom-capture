// End-to-end: an <iframe> is captured with the document it is showing — same-origin, cross-origin
// and nested — and says so when the extension has no access to the frame's site.
//
// Runs the real extension twice: once allowed on every site (what a user has after pressing
// "Allow"), once allowed on the page's own origin only (what `activeTab` gives).
import { chromium } from 'playwright';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '  \x1b[32m✓\x1b[0m' : '  \x1b[31m✗\x1b[0m'} ${name}${!ok && detail ? `\n      ${detail}` : ''}`);
};

const server = http.createServer(async (req, res) => {
  try {
    const body = await readFile(path.join(here, 'fixtures', path.basename(new URL(req.url, 'http://x').pathname)));
    res.writeHead(200, { 'content-type': 'text/html' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const origin = `http://localhost:${port}`;

async function withExtension(hostPermissions, run) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'dom-capture-frames-'));
  const extDir = path.join(tmp, 'ext');
  await cp(path.join(here, '..', 'extension'), extDir, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(extDir, 'manifest.json'), 'utf8'));
  manifest.host_permissions = hostPermissions;
  await writeFile(path.join(extDir, 'manifest.json'), JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1000, height: 800 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  try {
    const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(`${origin}/frames.html`);
    await page.bringToFront();
    for (const frame of ['#same', '#cross']) await page.frameLocator(frame).locator('.framed-title').waitFor();
    await page.frameLocator('#nested').frameLocator('iframe').locator('.framed-title').waitFor();
    // What background.js does on a toolbar click (which a test cannot make).
    await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['src/capture.js'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/picker.js'] });
    });
    await page.waitForSelector('dom-capture-ui', { state: 'attached' });
    await page.evaluate(() => navigator.clipboard.writeText('nothing yet')); // (the OS clipboard outlives a browser, and '' does not overwrite it)
    // Select the first iframe, widen to the wrapper around all three, capture.
    const box = await page.locator('#same').boundingBox();
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.mouse.move(box.x + 24, box.y + 24);
    await page.mouse.click(box.x + 24, box.y + 24);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    // Wait on the picker itself (the clipboard is the OS's, and may hold an older capture).
    const readPanel = () =>
      sw.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const picker = globalThis.__domCapturePicker;
            if (picker?.mode !== 'done' || !picker.result) return null;
            return { text: picker.panel.textContent, allow: !!picker.panel.querySelector('[data-act="allow-frames"]'), blocked: picker.result.blockedFrames, log: picker.log };
          },
        });
        return result;
      });
    let panel = null;
    for (let i = 0; i < 100 && !(panel = await readPanel()); i++) await page.waitForTimeout(200);
    if (!panel) throw new Error('the capture never finished');
    const snippet = await page.evaluate(() => navigator.clipboard.readText());
    await run({ context, page, snippet, panel, sw });
  } catch (e) {
    check('e2e threw', false, e.stack);
  } finally {
    await context.close();
    await rm(tmp, { recursive: true, force: true });
  }
}

console.log('\niframes — extension allowed on the frames\' sites');
await withExtension(['<all_urls>'], async ({ context, page, snippet, panel }) => {
  check('the wrapper was captured', snippet.startsWith('<!-- DOM Capture: <div> '), snippet.slice(0, 60));
  const pasted = await context.newPage();
  await pasted.setContent(`<!doctype html><body>${snippet}</body>`);
  const frames = pasted.locator('iframe');
  check('all three iframes travel as srcdoc, none still points at its src', (await frames.count()) === 3 && (await pasted.locator('iframe[srcdoc]').count()) === 3 && (await pasted.locator('iframe[src]').count()) === 0, snippet.slice(0, 300));
  const look = (frame) =>
    frame.locator('h3').evaluate((h) => {
      const note = h.nextElementSibling;
      return { text: h.textContent + ' / ' + note.textContent, color: getComputedStyle(h).color, noteBg: getComputedStyle(note).backgroundColor, canvas: getComputedStyle(document.documentElement).backgroundColor, scripts: document.scripts.length };
    });
  const want = await look(page.frameLocator('#cross'));
  const same = await look(pasted.frameLocator('iframe >> nth=0'));
  const cross = await look(pasted.frameLocator('iframe >> nth=1'));
  const nested = await look(pasted.frameLocator('iframe >> nth=2').frameLocator('iframe'));
  check('same-origin frame: contents and styles', same.text.includes('Framed heading') && same.text.includes(`localhost:${port}`) && same.color === want.color && same.noteBg === want.noteBg, JSON.stringify(same));
  check('cross-origin frame: contents and styles', cross.text.includes(`on 127.0.0.1:${port}`) && cross.color === want.color && cross.noteBg === want.noteBg, JSON.stringify(cross));
  check('a frame inside a frame', nested.text.includes(`on 127.0.0.1:${port}`) && nested.color === want.color, JSON.stringify(nested));
  check('the frame keeps its canvas colour, and no scripts', cross.canvas === want.canvas && cross.scripts === 0, JSON.stringify({ cross, want }));
  const a = await page.locator('#cross').boundingBox();
  const b = await pasted.locator('iframe >> nth=1').boundingBox();
  check('…and its size', Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  check('permission attributes are dropped with the src', !/allow=|sandbox=/.test(snippet));
  check('nothing to allow', !panel.allow && panel.blocked.length === 0, JSON.stringify(panel.blocked));
  check('the page never sees a frame\'s contents', !(await page.evaluate(() => window.__leak)));
  await pasted.close();
});

console.log('\niframes — extension allowed on the page only (activeTab)');
await withExtension([`${origin}/*`], async ({ context, snippet, panel, sw }) => {
  const pasted = await context.newPage();
  await pasted.setContent(`<!doctype html><body>${snippet}</body>`);
  check('the same-origin frame is still inlined', (await pasted.locator('iframe[srcdoc]').count()) >= 1 && snippet.includes('Framed heading'), snippet.slice(0, 200));
  check('the cross-origin frame keeps its src', (await pasted.locator(`iframe[src="http://127.0.0.1:${port}/framed.html"]`).count()) === 1);
  check('…its site is reported', panel.blocked.length === 1 && panel.blocked[0] === `http://127.0.0.1:${port}`, JSON.stringify(panel.blocked));
  check('…and the panel offers to allow it', panel.allow && panel.text.includes(`127.0.0.1:${port}`), panel.text);
  // Pressing "Allow" asks Chrome for that site, which a test cannot answer. But when Chrome refuses
  // to ask (no user gesture — as here, where the message is sent from code), a window of the
  // extension's own has to take over.
  await pasted.waitForTimeout(6000); // the click that captured still counts as a gesture for 5 s — and then Chrome would ask, for ever
  const opened = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
  const reply = await sw.evaluate(async (blocked) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url?.includes('/frames.html')); // (the pasted copy is the active tab by now)
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, args: [blocked], func: (origins) => chrome.runtime.sendMessage({ type: 'dom-capture:allow-frames', origins }) });
    return result;
  }, panel.blocked);
  const permit = await opened;
  await permit?.waitForLoadState();
  const asked = permit ? await permit.locator('#origins').innerText() : '';
  check('without a usable gesture, an extension window asks for the site instead', reply?.asking === true && !!permit?.url().includes('/permit.html') && asked === `http://127.0.0.1:${port}`, `${JSON.stringify(reply)} ${permit?.url()} ${asked}`);
  check('the debug log says which frames were inlined', /frames — \d of 3 inlined — no access to http:\/\/127\.0\.0\.1/.test(panel.log), panel.log.split('\n').filter((l) => l.includes('frames')).join(' | '));
  await pasted.close();
});

server.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} iframe checks passed`);
process.exit(failed ? 1 : 0);
