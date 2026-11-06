// 確認用の静止画。動画（MP4）は使わず、シーンの HTML を直接開いて時刻ごとに撮る。
// スチル、コンタクトシート（カット番号と時刻つきの一覧）、シーンの境目の前後の帯を作る。
// シートと帯は、撮った PNG を <img> で並べたページを撮って作る（画像処理のライブラリは増やさない）。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMain, removeFile } from './paths.mjs';
import { checkArgs, openPage, outputSpec, pageHash, ratioDir, withBrowser } from './render.mjs';
import { cutOf, readTimeline, settledTime } from './timeline.mjs';

/** コンタクトシートの列数、1コマの幅、余白（px）。シートの幅は 列数 × コマ幅 + (列数 + 1) × 余白 */
export const SHEET_COLUMNS = 4;
/** コンタクトシート1枚の行数。長い動画（5分なら 1 秒ごとに 300 コマ）を1枚にすると縦に 2 万 px を超えて読めないので、超えたら次の画像に分ける */
export const SHEET_ROWS = 8;
export const CELL_WIDTH = 480;
export const GAP = 8;
/** 帯のコマ数、1コマの幅、境目の前後の秒数 */
const STRIP_FRAMES = 6;
const STRIP_CELL_WIDTH = 320;
const STRIP_SPAN = 0.25;
/** コマの下のラベルの高さ（px） */
const LABEL_HEIGHT = 28;

/**
 * @typedef {'draft'|'final'} Preset
 * @typedef {{ratio?: string, preset?: Preset, browser?: any}} FrameOpts
 */

/** 比率と品質の既定（timeline の最初の比率、ラフ版）を埋めて検査する */
function resolve(tl, { ratio, preset } = {}) {
  const r = ratio ?? tl.ratios[0];
  const p = preset ?? 'draft';
  checkArgs(r, p);
  return { ratio: r, preset: p };
}

const totalEnd = (tl) => tl.scenes[tl.scenes.length - 1].end;

/**
 * 比率を指定されなければ timeline のすべての比率で、指定されればその比率だけで fn を呼び、ファイルをつなげて返す
 * （比率ごとに組み直したレイアウトなので、どれも見る。ブラウザは1回だけ起動する）。
 * @param {string} projectDir
 * @param {FrameOpts} opts
 * @param {(r: {ratio: string, preset: Preset}, browser: any) => Promise<string[]>} fn
 */
function eachRatio(projectDir, opts, fn) {
  const tl = readTimeline(projectDir);
  const list = (opts.ratio ? [opts.ratio] : tl.ratios).map((ratio) => resolve(tl, { ...opts, ratio }));
  return withBrowser(opts.browser, async (b) => {
    const files = [];
    for (const r of list) files.push(...(await fn(r, b)));
    return files;
  });
}

