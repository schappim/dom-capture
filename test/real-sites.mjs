// Manual smoke test against live sites (needs network; not part of `npm test`).
//   node test/real-sites.mjs [outDir]
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] || path.join(here, 'output', 'real');
await mkdir(outDir, { recursive: true });
const source = await readFile(path.join(here, '..', 'extension', 'src', 'capture.js'), 'utf8');

// Targets live in test/real-sites.json (git-ignored, so no third-party sites are
// baked into this repo). Copy test/real-sites.example.json to get started:
//   [["name", "https://…", "css selector"], …]
const configPath = path.join(here, 'real-sites.json');
let SITES;
try {
  SITES = JSON.parse(await readFile(configPath, 'utf8'));
} catch {
  console.error(`No targets configured. Create ${configPath} — see real-sites.example.json.`);
  process.exit(1);
}

const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
for (const [name, url, selector] of SITES) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(1500);
    await page.evaluate(source);
    const t0 = Date.now();
    const result = await page.evaluate(async (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      el.scrollIntoView({ block: 'start' });
      el.setAttribute('data-picked', '');
      return window.__domCapture.capture(el, { id: 'dcx' });
    }, selector);
    if (!result) throw new Error(`no element for ${selector}`);
    const ms = Date.now() - t0;
    await writeFile(path.join(outDir, `${name}.html`), result.page);
    const a = await page.locator('[data-picked]').screenshot({ animations: 'disabled' });
    const out = await context.newPage();
    await out.setContent(result.page, { waitUntil: 'load' });
    await out.waitForTimeout(800);
    const b = await out.locator('.dcx').first().screenshot({ animations: 'disabled' });
    await writeFile(path.join(outDir, `${name}.source.png`), a);
    await writeFile(path.join(outDir, `${name}.captured.png`), b);
    const boxA = await page.locator('[data-picked]').boundingBox();
    const boxB = await out.locator('.dcx').first().boundingBox();
    console.log(`${name.padEnd(13)} <${result.label}> ${result.stats.elements} els, ${result.stats.rules} rules, ${Math.round(result.stats.bytes / 1024)} KB, ${ms} ms | ${Math.round(boxA.width)}×${Math.round(boxA.height)} → ${Math.round(boxB.width)}×${Math.round(boxB.height)}${result.warnings.length ? `\n              ⚠ ${result.warnings.join('\n              ⚠ ')}` : ''}`);
    await out.close();
  } catch (e) {
    console.log(`${name.padEnd(13)} FAILED: ${e.message.split('\n')[0]}`);
  }
  await page.close();
}
await browser.close();
