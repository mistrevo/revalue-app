// 一覧（gallery.html）のカード操作を実ブラウザ（puppeteer）で確かめる。
// puppeteer が無いときはスキップせず、setup-tools.mjs の案内で落とす。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { buildGallery } from '../scripts/catalog.mjs';
import { openLibrary } from '../scripts/library.mjs';
import { loadPuppeteer } from '../scripts/load-puppeteer.mjs';
import { SHARED_DIR } from '../scripts/paths.mjs';

describe('一覧のカード', () => {
  let browser;
  let tmp;
  before(async () => {
    const puppeteer = loadPuppeteer(); // 無ければ案内を出して終了コード 1
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gallery-'));
    const lib = openLibrary({ shared: SHARED_DIR, personal: null });
    fs.writeFileSync(path.join(tmp, 'gallery.html'), buildGallery(lib.names(), (n) => lib.read(n)));
    browser = await puppeteer.launch({ headless: true });
  });
  after(async () => {
    await browser?.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('向き・表情を切り替えると、表示とコピーする名前が揃う', async () => {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      window.__copied = [];
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__copied.push(t); } } });
    });
    await page.goto('file:///' + path.join(tmp, 'gallery.html').split(path.sep).join('/'));
    const sel = '.card[data-current="char-pm-stand-side-right-normal"]';
    // data-current は切り替えで変わるので、最初にカードを掴んでおく
    const card = await page.waitForSelector(sel);
    await card.$eval('[data-side="left"]', (b) => b.click());
    assert.equal(await card.$eval('img', (i) => i.getAttribute('src')), 'char-pm-stand-side-left-normal.svg');
    await card.$eval('[data-expr="smile"]', (b) => b.click());
    await card.$eval('.pick', (b) => b.click());
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(await page.evaluate(() => window.__copied), ['char-pm-stand-side-left-smile.svg']);
    assert.equal(await card.$eval('.name', (n) => n.textContent), 'char-pm-stand-side-left-smile');
    await page.$eval('#q', (q) => { q.value = 'side-left'; q.dispatchEvent(new Event('input')); });
    const shown = await page.$$eval('.card:not([hidden])', (cs) => cs.map((c) => c.dataset.current));
    assert.ok(shown.length > 0);
    assert.ok(shown.every((n) => n.includes('side-left')));
    await page.close();
  });
});
