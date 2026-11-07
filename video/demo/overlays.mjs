// 実画面に重ねる短い字を、透明な PNG にする。文字の正本は video/demo/overlays.json
// 使い方: node video/demo/overlays.mjs <出力フォルダ>
// 字の形はここで決める。出す時刻と位置は video/build.mjs に渡す切り方の表に書く
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '../../evals/personas/driver/node_modules/playwright/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2];
if (!out) {
  console.error('使い方: node video/demo/overlays.mjs <出力フォルダ>');
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });
const items = JSON.parse(fs.readFileSync(path.join(HERE, 'overlays.json'), 'utf8'));
const fontCss = pathToFileURL(path.join(HERE, '..', 'motion', 'assets', 'fonts', 'fonts.css')).href;
const fontFamily = 'BIZ UDPGothic';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 400 }, deviceScaleFactor: 1 });
for (const it of items) {
  const small = it.kind === 'note';
  const steps = it.kind === 'steps';
  const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${fontCss}">
<style>
  html,body{margin:0;background:transparent}
  #s{display:inline-block;box-sizing:border-box;padding:12px 18px;background:rgba(255,255,255,.94);border-radius:14px;font-family:'${fontFamily}',sans-serif}
  #s div{display:flex;align-items:center;gap:12px;height:40px;font-size:26px;color:#5b6265;white-space:nowrap}
  #s i{width:12px;height:12px;border-radius:50%;background:#b4bcb8}
  #s .on{color:#1f7a6d;font-weight:700}
  #s .on i{background:#1f7a6d}
  #t{display:inline-block;box-sizing:border-box;max-width:${small ? 520 : 510}px;white-space:pre-line;font-family:'${fontFamily}',sans-serif;
     ${small
    ? 'padding:12px 20px;font-size:24px;line-height:1.45;color:#4b5a57;background:rgba(255,255,255,.92);border-radius:12px;'
    : 'padding:24px 30px;font-size:40px;line-height:1.4;font-weight:700;color:#fff;background:#1f7a6d;border-radius:18px;box-shadow:0 8px 24px rgba(0,0,0,.14);'}}
</style>${steps ? '<div id="s"></div>' : '<div id="t"></div>'}`;
  const file = path.join(out, `${it.id}.html`);
  fs.writeFileSync(file, html);
  await page.goto(pathToFileURL(file).href);
  if (steps) {
    await page.evaluate(({ labels, active }) => {
      const host = document.getElementById('s');
      labels.forEach((label, i) => {
        const row = document.createElement('div');
        if (i === active) row.className = 'on';
        row.append(document.createElement('i'), label);
        host.append(row);
      });
    }, { labels: it.labels, active: it.active });
  } else {
    await page.evaluate(text => { document.getElementById('t').textContent = text; }, it.text);
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  await page.locator(steps ? '#s' : '#t').screenshot({ path: path.join(out, `${it.id}.png`), omitBackground: true });
  fs.rmSync(file);
}
await browser.close();
console.log(`字を ${items.length} 枚作りました: ${out}`);
