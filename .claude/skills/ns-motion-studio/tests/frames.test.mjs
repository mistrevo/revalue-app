// スチル・コンタクトシート・遷移の帯（frames.mjs）を、fixture を一時フォルダへ複製して検証する。道具が無ければ飛ばす。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { beatStills, CELL_WIDTH, contactSheet, formatTime, GAP, SHEET_COLUMNS, SHEET_ROWS, stills, transitionStrips } from '../scripts/frames.mjs';
import { copyTree, removeTree, toolsDir } from '../scripts/paths.mjs';
import { hasPackage, loadPuppeteer } from '../scripts/tools.mjs';

const SAMPLE = fileURLToPath(new URL('./fixtures/sample/', import.meta.url));
const HAS_TOOLS = hasPackage(toolsDir(), 'puppeteer');
/** s02 だけの単色の背景 */
const S02_BG = [0x0b, 0x3d, 0x91];

/** fixture を、日本語と空白を含む名前の一時フォルダへ複製する */
function copySample() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsms 静止画-'));
  copyTree(SAMPLE, dir);
  return dir;
}

/** PNG の IHDR から幅と高さを読む */
function size(file) {
  const b = fs.readFileSync(file);
  assert.equal(b.toString('latin1', 1, 4), 'PNG');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** 8bit の RGB / RGBA の PNG から、指定の画素の [r, g, b] を読む（行のフィルタを戻す） */
function pixel(file, x, y) {
  const b = fs.readFileSync(file);
  const width = b.readUInt32BE(16);
  assert.equal(b[24], 8, '8bit のみ');
  const bpp = b[25] === 6 ? 4 : 3;
  const chunks = [];
  for (let o = 8; o < b.length;) {
    const len = b.readUInt32BE(o);
    if (b.toString('latin1', o + 4, o + 8) === 'IDAT') chunks.push(b.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * bpp;
  let prev = Buffer.alloc(stride);
  let o = 0;
  for (let row = 0; row <= y; row++) {
    const type = raw[o++];
    const line = Buffer.from(raw.subarray(o, o + stride));
    o += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const up = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      const p = a + up - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - up);
      const pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      line[i] = (line[i] + [0, a, up, (a + up) >> 1, paeth][type]) & 255;
    }
    prev = line;
  }
  return [...prev.subarray(x * bpp, x * bpp + 3)];
}

/** @type {any} */
let browser;
const dirs = [];
before(async () => {
  if (!HAS_TOOLS) return;
  browser = await loadPuppeteer().launch({ headless: 'shell', args: ['--hide-scrollbars', '--force-color-profile=srgb'] });
});
after(async () => {
  await browser?.close();
  for (const d of dirs) removeTree(d);
});

function toolTest(name, fn) {
  test(name, async (t) => {
    if (!HAS_TOOLS) return t.skip('道具が未導入');
    const dir = copySample();
    dirs.push(dir);
    await fn(t, dir);
  });
}

test('時刻を 0:05.2 の形にする', () => {
  assert.equal(formatTime(5.2), '0:05.2');
  assert.equal(formatTime(0), '0:00.0');
  assert.equal(formatTime(75.04), '1:15.0');
});

toolTest('stills(…, [0, 2.5]) の2枚目は s02 の絵（単色の背景）で、ファイル名に比率と時刻が入る', async (_t, dir) => {
  const files = await stills(dir, [0, 2.5], { browser });
  assert.equal(files.length, 2);
  assert.ok(files[0].endsWith(path.join('reviews', 'frames', '16x9', 't-0000.00.png')), files[0]);
  assert.ok(files[1].endsWith(path.join('reviews', 'frames', '16x9', 't-0002.50.png')), files[1]);
  assert.deepEqual(pixel(files[1], 100, 100), S02_BG);
  assert.notDeepEqual(pixel(files[0], 100, 100), S02_BG);
});

toolTest('境目はあとのシーン、総尺ちょうどは最後のシーンの終わりの1フレーム前', async (_t, dir) => {
  const files = await stills(dir, [1.5, 3.0], { browser });
  assert.deepEqual(pixel(files[0], 100, 100), S02_BG, '1.5 秒は s02');
  assert.ok(files[1].endsWith(`t-${(3 - 1 / 30).toFixed(2).padStart(7, '0')}.png`), files[1]);
  assert.deepEqual(pixel(files[1], 100, 100), S02_BG);
});

toolTest('比率が違えば別のファイルになり、上書きしない', async (_t, dir) => {
  const [a] = await stills(dir, [1], { ratio: '16:9', browser });
  const [b] = await stills(dir, [1], { ratio: '1:1', browser });
  assert.notEqual(a, b);
  assert.deepEqual(size(a), { width: 960, height: 540 });
  assert.deepEqual(size(b), { width: 960, height: 960 });
});

toolTest('beatStills は各シーンの落ち着いた時刻（70%、文字が出て 0.6 秒後より前なら後ろへ）と poster で撮る', async (_t, dir) => {
  const files = await beatStills(dir, { browser });
  // s01（0〜1.5）は 1.05、s02（1.5〜3.0）は 2.55
  assert.deepEqual(files.map((f) => path.basename(f)), ['t-0001.05.png', 't-0002.55.png', 't-0002.50.png']);
});

toolTest('contactSheet の幅は 4 × コマ幅 + 余白で、短い動画なら 1 枚', async (_t, dir) => {
  const files = await contactSheet(dir, { browser });
  assert.deepEqual(files.map((f) => path.relative(dir, f)), [path.join('reviews', 'contact-16x9-01.png')]);
  const { width, height } = size(files[0]);
  assert.equal(width, SHEET_COLUMNS * CELL_WIDTH + (SHEET_COLUMNS + 1) * GAP);
  // 3 コマ（0, 1, 2 秒）は 1 行。コマの高さ（16:9）より高い
  assert.ok(height > (CELL_WIDTH * 9) / 16);
});

toolTest('contactSheet は ' + SHEET_ROWS + ' 行ごとに別の画像に分け、前に撮った余分なシートは消す', async (_t, dir) => {
  const reviews = path.join(dir, 'reviews');
  fs.mkdirSync(reviews, { recursive: true });
  for (const old of ['contact-16x9.png', 'contact-16x9-03.png']) fs.writeFileSync(path.join(reviews, old), 'x');
  fs.writeFileSync(path.join(reviews, 'contact-9x16-01.png'), 'x');
  // 3 秒を 0.05 秒ごとに撮ると 60 コマ。1 枚 4 列 × 8 行 = 32 コマなので 2 枚
  const files = await contactSheet(dir, { browser, every: 0.05 });
  assert.deepEqual(files.map((f) => path.basename(f)), ['contact-16x9-01.png', 'contact-16x9-02.png']);
  assert.ok(size(files[0]).height > size(files[1]).height, '2 枚目は残りの 28 コマ（7 行）');
  assert.deepEqual(fs.readdirSync(reviews).filter((f) => f.startsWith('contact-')).sort(),
    ['contact-16x9-01.png', 'contact-16x9-02.png', 'contact-9x16-01.png']);
});

toolTest('比率を指定しなければ、beats・contact・strips は timeline のすべての比率で撮る', async (_t, dir) => {
  const f = path.join(dir, 'timeline.json');
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), ratios: ['16:9', '1:1'] }));
  const beats = await beatStills(dir, { browser });
  assert.deepEqual(beats.map((x) => path.basename(path.dirname(x))), ['16x9', '16x9', '16x9', '1x1', '1x1', '1x1']);
  const sheets = await contactSheet(dir, { browser });
  assert.deepEqual(sheets.map((x) => path.basename(x)), ['contact-16x9-01.png', 'contact-1x1-01.png']);
  const strips = await transitionStrips(dir, { browser });
  assert.deepEqual(strips.map((x) => path.basename(x)), ['strip-16x9-cut1-2.png', 'strip-1x1-cut1-2.png']);
  // 比率を指定すれば、その比率だけ
  assert.equal((await contactSheet(dir, { browser, ratio: '1:1' })).length, 1);
});