/** 秒を 0:05.2 の形（分:秒.十分の一秒、十分の一秒未満は切り捨て）にする */
export function formatTime(t) {
  const tenths = Math.floor(Math.max(t, 0) * 10 + 1e-6); // 切り捨て（1.45 秒のカットが「1.5」と出て次のカットに見えないように）
  const m = Math.floor(tenths / 600);
  const s = ((tenths % 600) / 10).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

/** ファイル名用の時刻（t-0005.20.png の 0005.20） */
const timeName = (t) => t.toFixed(2).padStart(7, '0');

/**
 * 絶対時刻をシーンとシーン内の時刻にする。境目はあとのシーンに属する。
 * 総尺ちょうど（とそれ以降）は、最後のシーンの終わりの1フレーム前に寄せる。
 */
function locate(tl, t) {
  const last = tl.scenes[tl.scenes.length - 1];
  const at = t >= last.end ? last.end - 1 / tl.fps : t;
  const { cut, scene } = cutOf(tl, at);
  return { cut, scene, at, local: Math.round((at - scene.start) * 1e6) / 1e6 };
}

/** 撮った静止画の鍵の記録（reviews/frames/<比率>/ の中。ファイル名 → 鍵） */
const FRAME_INDEX = '.index.json';

/**
 * 時刻ごとに撮る（ブラウザは呼び出し側のものを使い、シーンのページは同じシーンの間で使い回す）。
 * 前に撮ったファイルの鍵（ページの中身の鍵 pageHash、シーン内の時刻、品質）が同じなら撮り直さない
 * （直しの周ごとに全部撮り直さず、直したシーンの分だけ撮る。前のシーンの尺が変わって後ろへずれただけのシーンも撮り直さない）。
 * @returns {Promise<Array<{file: string, t: number, cut: number}>>} times と同じ順
 */
async function capture(projectDir, times, { ratio, preset }, browser) {
  const tl = readTimeline(projectDir);
  const spec = outputSpec(tl, ratio, preset);
  const dir = path.join(projectDir, 'reviews/frames', ratioDir(ratio));
  fs.mkdirSync(dir, { recursive: true });
  const indexFile = path.join(dir, FRAME_INDEX);
  /** @type {Record<string, string>} */
  let index = {};
  try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { /* 初回 */ }
  /** @type {Map<string, string|null>} シーンごとの pageHash（作れなければ null で、毎回撮る） */
  const hashes = new Map();
  const keyOf = (sceneId, local) => {
    if (!hashes.has(sceneId)) {
      let h = null;
      try { h = pageHash(projectDir, sceneId, ratio); } catch { /* 開くときに理由を知らせる */ }
      hashes.set(sceneId, h);
    }
    const h = hashes.get(sceneId);
    return h ? `${h}|${preset}|${local}` : null;
  };
  /** @type {Map<string, any>} */
  const pages = new Map();
  try {
    const out = [];
    for (const t of times) {
      if (!Number.isFinite(t) || t < 0) throw new Error(`時刻 ${t} は使えません（0 秒以上の数）`);
      const { cut, scene, at, local } = locate(tl, t);
      const file = path.join(dir, `t-${timeName(at)}.png`);
      const name = path.basename(file);
      const key = keyOf(scene.id, local);
      if (key && index[name] === key && fs.existsSync(file)) {
        out.push({ file, t: at, cut });
        continue;
      }
      let page = pages.get(scene.id);
      if (!page) {
        page = await openPage(browser, projectDir, scene.id, ratio, spec);
        pages.set(scene.id, page);
      }
      try {
        await page.evaluate((x) => window.__ms.seek(x), local);
      } catch (e) {
        throw new Error(`シーン ${scene.id} の ${local.toFixed(3)} 秒を描けませんでした: ${e.message}`);
      }
      delete index[name];
      fs.writeFileSync(file, await page.screenshot({ type: 'png', omitBackground: false }));
      if (key) index[name] = key;
      out.push({ file, t: at, cut });
    }
    return out;
  } finally {
    for (const p of pages.values()) await p.close().catch(() => {});
    // 途中で止まっても、撮れた分は次に使い回す
    try { fs.writeFileSync(indexFile, JSON.stringify(index)); } catch { /* 次は撮り直すだけ */ }
  }
}

/**
 * 並べるコマ（PNG とラベル）から 1枚の PNG を作る。
 * @param {any} browser
 * @param {Array<{file: string, label: string}>} cells
 * @param {{columns: number, cellWidth: number}} layout
 * @param {string} outFile
 */
async function compose(browser, cells, { columns, cellWidth }, outFile) {
  const width = columns * cellWidth + (columns + 1) * GAP;
  const items = cells.map((c) => `<figure><img src="${pathToFileURL(c.file).href}"><figcaption>${c.label}</figcaption></figure>`).join('');
  const html = `<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; background: #1b1b1f; }
    main { display: grid; grid-template-columns: repeat(${columns}, ${cellWidth}px); gap: ${GAP}px; padding: ${GAP}px; width: ${columns * cellWidth}px; }
    figure { margin: 0; }
    img { display: block; width: ${cellWidth}px; height: auto; }
    figcaption { height: ${LABEL_HEIGHT}px; color: #fff; font: 600 18px/${LABEL_HEIGHT}px system-ui, 'Yu Gothic UI', Meiryo, sans-serif; }
  </style><main>${items}</main>`;
  // file:// の画像を読むため、ページ自体も file:// で開く（撮ったら消す）
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const htmlFile = `${outFile}.html`;
  fs.writeFileSync(htmlFile, html);
  const page = await browser.newPage();
  try {
    await page.setViewport({ width, height: 100, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(htmlFile).href, { waitUntil: 'load' });
    const broken = await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().then(() => null, () => i.src))));
    if (broken.some(Boolean)) throw new Error(`画像を読み込めません: ${broken.filter(Boolean).join('、')}`);
    fs.writeFileSync(outFile, await page.screenshot({ type: 'png', fullPage: true }));
  } finally {
    await page.close().catch(() => {});
    removeFile(htmlFile);
  }
}

