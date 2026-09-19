// End-to-end: load the real extension, drive the picker with mouse + keyboard,
// and read the result back from the clipboard.
//
// The toolbar button cannot be clicked from a test, so a throw-away copy of the
// extension gets host permissions and the service worker injects the picker
// exactly like background.js does.
import { chromium } from 'playwright';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { cp, mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'output');
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '  \x1b[32m✓\x1b[0m' : '  \x1b[31m✗\x1b[0m'} ${name}${!ok && detail ? `\n      ${detail}` : ''}`);
};

const tmp = await mkdtemp(path.join(os.tmpdir(), 'dom-capture-e2e-'));
const extDir = path.join(tmp, 'ext');
await cp(path.join(here, '..', 'extension'), extDir, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(extDir, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['<all_urls>'];
await writeFile(path.join(extDir, 'manifest.json'), JSON.stringify(manifest));
await mkdir(outDir, { recursive: true });

const server = http.createServer(async (req, res) => {
  try {
    const body = await readFile(path.join(here, 'fixtures', path.basename(new URL(req.url, 'http://x').pathname)));
    res.writeHead(200, { 'content-type': req.url.endsWith('.svg') ? 'image/svg+xml' : req.url.endsWith('.css') ? 'text/css' : 'text/html' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, r));
const origin = `http://localhost:${server.address().port}`;

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
  await page.goto(`${origin}/components.html`);
  await page.bringToFront();

  const inject = () =>
    sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/capture.js', 'src/picker.js'] });
    });
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  const center = async (sel) => {
    const b = await page.locator(sel).boundingBox();
    return [b.x + b.width / 2, b.y + b.height / 2];
  };

  console.log('\nextension end-to-end');
  await inject();
  await page.waitForSelector('dom-capture-ui', { state: 'attached' });
  check('picker overlay injected', true);

  // Hover then click the closed-shadow-root component.
  const [x, y] = await center('#secret');
  await page.mouse.move(x - 5, y);
  await page.mouse.move(x, y);
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(outDir, 'e2e-picking.png') });
  let clicked = false;
  await page.evaluate(() => {
    for (const type of ['click', 'mousedown', 'mouseover']) document.querySelector('#secret').addEventListener(type, () => (window.__pageSawMouse = type));
  });
  await page.mouse.click(x, y);
  clicked = true;
  await page.waitForFunction(() => navigator.clipboard.readText().then((t) => t.includes('DOM Capture:')), null, { timeout: 10000 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(outDir, 'e2e-result.png') });
  const first = await clipboard();
  check('click copies a snippet to the clipboard', clicked && first.startsWith('<!-- DOM Capture:') && first.includes('<style>'));
  check('picker looks inside shadow roots (deepest element under the cursor)', /DOM Capture: <(div|strong|slot)>/.test(first) && first.includes('closed root:'), first.slice(0, 80));
  check('closed shadow root read through chrome.dom', first.includes('closed root:') || first.includes('light child of closed host'));

  check('page elements never see hover or clicks while picking', !(await page.evaluate(() => window.__pageSawMouse)));

  // Esc closes; re-inject toggles back on; ↑ widens the selection; Enter captures.
  await page.keyboard.press('Escape');
  await page.waitForSelector('dom-capture-ui', { state: 'detached' });
  check('Esc removes the overlay', true);
  await inject();
  await page.waitForSelector('dom-capture-ui', { state: 'attached' });
  await page.evaluate(() => delete window.__pageSawMouse); // with the overlay gone, the page rightly got its hover back
  await page.mouse.move(x - 3, y);
  await page.mouse.move(x, y);
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowUp'); // …all the way up to <body>
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => navigator.clipboard.readText().then((t) => t.includes('Ada Lovelace')), null, { timeout: 10000 });
  const wide = await clipboard();
  check('↑ climbs out of the shadow tree to ancestors, Enter captures', wide.includes('closed root:') && wide.includes('Ada Lovelace') && wide.includes('shadow root on a plain div'));
  check('overlay never leaks into the capture', !wide.includes('dom-capture-ui') && !wide.includes('data-dom-capture-ui'));
  check('…nor while widening with the keyboard', !(await page.evaluate(() => window.__pageSawMouse)));

  // The copied snippet must stand on its own.
  const blank = await context.newPage();
  await blank.setContent(`<!doctype html><body>${wide}</body>`);
  check('climbing stops at <body>', wide.startsWith('<!-- DOM Capture: <body> '), wide.slice(0, 60));
  const a = await page.locator('body').boundingBox();
  const b = await blank.locator('[class^="dc"]').first().boundingBox();
  check(`pasted snippet has the same size (${b.width}×${b.height})`, Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1, `expected ${a.width}×${a.height}`);

  // Injecting again while active toggles it off.
  await page.bringToFront();
  await inject();
  await page.waitForSelector('dom-capture-ui', { state: 'detached' });
  check('second activation toggles the picker off', true);

  // Things that only exist once the page has been actuated: an open dropdown in the top layer
  // (popover), one that closes on any outside click (closed shadow root), and a modal dialog.
  console.log('\nopen dropdowns, popovers and dialogs');
  const openAndPick = async (id) => {
    await page.goto(`${origin}/dropdowns.html`);
    await page.bringToFront();
    await page.evaluate((id) => {
      navigator.clipboard.writeText('');
      for (const type of ['click', 'mousedown', 'pointerdown', 'pointerup', 'mouseover']) document.addEventListener(type, (e) => e.isTrusted && (window.__pageSawMouse = type), true);
      document.getElementById(id).open();
    }, id);
    await inject();
    await page.waitForSelector('dom-capture-ui', { state: 'attached' });
  };
  const isOpen = (id) => page.evaluate((id) => document.getElementById(id).isOpen, id);
  const copied = (text) => page.waitForFunction((t) => navigator.clipboard.readText().then((c) => c.includes(t)), text, { timeout: 10000 }).then(clipboard);
  const hover = async (x, y) => {
    await page.mouse.move(x - 4, y);
    await page.mouse.move(x, y);
  };

  await openAndPick('pop');
  const cherry = await page.evaluate(() => {
    const r = document.getElementById('pop').shadowRoot.querySelector('[data-v=Cherry]').getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  });
  await hover(...cherry);
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(outDir, 'e2e-popover.png') });
  await page.mouse.click(...cherry);
  const option = await copied('Cherry');
  check('an option inside an open popover (top layer) can be picked', option.startsWith('<!-- DOM Capture: <li> ') && !option.includes('Apple'), option.slice(0, 80));
  check('…and the click does not light-dismiss the popover', await isOpen('pop'));
  check('…and the page saw no mouse events', !(await page.evaluate(() => window.__pageSawMouse)), await page.evaluate(() => window.__pageSawMouse));

  // "Pick another" is where the result panel puts it; then ↑ to the whole listbox.
  await page.keyboard.press('Escape');
  await inject();
  await page.waitForSelector('dom-capture-ui', { state: 'attached' });
  await hover(...cherry);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  const listbox = await copied('Apple');
  check('↑ widens to the popover itself', listbox.startsWith('<!-- DOM Capture: <ul> ') && listbox.includes('Banana') && listbox.includes('Cherry'), listbox.slice(0, 80));
  const pasted = await context.newPage();
  await pasted.setContent(`<!doctype html><body>${listbox}</body>`);
  const want = await page.evaluate(() => {
    const r = document.getElementById('pop').shadowRoot.querySelector('ul').getBoundingClientRect();
    return { width: r.width, height: r.height };
  });
  const got = await pasted.locator('[class^="dc"]').first().boundingBox();
  check('a pasted popover is visible, at the size it had', !!got && Math.abs(got.width - want.width) < 1 && Math.abs(got.height - want.height) < 1, `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  await pasted.close();
  await page.bringToFront();

  // A popover that opens while the picker is already up lands above it in the top layer.
  await page.keyboard.press('Escape');
  await page.evaluate(() => (document.getElementById('pop').list.hidePopover(), navigator.clipboard.writeText('')));
  await inject();
  await page.waitForSelector('dom-capture-ui', { state: 'attached' });
  await page.evaluate(() => delete window.__pageSawMouse);
  await hover(...cherry);
  await page.evaluate(() => document.getElementById('pop').open());
  await page.waitForTimeout(100);
  await hover(cherry[0] + 2, cherry[1]);
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(outDir, 'e2e-popover-late.png') });
  await page.mouse.click(cherry[0] + 2, cherry[1]);
  const late = await copied('Cherry');
  check('a popover opened after the picker started can be picked too', late.startsWith('<!-- DOM Capture: <li> ') && (await isOpen('pop')), late.slice(0, 80));
  const leak = await page.evaluate(() => window.__pageSawMouse || document.getElementById('pop').shadowRoot.querySelector('.opt:hover')?.textContent);
  check('…with the overlay back on top of it (no page hover, no page events)', !leak, `leaked: ${leak}`);

  await openAndPick('float');
  const third = await page.evaluate(() => {
    const r = document.getElementById('float').getBoundingClientRect(); // closed root: find the third option by geometry
    return [r.x + 60, r.y + 48 + 6 + 35 * 2 + 17];
  });
  await hover(...third);
  await page.mouse.click(...third);
  const floated = await copied('Cherry');
  check('an option of a click-outside dropdown in a closed shadow root can be picked', floated.startsWith('<!-- DOM Capture: <li> '), floated.slice(0, 80));
  check('…and its "click outside" handler never fired', (await isOpen('float')) && !(await page.evaluate(() => window.__outsideSaw)));

  await openAndPick('modal');
  const heading = await page.evaluate(() => {
    const r = document.getElementById('modal').shadowRoot.querySelector('h2').getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  });
  await hover(...heading);
  await page.mouse.click(...heading);
  const modal = await copied('Modal title');
  check('content of a modal dialog (overlay is inert behind it) can be picked', modal.startsWith('<!-- DOM Capture: <h2> ') && (await isOpen('modal')), modal.slice(0, 80));
  // Behind a modal the overlay's own buttons only work because they are hit-tested by hand.
  // (Closed shadow root, so by position: "Done" is the second button on the panel's last row.)
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, 'e2e-modal.png') });
  await page.mouse.click(448, 750);
  await page.waitForSelector('dom-capture-ui', { state: 'detached', timeout: 3000 }).then(
    () => check('the picker’s own buttons still work behind a modal dialog', true),
    () => check('the picker’s own buttons still work behind a modal dialog', false, 'clicking "Done" did not close the picker'),
  );
} catch (e) {
  check('e2e threw', false, e.stack);
} finally {
  await context.close();
  server.close();
  await rm(tmp, { recursive: true, force: true });
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} e2e checks passed`);
process.exit(failed ? 1 : 0);
