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
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['src/capture.js', 'src/picker.js'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => globalThis.__domCapturePicker?.toggle() });
    });
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  // Polled from here rather than with waitForFunction, which has been seen to come back early.
  const copied = async (text) => {
    for (let i = 0; i < 75; i++) {
      const now = await clipboard().catch(() => '');
      if (now.includes(text)) return now;
      await page.waitForTimeout(200);
    }
    throw new Error(`"${text}" never reached the clipboard`);
  };
  // The picker's UI is in a closed shadow root, but the picker object itself can be asked from the
  // extension's isolated world: where one of its buttons is, and what is selected right now.
  const button = (act) =>
    sw.evaluate(async (act) => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        args: [act],
        func: (act) => {
          const picker = globalThis.__domCapturePicker;
          for (const layer of [picker.nav, picker.bar, picker.panel]) {
            const b = [...layer.querySelectorAll('button')].find((b) => (b.dataset.act === act || b.textContent === act) && b.getClientRects().length);
            if (!b) continue;
            const r = b.getBoundingClientRect();
            return { at: [r.x + r.width / 2, r.y + r.height / 2], disabled: b.disabled };
          }
          return null;
        },
      });
      return result;
    }, act);
  const press = async (act) => page.mouse.click(...(await button(act)).at);
  const selection = () =>
    sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const picker = globalThis.__domCapturePicker;
          const name = (el) => (el ? globalThis.__domCapture.describe(el) : '-');
          return `${picker.mode} ${name(picker.target)}${picker.peek ? ` peek:${name(picker.peek)}` : ''}`;
        },
      });
      return result;
    });
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
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.mouse.click(x, y);
  clicked = true;
  await page.waitForTimeout(300);
  check('a click selects — it does not capture yet', (await selection()).startsWith('select ') && (await clipboard()) === '', `${await selection()} / ${(await clipboard()).slice(0, 40)}`);
  await page.screenshot({ path: path.join(outDir, 'e2e-selected.png') });
  await press('capture');
  await copied('DOM Capture:');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(outDir, 'e2e-result.png') });
  const first = await clipboard();
  check('the Capture button copies a snippet to the clipboard', clicked && first.startsWith('<!-- DOM Capture:') && first.includes('<style>'));
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
  await copied('Ada Lovelace');
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

  // Click to select, then walk the tree with the panel's buttons instead of the keyboard.
  console.log('\nselection panel');
  await page.bringToFront();
  await page.keyboard.press('Escape');
  await page.waitForSelector('dom-capture-ui', { state: 'detached' });
  await inject();
  await page.waitForSelector('dom-capture-ui', { state: 'attached' });
  await page.evaluate(() => (delete window.__pageSawMouse, navigator.clipboard.writeText(''))); // (evaluate waits for the returned promise)
  const [bx, by] = await center('#open-card .bio b');
  await page.mouse.move(bx - 3, by);
  await page.mouse.move(bx, by);
  await page.mouse.click(bx, by);
  check('click pins the element under the cursor', (await selection()) === 'select b', await selection());
  await page.mouse.move(40, 300);
  await page.mouse.move(60, 320);
  check('…and moving the mouse no longer changes it', (await selection()) === 'select b', await selection());
  await press('parent');
  check('Parent button selects the parent', (await selection()) === 'select p.bio', await selection());
  await press('next');
  const second = await selection();
  await press('prev');
  check('Next / Previous buttons step through siblings', second === 'select p.bio' && (await selection()) === 'select p.bio' && (await button('child')).disabled === false, `${second} → ${await selection()}`);
  await press('child');
  check('Child button goes back down', (await selection()) === 'select b', await selection());
  check('…and is disabled on a leaf', (await button('child')).disabled === true);
  const climbed = [];
  for (let i = 0; i < 12 && !(await button('parent')).disabled; i++) {
    await press('parent');
    climbed.push((await selection()).replace('select ', ''));
  }
  check('Parent climbs out of slots and shadow roots, up to <body>', climbed.includes('user-card#open-card') && climbed.includes('div#stage.stage') && climbed.at(-1) === 'body', climbed.join(' → '));
  for (let i = 0; i < climbed.length; i++) await press('child');
  check('Child retraces the way back down', (await selection()) === 'select b', await selection());
  await page.mouse.move(...(await button('parent')).at);
  check('hovering a button previews where it leads', (await selection()) === 'select b peek:p.bio', await selection());
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(outDir, 'e2e-panel.png') });
  await press('user-card#open-card'); // a crumb of the ancestor trail
  check('the ancestor trail jumps straight to an ancestor', (await selection()) === 'select user-card#open-card', await selection());
  check('nothing is copied until asked', (await clipboard()) === '');
  await press('capture');
  await copied('Ada Lovelace');
  const card = await clipboard();
  check('Capture copies the adjusted selection', card.startsWith('<!-- DOM Capture: <user-card> ') && card.includes('Ada Lovelace') && !card.includes('light child of closed host'), card.slice(0, 60));
  await press('Adjust selection');
  check('"Adjust selection" returns to the same selection', (await selection()) === 'select user-card#open-card', await selection());
  const [sx, sy] = await center('#secret');
  await page.mouse.click(sx, sy);
  check('clicking elsewhere moves the selection', /^select (div|strong|slot)/.test(await selection()), await selection());
  await page.keyboard.press('Escape');
  check('Esc drops the selection but keeps picking', (await selection()).startsWith('pick ') && (await page.locator('dom-capture-ui').count()) === 1, await selection());
  check('the page saw none of it', !(await page.evaluate(() => window.__pageSawMouse)), await page.evaluate(() => window.__pageSawMouse));

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
    await page.evaluate(async (id) => {
      await navigator.clipboard.writeText(''); // before anything is captured, or it may land after
      for (const type of ['click', 'mousedown', 'pointerdown', 'pointerup', 'mouseover']) document.addEventListener(type, (e) => e.isTrusted && (window.__pageSawMouse = type), true);
      document.getElementById(id).open();
    }, id);
    await inject();
    await page.waitForSelector('dom-capture-ui', { state: 'attached' });
  };
  const isOpen = (id) => page.evaluate((id) => document.getElementById(id).isOpen, id);
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
  await press('capture');
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
  await press('capture');
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
  await press('capture');
  const floated = await copied('Cherry');
  check('an option of a click-outside dropdown in a closed shadow root can be picked', floated.startsWith('<!-- DOM Capture: <li> '), floated.slice(0, 80));
  check('…and its "click outside" handler never fired — not even for the Capture button', (await isOpen('float')) && !(await page.evaluate(() => window.__outsideSaw)));

  await openAndPick('modal');
  const heading = await page.evaluate(() => {
    const r = document.getElementById('modal').shadowRoot.querySelector('h2').getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  });
  await hover(...heading);
  await page.mouse.click(...heading);
  await press('parent'); // the selection panel, too, has to work from behind the modal
  const behind = await selection();
  await press('child');
  check('Parent / Child buttons work behind a modal dialog', behind.startsWith('select ') && !behind.startsWith('select h2') && (await selection()).startsWith('select h2'), `${behind} → ${await selection()}`);
  await press('capture');
  const modal = await copied('Modal title');
  check('content of a modal dialog (overlay is inert behind it) can be picked', modal.startsWith('<!-- DOM Capture: <h2> ') && (await isOpen('modal')), modal.slice(0, 80));
  // Behind a modal the overlay's own buttons only work because they are hit-tested by hand.
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, 'e2e-modal.png') });
  await press('done');
  await page.waitForSelector('dom-capture-ui', { state: 'detached', timeout: 3000 }).then(
    () => check('the picker’s own buttons still work behind a modal dialog', true),
    () => check('the picker’s own buttons still work behind a modal dialog', false, 'clicking "Done" did not close the picker'),
  );

  // The page is live: text can be edited in place, elements moved, and the last capture pasted in.
  console.log('\nedit text, move elements, paste a capture');
  await page.goto(`${origin}/edit.html`);
  await page.bringToFront();
  await inject();
  await page.waitForSelector('dom-capture-ui', { state: 'attached' });
  const order = () => page.evaluate(() => [...document.querySelectorAll('#list > li')].map((li) => li.id).join(','));
  const selectEl = async (sel) => {
    const [x, y] = await center(sel);
    await hover(x, y);
    await page.mouse.click(x, y);
    await page.waitForTimeout(50);
  };

  await selectEl('#b');
  await page.keyboard.press('e');
  await page.waitForTimeout(50);
  check('E makes the selection editable', await page.evaluate(() => document.getElementById('b').isContentEditable && document.activeElement?.id === 'b'));
  await page.keyboard.press('End');
  await page.keyboard.type(' edited');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(50);
  check('typing then Enter changes the text', (await page.evaluate(() => document.getElementById('b').textContent)) === 'Beta edited', await page.evaluate(() => document.getElementById('b').textContent));
  check('…and leaves no contenteditable behind', await page.evaluate(() => !document.getElementById('b').hasAttribute('contenteditable') && document.activeElement !== document.getElementById('b')));
  check('the page never saw the keys', !(await page.evaluate(() => window.__pageSawKey)), await page.evaluate(() => window.__pageSawKey));
  await page.keyboard.press('e');
  await page.keyboard.type('nope');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(50);
  check('Esc discards an edit', (await page.evaluate(() => document.getElementById('b').textContent)) === 'Beta edited');
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForTimeout(50);
  check('⌘Z undoes the edit', (await page.evaluate(() => document.getElementById('b').textContent)) === 'Beta', await page.evaluate(() => document.getElementById('b').textContent));

  // A text field is edited as itself.
  await selectEl('#ta');
  await page.keyboard.press('e');
  await page.keyboard.type('Fresh notes');
  await page.keyboard.press('ControlOrMeta+Enter');
  await page.waitForTimeout(50);
  check('a <textarea> takes its new value (⌘Enter keeps it)', (await page.evaluate(() => document.getElementById('ta').value)) === 'Fresh notes', await page.evaluate(() => document.getElementById('ta').value));

  // Shift+arrows swap with a neighbour; undo puts it back.
  await selectEl('#b');
  await page.keyboard.press('Shift+ArrowUp');
  await page.waitForTimeout(50);
  check('Shift+↑ moves the selection before its previous sibling', (await order()) === 'b,a,c', await order());
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await page.waitForTimeout(50);
  check('Shift+↓ moves it after the next one', (await order()) === 'a,c,b', await order());
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForTimeout(50);
  check('…and each move can be undone', (await order()) === 'a,b,c', await order());

  // Move by pointing: near an edge = before / after, the middle = inside.
  await selectEl('#a');
  await page.keyboard.press('m');
  const cBox = await page.locator('#c').boundingBox();
  await hover(cBox.x + 40, cBox.y + cBox.height - 3);
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(outDir, 'e2e-move.png') });
  await page.mouse.click(cBox.x + 40, cBox.y + cBox.height - 3);
  await page.waitForTimeout(50);
  check('M then a click at the bottom edge of another element drops it after that element', (await order()) === 'b,c,a', await order());
  await page.keyboard.press('m');
  const [zx, zy] = await center('#zone');
  await hover(zx, zy);
  await page.mouse.click(zx, zy);
  await page.waitForTimeout(50);
  check('a click in the middle of a container drops it inside', await page.evaluate(() => document.querySelector('#zone > #a') !== null && document.querySelectorAll('#list > li').length === 2));
  await page.keyboard.press('e'); // (content scripts live in an isolated world: the selection shows through what the keys do)
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(50);
  check('the moved element stays selected', (await page.evaluate(() => document.querySelector('#zone > #a')?.textContent)) === 'Alpha!');
  // In a row, before / after is left / right.
  await selectEl('#r3');
  await page.keyboard.press('m');
  const r1 = await page.locator('#r1').boundingBox();
  await hover(r1.x + 3, r1.y + r1.height / 2);
  await page.mouse.click(r1.x + 3, r1.y + r1.height / 2);
  await page.waitForTimeout(50);
  check('in a flex row, the left edge means "before"', (await page.evaluate(() => [...document.querySelectorAll('#row > span')].map((s) => s.id).join(','))) === 'r3,r1,r2');
  await page.keyboard.press('m');
  await hover(zx, zy);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(50);
  const rowOrder = () => page.evaluate(() => [...document.querySelectorAll('#row > *')].map((s) => s.id).join(','));
  check('Esc cancels a move', await page.evaluate(() => document.querySelector('#zone > #r3') === null) && (await rowOrder()) === 'r3,r1,r2');
  await page.keyboard.press('Shift+ArrowRight');
  await page.waitForTimeout(50);
  check('…keeping the selection (Shift+→ still moves it)', (await rowOrder()) === 'r1,r3,r2', await rowOrder());

  // Drag: press on the selection, move, release where it goes.
  await selectEl('#b');
  const [bx2, by2] = await center('#b');
  await page.mouse.move(bx2, by2);
  await page.mouse.down();
  await page.mouse.move(bx2 + 10, by2 + 10);
  const zone2 = await page.locator('#zone').boundingBox(); // (it grew when #a went in)
  await page.mouse.move(zone2.x + 40, zone2.y + zone2.height - 8, { steps: 8 }); // its bottom padding: after the last child
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(outDir, 'e2e-drag.png') });
  await page.mouse.up();
  await page.waitForTimeout(50);
  check('dragging the selection and releasing in a container’s padding drops it after its last child', await page.evaluate(() => document.querySelector('#zone > #a + #b') !== null), await page.evaluate(() => document.getElementById('b').parentElement.id));
  await page.keyboard.press('Shift+ArrowUp');
  await page.waitForTimeout(50);
  check('…and it stays selected', await page.evaluate(() => document.querySelector('#zone > #b + #a') !== null));
  // Between two items: releasing in the gap between them (the container's own pixels) lands there.
  const aBox = await page.locator('#zone > #a').boundingBox();
  await page.mouse.move(aBox.x + 30, aBox.y + aBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(aBox.x + 40, aBox.y + aBox.height / 2 + 10);
  const r1Box = await page.locator('#r1').boundingBox();
  await page.mouse.move(r1Box.x + r1Box.width + 4, r1Box.y + r1Box.height / 2, { steps: 6 }); // the 8px flex gap after #r1
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(outDir, 'e2e-drag-gap.png') });
  await page.mouse.up();
  await page.waitForTimeout(50);
  check('releasing in the gap between two items puts it between them', (await rowOrder()) === 'r1,a,r3,r2', `${await rowOrder()} (#a is in ${await page.evaluate(() => { const a = document.getElementById('a'); return `${a.parentElement?.id || a.parentElement?.localName} after ${a.previousElementSibling?.id || a.previousElementSibling?.localName}`; })})`);
  await page.waitForTimeout(50);
  await page.keyboard.press('ControlOrMeta+z'); // the gap drag
  await page.keyboard.press('ControlOrMeta+z'); // Shift+↑
  await page.keyboard.press('ControlOrMeta+z'); // the first drag
  await page.waitForTimeout(50);
  check('…and each drag can be undone', (await order()) === 'b,c' && (await page.evaluate(() => document.querySelector('#zone > #a') !== null)), await order());
  // A drag released without a destination (over the element itself) changes nothing.
  const [cx2, cy2] = await center('#c');
  await selectEl('#c');
  await page.mouse.move(cx2, cy2);
  await page.mouse.down();
  await page.mouse.move(cx2 + 12, cy2 + 2, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  check('a drag released over the element itself is a no-op', (await order()) === 'b,c' && (await page.evaluate(() => document.querySelector('#zone > #a') !== null)));

  // Delete, and undo.
  await page.keyboard.press('Delete');
  await page.waitForTimeout(50);
  check('Delete removes the selection from the page', (await order()) === 'b', await order());
  await page.keyboard.press('Shift+ArrowDown');
  await page.waitForTimeout(50);
  check('…and selects its parent', await page.evaluate(() => document.getElementById('list').previousElementSibling?.id === 'card'));
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForTimeout(50);
  check('…and can be undone', (await order()) === 'b,c' && (await page.evaluate(() => document.getElementById('list').nextElementSibling?.id === 'card')), await order());

  // Moved under another parent, an element keeps the look its old context gave it.
  await selectEl('#addr');
  const addrWas = await page.evaluate(() => {
    const cs = getComputedStyle(document.getElementById('addr'));
    return { padding: cs.paddingLeft, color: cs.color, weight: getComputedStyle(document.querySelector('#addr b')).fontWeight, font: cs.fontFamily };
  });
  await page.keyboard.press('m');
  const zone3 = await page.locator('#zone').boundingBox();
  await hover(zone3.x + 40, zone3.y + 6); // its top padding: before the first child
  await page.mouse.click(zone3.x + 40, zone3.y + 6);
  await page.waitForTimeout(50);
  const addrNow = await page.evaluate(() => {
    const el = document.getElementById('addr');
    const cs = getComputedStyle(el);
    return { parent: el.parentElement.id, first: el.parentElement.firstElementChild === el, padding: cs.paddingLeft, color: cs.color, weight: getComputedStyle(el.querySelector('b')).fontWeight, font: cs.fontFamily, radius: cs.borderRadius };
  });
  check('a move to another parent lands where pointed (before the container’s first child)', addrNow.parent === 'zone' && addrNow.first, JSON.stringify(addrNow));
  check('…and keeps the padding, colour and font its old parent’s rules gave it', addrNow.padding === addrWas.padding && addrNow.color === addrWas.color && addrNow.weight === addrWas.weight && addrNow.font === addrWas.font && addrNow.padding === '16px', `${JSON.stringify(addrWas)} vs ${JSON.stringify(addrNow)}`);
  check('…even where the new context would restyle it (the zone rounds its children; this one keeps its corners)', addrNow.radius === '0px', addrNow.radius);
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForTimeout(50);
  check('undoing the move also drops the pinned styles', await page.evaluate(() => { const el = document.getElementById('addr'); return el.parentElement.id === 'section' && !el.getAttribute('style') && !el.querySelector('b').getAttribute('style'); }));

  // Capture the card, then paste it into another page — where it must look the same despite that page's CSS.
  const cardBox = await page.locator('#card').boundingBox();
  await hover(cardBox.x + 8, cardBox.y + 8); // in its padding: the card itself, not the heading
  await page.mouse.click(cardBox.x + 8, cardBox.y + 8);
  const cardWas = await page.evaluate(() => {
    const el = document.getElementById('card');
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const h2 = getComputedStyle(el.querySelector('h2'));
    return { width: r.width, height: r.height, radius: cs.borderRadius, image: cs.backgroundImage, h2size: h2.fontSize, h2color: h2.color };
  });
  await page.keyboard.press('Enter');
  await copied('Quarterly report');
  check('a capture is kept for pasting', await sw.evaluate(async () => (await chrome.storage.local.get('clip')).clip?.label === 'article#card.card'), await sw.evaluate(async () => (await chrome.storage.local.get('clip')).clip?.label));

  await page.goto(`${origin}/paste-target.html`);
  await page.bringToFront();
  await inject();
  await page.waitForSelector('dom-capture-ui', { state: 'attached' });
  await page.keyboard.press('v');
  const hereBox = await page.locator('#here').boundingBox();
  await hover(hereBox.x + 60, hereBox.y + 2);
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(outDir, 'e2e-paste-pointing.png') });
  await page.mouse.click(hereBox.x + 60, hereBox.y + 2);
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(outDir, 'e2e-pasted.png') });
  const dropped = await page.evaluate(() => {
    const el = document.getElementById('here').previousElementSibling;
    if (!el || el.localName !== 'article') return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const h2 = getComputedStyle(el.querySelector('h2'));
    return { width: r.width, height: r.height, radius: cs.borderRadius, image: cs.backgroundImage, h2size: h2.fontSize, h2color: h2.color, border: cs.borderTopWidth, text: el.textContent.trim(), sheets: document.adoptedStyleSheets.length, styles: document.querySelectorAll('style').length };
  });
  check('V then a click at the top edge of an element pastes the capture before it', !!dropped && dropped.text.startsWith('Quarterly report'), JSON.stringify(dropped));
  check('the pasted element has the size and look it had on the source page', !!dropped && Math.abs(dropped.width - cardWas.width) < 1 && Math.abs(dropped.height - cardWas.height) < 1 && dropped.radius === cardWas.radius && dropped.image === cardWas.image, `${JSON.stringify(cardWas)} vs ${JSON.stringify(dropped)}`);
  check('the destination page’s own CSS (red !important border, 40px red headings) does not touch it', !!dropped && dropped.border === '0px' && dropped.h2size === cardWas.h2size && dropped.h2color === cardWas.h2color, JSON.stringify(dropped));
  check('its styles went in as a constructable stylesheet, not a <style> the CSP could block', !!dropped && dropped.sheets === 1 && dropped.styles === 1);
  await page.keyboard.press('Shift+ArrowDown');
  await page.waitForTimeout(50);
  check('the pasted element is selected, ready to be moved', await page.evaluate(() => document.getElementById('here').nextElementSibling?.localName === 'article'));
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForTimeout(50);
  check('⌘Z removes it again, stylesheet included', await page.evaluate(() => !document.querySelector('article') && document.adoptedStyleSheets.length === 0));
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