/**
 * 動画の時刻を指定して PNG を撮る。出力は reviews/frames/<比率の : を x に>/t-<秒>.png（例: t-0005.20.png）。
 * @param {string} projectDir
 * @param {number[]} times 動画の先頭からの秒
 * @param {FrameOpts} [opts] 比率の既定は timeline の最初の比率、品質の既定は draft
 * @returns {Promise<string[]>} times と同じ順のファイル
 */
export async function stills(projectDir, times, opts = {}) {
  const r = resolve(readTimeline(projectDir), opts);
  return withBrowser(opts.browser, async (b) => (await capture(projectDir, times, r, b)).map((c) => c.file));
}

/**
 * 各シーンの落ち着いた時刻（timeline.mjs の settledTime: シーンの 70%、最後に出る文字が出て 0.6 秒たつ前なら後ろへ）と、
 * poster の時刻で撮る。比率を指定しなければ、すべての比率で撮る。
 * @param {string} projectDir
 * @param {FrameOpts} [opts]
 * @returns {Promise<string[]>}
 */
export async function beatStills(projectDir, opts = {}) {
  const tl = readTimeline(projectDir);
  const times = tl.scenes.map((s) => settledTime(tl, s));
  if (typeof tl.poster === 'number') times.push(tl.poster);
  return eachRatio(projectDir, opts, async (r, b) => (await capture(projectDir, [...new Set(times)], r, b)).map((c) => c.file));
}

/**
 * コンタクトシート。every 秒ごと（既定 1 秒）に撮り、4 列に並べる。各コマにカット番号と時刻を焼き込む。
 * 1枚は 8 行（32 コマ）まで。超えたら次の画像に分ける。
 * 出力は reviews/contact-<比率の : を x に>-01.png, -02.png …（前に撮った同じ比率のシートは消してから書く）。比率を指定しなければ、すべての比率で作る。
 * @param {string} projectDir
 * @param {FrameOpts & {every?: number}} [opts]
 * @returns {Promise<string[]>}
 */
export async function contactSheet(projectDir, { every = 1, ...opts } = {}) {
  if (!(every > 0)) throw new Error(`every ${every} は使えません（0 より大きい秒数）`);
  const tl = readTimeline(projectDir);
  const times = [];
  for (let i = 0; i * every < totalEnd(tl); i++) times.push(Math.round(i * every * 1e6) / 1e6);
  const reviews = path.join(projectDir, 'reviews');
  return eachRatio(projectDir, opts, async (r, b) => {
    const base = `contact-${ratioDir(r.ratio)}`;
    const shots = await capture(projectDir, times, r, b);
    const cells = shots.map((s) => ({ file: s.file, label: `カット${s.cut} ${formatTime(s.t)}` }));
    // 前に撮ったシート（枚数が多かったときの残りと、分ける前の1枚の名前）を消す
    if (fs.existsSync(reviews)) {
      for (const n of fs.readdirSync(reviews)) {
        if (n === `${base}.png` || (n.startsWith(`${base}-`) && /^\d+\.png$/.test(n.slice(base.length + 1)))) {
          removeFile(path.join(reviews, n));
        }
      }
    }
    const per = SHEET_COLUMNS * SHEET_ROWS;
    const files = [];
    for (let k = 0; k * per < cells.length; k++) {
      const outFile = path.join(reviews, `${base}-${String(k + 1).padStart(2, '0')}.png`);
      await compose(b, cells.slice(k * per, (k + 1) * per), { columns: SHEET_COLUMNS, cellWidth: CELL_WIDTH }, outFile);
      files.push(outFile);
    }
    return files;
  });
}

