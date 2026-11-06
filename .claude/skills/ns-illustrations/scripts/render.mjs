// 素材の確認用の画像を書き出す。新しい素材を、同じカテゴリの既存素材と同じ条件で並べる。
//   node <ns-illustrations プラグイン>/scripts/render.mjs <出力ディレクトリ> <新しい素材.svg>... [--ref 既存の素材名...] [--with-person]
// 書き出すもの:
//   sheet-light.png / sheet-dark.png  … 明るい地（#EEF2F6）と暗い地（#1B1F4A）で、新旧を同じ大きさに並べる
//   sheet-small.png                   … 64px に縮めた一覧（アイコン・演出パーツ向け。重さと見分けを見る）
//   scene.png（--with-person 時）     … 人物（char-newbie-stand-normal）と同じ座標系で並べる（物・家具向け）
// 既存素材の名前は拡張子なしで、個人の素材集を重ねた素材集から読む。新しい素材はファイルのパスで渡す（個人の素材集にあってもよい）。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openLibrary } from './library.mjs';
import { loadPuppeteer } from './load-puppeteer.mjs';
import { SHARED_DIR, personalDir } from './paths.mjs';

const lib = openLibrary({ shared: SHARED_DIR, personal: personalDir() });
/** 重ねた見え方での素材のファイル（個人を優先） */
const libFile = (/** @type {string} */ n) => {
  const o = lib.origin(n);
  return path.join(o === 'personal' ? /** @type {string} */ (lib.dirs.personal) : lib.dirs.shared, `${n}.svg`);
};

const args = process.argv.slice(2);
const out = path.resolve(args.shift() || '');
if (!out || !args.length) {
  console.error('使い方: render.mjs <出力ディレクトリ> <新しい素材.svg>... [--ref 名前...] [--with-person]');
  process.exit(1);
}
const withPerson = args.includes('--with-person');
const refAt = args.indexOf('--ref');
const fresh = (refAt < 0 ? args : args.slice(0, refAt)).filter((a) => !a.startsWith('--')).map((f) => path.resolve(f));
const refs = refAt < 0 ? [] : args.slice(refAt + 1).filter((a) => !a.startsWith('--')).map(libFile);
for (const f of [...fresh, ...refs]) if (!fs.existsSync(f)) { console.error(`見つからない: ${f}`); process.exit(1); }
fs.mkdirSync(out, { recursive: true });

const url = (/** @type {string} */ f) => pathToFileURL(f).href;
const viewBox = (/** @type {string} */ f) => (fs.readFileSync(f, 'utf8').match(/viewBox="([^"]+)"/) || [, '0 0 100 100'])[1].split(/[\s,]+/).map(Number);
const label = (/** @type {string} */ f) => path.basename(f, '.svg') + (fresh.includes(f) ? '（新）' : '');

function sheet(/** @type {string[]} */ files, /** @type {number} */ size, /** @type {string} */ bg) {
  const cells = files.map((f) => `<figure style="margin:0"><div style="width:${size}px;height:${size}px;background:${bg};display:flex;align-items:center;justify-content:center"><img src="${url(f)}" style="max-width:100%;max-height:100%"></div><figcaption style="font:11px sans-serif;width:${size}px;overflow:hidden;white-space:nowrap">${label(f)}</figcaption></figure>`).join('');
  return `<body style="margin:0;background:#fff"><div style="display:flex;flex-wrap:wrap;gap:8px;padding:8px;max-width:1600px">${cells}</div></body>`;
}

function scene(/** @type {string[]} */ files) {
  // 人物と同じ座標系（接地線 y=730）。素材の下端から 30px 上を接地線にそろえる（人物と並ぶ物は y=730 で一致する）
  let x = 0;
  const imgs = [];
  const person = libFile('char-newbie-stand-normal');
  for (const f of [person, ...files]) {
    const [, , w, h] = viewBox(f);
    imgs.push(`<image href="${url(f)}" x="${x}" y="${760 - h}" width="${w}" height="${h}"/>`);
    x += w - 40;
  }
  return { html: `<body style="margin:0;background:#fff"><svg width="${x + 40}" height="780" viewBox="0 0 ${x + 40} 780" style="background:#EEF2F6;display:block">${imgs.join('')}</svg></body>`, width: x + 40 };
}

const puppeteer = loadPuppeteer();
const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  const shot = async (/** @type {string} */ name, /** @type {string} */ html, /** @type {number} */ width) => {
    const tmp = path.join(out, `_${name}.html`);
    fs.writeFileSync(tmp, html);
    await page.setViewport({ width, height: 400 });
    await page.goto(url(tmp));
    await new Promise((r) => setTimeout(r, 400));
    await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
    fs.unlinkSync(tmp);
    console.log('書き出し:', path.join(out, `${name}.png`));
  };
  const all = [...fresh, ...refs];
  await shot('sheet-light', sheet(all, 200, '#EEF2F6'), 1616);
  await shot('sheet-dark', sheet(all, 200, '#1B1F4A'), 1616);
  await shot('sheet-small', sheet(all, 64, '#EEF2F6'), 1616);
  if (withPerson) { const s = scene(fresh); await shot('scene', s.html, s.width); }
} finally {
  await browser.close();
}
