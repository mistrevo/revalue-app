// アイコン（200×200）の見た目の重さを、素材集の全アイコンと比べる。
//   node <ns-illustrations プラグイン>/scripts/weight.mjs <新しいアイコン.svg>...
// 塗り面積（不透明な画素の割合）を測り、既存アイコンの中央値に対する比を出す。
// 0.55 倍未満は「軽い」、1.8 倍超は「重い」として印を付ける（2026-10 の手直しで、この範囲の外が並べて浮いて見えた）。
// 母集団は個人の素材集を重ねた素材集のアイコン（新しいファイルと同じ名前のものは除く）。
import fs from 'node:fs';
import path from 'node:path';
import { openLibrary } from './library.mjs';
import { loadPuppeteer } from './load-puppeteer.mjs';
import { SHARED_DIR, personalDir } from './paths.mjs';

const fresh = process.argv.slice(2).map((f) => path.resolve(f));
if (!fresh.length) { console.error('使い方: weight.mjs <新しいアイコン.svg>...'); process.exit(1); }
const freshNames = new Set(fresh.map((f) => path.basename(f, '.svg')));
const lib = openLibrary({ shared: SHARED_DIR, personal: personalDir() });
const pop = lib.names().filter((n) => /^icon-/.test(n) && !freshNames.has(n));

const puppeteer = loadPuppeteer();
const browser = await puppeteer.launch({ headless: true });
let bad = 0;
try {
  const page = await browser.newPage();
  await page.goto('about:blank');
  const measure = (/** @type {string} */ svgText) => page.evaluate(async (svg) => {
    const img = new Image();
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = 200;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0, 200, 200);
    const d = x.getImageData(0, 0, 200, 200).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 127) n++;
    return n / 400;
  }, svgText);
  const base = [];
  for (const n of pop) base.push(await measure(/** @type {string} */ (lib.read(n))));
  base.sort((a, b) => a - b);
  const median = base[base.length >> 1];
  console.log(`既存アイコン ${base.length} 点の塗り面積: 中央値 ${median.toFixed(1)}%（下位 1/4 ${base[base.length >> 2].toFixed(1)}%、上位 1/4 ${base[(base.length * 3) >> 2].toFixed(1)}%）`);
  for (const f of fresh) {
    const v = await measure(fs.readFileSync(f, 'utf8'));
    const r = v / median;
    const mark = r < 0.55 ? '  << 軽い（線を太く・要素を大きく・面を足す）' : r > 1.8 ? '  >> 重い（一回り小さく・塗りを減らす）' : '';
    if (mark) bad++;
    console.log(`${path.basename(f).padEnd(28)} ${v.toFixed(1).padStart(5)}%  中央値の ${r.toFixed(2)} 倍${mark}`);
  }
} finally {
  await browser.close();
}
process.exit(bad ? 2 : 0);