/**
 * シーンの境目ごとに、前後 ±0.25 秒を 6 コマ横並びの帯にする。
 * 出力は reviews/strip-<比率の : を x に>-cut<前>-<後>.png で、境目の数だけ。比率を指定しなければ、すべての比率で作る。
 * @param {string} projectDir
 * @param {FrameOpts} [opts]
 * @returns {Promise<string[]>}
 */
export async function transitionStrips(projectDir, opts = {}) {
  const tl = readTimeline(projectDir);
  return eachRatio(projectDir, opts, async (r, b) => {
    const files = [];
    for (let i = 0; i + 1 < tl.scenes.length; i++) {
      const boundary = tl.scenes[i].end;
      const times = Array.from({ length: STRIP_FRAMES }, (_, k) =>
        Math.max(0, Math.round((boundary - STRIP_SPAN + (k * 2 * STRIP_SPAN) / (STRIP_FRAMES - 1)) * 1e6) / 1e6));
      const shots = await capture(projectDir, times, r, b);
      const cells = shots.map((s) => ({ file: s.file, label: `カット${s.cut} ${formatTime(s.t)}` }));
      const outFile = path.join(projectDir, 'reviews', `strip-${ratioDir(r.ratio)}-cut${i + 1}-${i + 2}.png`);
      await compose(b, cells, { columns: STRIP_FRAMES, cellWidth: STRIP_CELL_WIDTH }, outFile);
      files.push(outFile);
    }
    return files;
  });
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const [projectDir, command] = args;
  // 位置引数: command のあとから、--ratio / --preset とその値を除いた残り
  const rest = args.slice(2).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'));
  if (!projectDir || !['all', 'contact', 'beats', 'strips', 'at'].includes(command)) {
    console.error('使い方: node frames.mjs <制作フォルダ> all|contact|beats|strips|at <秒...> [--ratio 16:9] [--preset draft|final]（--ratio を省くと、すべての比率で撮る。all は beats・contact・strips をまとめて撮る）');
    process.exit(1);
  }
  const opts = { ratio: opt('--ratio'), preset: /** @type {Preset|undefined} */ (opt('--preset')) };
  try {
    let files;
    if (command === 'all') {
      // ブラウザを1回だけ起動して、まとめて撮る
      files = await withBrowser(undefined, async (browser) => [
        ...(await beatStills(projectDir, { ...opts, browser })),
        ...(await contactSheet(projectDir, { ...opts, browser })),
        ...(await transitionStrips(projectDir, { ...opts, browser })),
      ]);
    } else if (command === 'contact') files = await contactSheet(projectDir, opts);
    else if (command === 'beats') files = await beatStills(projectDir, opts);
    else if (command === 'strips') files = await transitionStrips(projectDir, opts);
    else {
      if (rest.length === 0) throw new Error('at のあとに秒を1つ以上書いてください（例: at 0 5.2）');
      // 比率を指定しなければ、すべての比率で撮る（狭い比率だけ崩れることがあるため）
      files = await eachRatio(projectDir, opts, (r, b) => stills(projectDir, rest.map(Number), { ...r, browser: b }));
    }
    for (const f of files) console.log(f);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