toolTest('transitionStrips は境目の数だけ帯を返す', async (_t, dir) => {
  const files = await transitionStrips(dir, { browser });
  assert.equal(files.length, 1);
  assert.ok(files[0].endsWith('strip-16x9-cut1-2.png'), files[0]);
  const { width, height } = size(files[0]);
  assert.ok(width > height);
});

toolTest('前に撮った静止画は、ページの中身・シーン内の時刻・品質が同じなら撮り直さず、直したシーンの分だけ撮り直す', async (_t, dir) => {
  const [a, b] = await stills(dir, [0.5, 2.5], { browser });
  const mtime = (f) => fs.statSync(f).mtimeMs;
  const [ma, mb] = [mtime(a), mtime(b)];
  await new Promise((r) => setTimeout(r, 30));
  await stills(dir, [0.5, 2.5], { browser });
  assert.equal(mtime(a), ma, '同じなら撮り直さない');
  assert.equal(mtime(b), mb);
  // s02 の HTML を変えると、s02 の静止画だけ撮り直す
  const html = path.join(dir, 'src/scenes/s02.html');
  fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replace('<title>', '<title>!'));
  await stills(dir, [0.5, 2.5], { browser });
  assert.equal(mtime(a), ma);
  assert.notEqual(mtime(b), mb, '直したシーンは撮り直す');
  // 品質が変われば撮り直す（ファイル名は同じ）
  const [c] = await stills(dir, [0.5], { browser, preset: 'final' });
  assert.equal(c, a);
  assert.deepEqual(size(c), { width: 1920, height: 1080 });
  // ファイルが消えていれば撮り直す
  fs.rmSync(b);
  await stills(dir, [2.5], { browser });
  assert.ok(fs.existsSync(b));
});
