// シーン単位の書き出し。シーンをブラウザで開き、時刻ごとに撮った PNG を ffmpeg へ流して MP4 にする。
// 入力が前回と同じシーンは描き直さない（差分キャッシュ）。音は付けない（つなぐ段階で足す）。
//
// 決定論: 1つのシーンは1枚のページで、フレームを先頭から順に撮る（並列にしない）。
// フレームは動画全体の格子（先頭からの番号）で決める。シーンは f0 = round(start × fps) から
// f1 = round(end × fps) の手前までを受け持ち、フレーム i はシーン内の時刻 (f0 + i) / fps − start。
// シーンの境目が格子に乗っていなくても、つないだときの総フレーム数が round(総尺 × fps) になる。
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beginRun } from './lock.mjs';
import { isMain, removeFile, replaceFile, toolsDir } from './paths.mjs';
import { injectScene, runtimeSource, sceneInit, sceneUrl } from './scene-page.mjs';
import { assertIntentScenes } from './project.mjs';
import { assertValidTimeline, RATIOS, readTimeline } from './timeline.mjs';
import { bundledBinary, defaultExec, ffmpegPath, loadPuppeteer } from './tools.mjs';

/** 書き出しのしかたを変えたら上げる（古いキャッシュを使わせないため） */
const RENDERER_VERSION = 1;
/** ラフ版の長辺と fps */
const DRAFT_LONG_SIDE = 960;
const DRAFT_FPS = 30;
/** 計測が無いときの、1フレームあたりの見込み秒数 */
const DEFAULT_SECONDS_PER_FRAME = 0.05;
/** 全品質の計測が無いときの1フレームあたりの秒数（1080p の全品質は、ラフ版の約 1.2 倍かかった。ns-skills製品紹介で 0.050 → 0.059） */
const DEFAULT_FINAL_SECONDS_PER_FRAME = 0.065;
/** 全品質の計測が無くラフ版の計測があるときの、ラフ版に掛ける倍率 */
const FINAL_OVER_DRAFT = 1.25;
/**
 * 音をまとめてつなぐ時間の既定（計測が無いとき）。決まってかかる秒数と、動画1秒あたりの秒数。
 * 音量合わせの測り直しと AAC の点検を含み、ほとんどが動画の長さによらない（31 秒の動画で 35 秒、254 秒の動画で 43 秒かかった）。
 */
const DEFAULT_ASSEMBLE_FIXED_SECONDS = 30;
const DEFAULT_ASSEMBLE_SECONDS_PER_VIDEO_SECOND = 0.06;
const PRESETS = {
  draft: { crf: 28, x264: 'veryfast' },
  final: { crf: 18, x264: 'medium' },
};
/**
 * ループの継ぎ目にかかるシーン（最初と最後）の圧縮の設定。x264 の既定（mbtree と aq-mode）は、後のコマで使われない区画の質を下げるので、
 * 最初のコマで動き出すロゴの縁だけが粗くなり、元の絵が同じでも最後のコマと差が出て、ループの点検（8×8 区画の差の平均 6 以下）を通らない
 * （会社紹介の試作で 9.4。この設定で 1.5）。継ぎ目の2つのシーンだけをこの設定にする。ループ版は本編と同じシーンの MP4 をつなぐので、
 * 本編の最初と最後のシーンもこの設定になる（暗い無地の地の縞やファイルの大きさへの影響は測っていない）。
 */
export const SEAM_X264_PARAMS = 'mbtree=0:aq-mode=0';
export const LAUNCH_ARGS = ['--hide-scrollbars', '--force-color-profile=srgb'];
/** 書き出しの上限: 見込みのこの倍数か、見込みにこの秒数を足したもの（長いほう）。超えたら止める（SKILL.md の「止め時」） */
const LIMIT_FACTOR = 2;
const LIMIT_MIN_EXTRA_SECONDS = 60;

/**
 * 書き出しの上限（秒）。見込みの2倍か、見込み + 60 秒の長いほう（短い書き出しの見込みのぶれで止めないため）。
 * @param {number} estimateSeconds
 */
export const renderLimit = (estimateSeconds) =>
  Math.max(LIMIT_FACTOR * estimateSeconds, estimateSeconds + LIMIT_MIN_EXTRA_SECONDS);

/** 書き出しを上限で止めたときの終了コード（render.mjs と assemble.mjs。点検の 1・2 と見分けるため） */
export const RENDER_LIMIT_EXIT = 3;

/** 例外に合う終了コード（上限で止めたなら RENDER_LIMIT_EXIT、ほかは 1） */
export const exitCodeOf = (e) => (e?.code === 'RENDER_LIMIT' ? RENDER_LIMIT_EXIT : 1);

/**
 * @typedef {'draft'|'final'} Preset
 * @typedef {{frame: number, frames: number, sceneId: string, ratio: string, preset: Preset}} Progress
 * @typedef {{file: string, cached: boolean, frames: number}} SceneResult
 */

/**
 * ループの継ぎ目にかかるシーンか（loop が true のときの、最初と最後のシーン）。
 * @param {import('./timeline.mjs').Timeline} tl
 * @param {string} sceneId
 */
export function seamScene(tl, sceneId) {
  if (!tl.loop) return false;
  const i = tl.scenes.findIndex((s) => s.id === sceneId);
  return i === 0 || i === tl.scenes.length - 1;
}

export function checkArgs(ratio, preset) {
  if (!(ratio in RATIOS)) throw new Error(`比率 ${ratio} は使えません（${Object.keys(RATIOS).join('、')} のどれか）`);
  if (!(preset in PRESETS)) throw new Error(`品質 ${preset} は使えません（draft か final）`);
}

/**
 * 書き出しの条件。CSS 上の寸法は比率の解像度のまま、ラフ版は deviceScaleFactor で長辺 960 に縮める。
 * @param {import('./timeline.mjs').Timeline} tl
 * @param {string} ratio
 * @param {Preset} preset
 */
export function outputSpec(tl, ratio, preset) {
  const [width, height] = RATIOS[ratio];
  const scale = preset === 'draft' ? DRAFT_LONG_SIDE / Math.max(width, height) : 1;
  return {
    width, height, scale,
    // yuv420p は偶数の寸法が要る
    outWidth: Math.round((width * scale) / 2) * 2,
    outHeight: Math.round((height * scale) / 2) * 2,
    fps: preset === 'draft' ? DRAFT_FPS : tl.fps,
  };
}

/**
 * シーンが受け持つフレーム。動画全体の格子で数える（シーンごとに切り上げると、つないだときに数がずれる）。
 * @param {{start: number, end: number}} scene 絶対時刻
 * @param {number} fps
 * @returns {{f0: number, frames: number}} f0 は動画全体での最初のフレーム番号
 */
export function sceneFrames(scene, fps) {
  const f0 = Math.round(scene.start * fps);
  return { f0, frames: Math.round(scene.end * fps) - f0 };
}

/** フレーム i を描くシーン内の時刻（秒）。格子とシーン先頭のずれだけ、わずかに負になることがある */
export const frameTime = (scene, fps, f0, i) => Math.round(((f0 + i) / fps - scene.start) * 1e6) / 1e6;

export const ratioDir = (ratio) => ratio.replace(':', 'x');

/** 書き出し先の MP4 とキャッシュの記録 */
function outPaths(projectDir, sceneId, ratio, preset) {
  const dir = path.join(projectDir, 'out/.scenes', preset, ratioDir(ratio));
  return {
    dir,
    file: path.join(dir, `${sceneId}.mp4`),
    partial: path.join(dir, `${sceneId}.partial.mp4`),
    meta: path.join(dir, `${sceneId}.json`),
  };
}

const statsFile = (projectDir) => path.join(projectDir, 'out/.scenes/stats.json');

// ---- キャッシュの鍵 ----

/** HTML / CSS の中から、ファイルを指す参照（src / href / poster / url()）を取り出す */
function references(text) {
  const out = [];
  const re = /\b(?:src|href|poster|data-src)\s*=\s*["']([^"']+)["']|url\(\s*["']?([^"')]+?)["']?\s*\)/gi;
  for (const m of text.matchAll(re)) out.push((m[1] ?? m[2]).trim());
  return out;
}

/**
 * ファイルと、そこから参照されるローカルのファイル（HTML / CSS はさらにその参照も）を集める。
 * 見つからない参照も集める（あとで置けば鍵が変わり、描き直す）。
 * @param {string} file
 * @param {Set<string>} seen 集めた絶対パス
 */
function collectFiles(file, seen) {
  if (seen.has(file)) return;
  seen.add(file);
  if (!/\.(html?|css)$/i.test(file) || !isFile(file)) return;
  for (const ref of references(fs.readFileSync(file, 'utf8'))) {
    // http: や data: など、ローカルのファイルでないものは見ない
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//') || ref.startsWith('#')) continue;
    const rel = ref.replace(/[?#].*$/, '');
    if (!rel) continue;
    let decoded = rel;
    try { decoded = decodeURI(rel); } catch { /* そのまま使う */ }
    collectFiles(path.resolve(path.dirname(file), decoded), seen);
  }
}

const isFile = (f) => fs.existsSync(f) && fs.statSync(f).isFile();

/** フォルダの下のファイルを、名前順にすべて返す（無ければ空） */
function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.join(d.parentPath, d.name))
    .sort();
}

/** @type {Map<string, {key: string, digest: string}>} ファイルの sha256 の覚え（大きな素材を、シーンごとに読み直さないため） */
const digestMemo = new Map();

/** ファイルの中身の sha256。大きさと更新時刻が同じなら覚えた値を使う（書いた直後の2秒は覚えない。同じ時刻のまま書き換わることがあるため） */
function fileDigest(file) {
  const st = fs.statSync(file);
  const key = `${st.size}|${st.mtimeMs}`;
  const memo = digestMemo.get(file);
  if (memo?.key === key) return memo.digest;
  const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (Date.now() - st.mtimeMs > 2000) digestMemo.set(file, { key, digest });
  return digest;
}

/** @type {string|undefined} */
let toolsIdCache;
/**
 * 絵を作る道具の版（puppeteer の版と、ffmpeg の場所と版）。道具を入れ替えたら描き直すため鍵に入れる。
 * 1回の実行の中では変わらないので覚えておく。道具が無くても例外にしない（鍵を作るだけのときのため）。
 */
export function toolsId() {
  if (toolsIdCache !== undefined) return toolsIdCache;
  let puppeteer = 'none';
  try {
    puppeteer = JSON.parse(fs.readFileSync(path.join(toolsDir(), 'node_modules/puppeteer/package.json'), 'utf8')).version;
  } catch { /* 未導入 */ }
  // tools.mjs の ffmpegPath と同じ順（システムのもの、無ければ道具置き場のもの）で探す
  let ffmpeg = 'none';
  const system = defaultExec('ffmpeg -version');
  if (system !== null) {
    ffmpeg = `ffmpeg ${system.split('\n')[0].trim()}`;
  } else {
    const bundled = bundledBinary(toolsDir(), 'ffmpeg-static');
    if (bundled) ffmpeg = `${bundled} ${(spawnSync(bundled, ['-version'], { encoding: 'utf8' }).stdout ?? '').split('\n')[0].trim()}`;
  }
  toolsIdCache = JSON.stringify({ puppeteer, ffmpeg });
  return toolsIdCache;
}

/**
 * シーンの書き出し結果を決める入力すべてから作る sha256。
 * 次を入れる: シーンの HTML とそこから参照するファイル、src/ の下のファイル（ほかのシーンの HTML を除く。
 * JS の import や fetch で読む共通の部品を取りこぼさないため）、assets/ の下のすべてのファイル（JS のテンプレート文字列や
 * 文字列の連結で組んだパスで読む素材を取りこぼさないため。素材を1つ差し替えると全シーンを描き直す）、ランタイム、fonts.css とそのフォント、
 * slice（シーンの長さとシーン内の時刻）、コマの格子とシーンの先頭のずれ（最初のコマのシーン内の時刻）とコマの数、seed、preset、比率、
 * 出力の寸法と fps、書き出しの版、道具の版。
 * シーンの絶対時刻は入れない。シーンの MP4 はシーン内の時刻だけで決まり、つなぐときに並べるだけなので、
 * 前のシーンの尺が変わって後ろへずれただけのシーンは、ずれと数が同じなら描き直さない（尺をコマの長さの倍数で変えたとき）。
 * @param {string} projectDir
 * @param {string} sceneId
 * @param {string} ratio
 * @param {Preset} preset
 * @returns {string}
 */
export function sceneHash(projectDir, sceneId, ratio, preset) {
  checkArgs(ratio, preset);
  const tl = readTimeline(projectDir);
  const { slice } = sceneInit(projectDir, sceneId, ratio);
  const spec = outputSpec(tl, ratio, preset);
  const { f0, frames } = sceneFrames(slice.scene, spec.fps);
  return inputHash(projectDir, tl, sceneId, {
    v: RENDERER_VERSION, tools: toolsId(), preset, ratio, spec, seed: tl.seed ?? 1, slice: localSlice(slice),
    phase: frameTime(slice.scene, spec.fps, f0, 0), frames,
    ...(seamScene(tl, sceneId) ? { seam: SEAM_X264_PARAMS } : {}),
  });
}

/** slice のシーンの絶対時刻（start / end）を、長さに置き換える（ページが見るのはシーンの長さとシーン内の時刻だけ） */
function localSlice(slice) {
  const { start, end, ...scene } = slice.scene;
  return { ...slice, scene: { ...scene, duration: Math.round((end - start) * 1e6) / 1e6 } };
}

/**
 * 自動点検の鍵に使う、シーンのページの中身を決める入力の sha256。sceneHash と同じファイルを入れるが、
 * 書き出しにだけ効くもの（preset、出力の寸法と fps、ffmpeg、ループの継ぎ目）と、シーンの絶対時刻は入れない
 * （ページが見るのはシーンの長さとシーン内の時刻だけ。前のシーンの尺が変わって後ろへずれただけのシーンを、点検し直さないため）。
 * @param {string} projectDir
 * @param {string} sceneId
 * @param {string} ratio
 * @returns {string}
 */
export function pageHash(projectDir, sceneId, ratio) {
  checkArgs(ratio, 'draft');
  const tl = readTimeline(projectDir);
  const { slice } = sceneInit(projectDir, sceneId, ratio);
  let puppeteer = 'none';
  try { puppeteer = JSON.parse(toolsId()).puppeteer; } catch { /* 未導入 */ }
  return inputHash(projectDir, tl, sceneId, {
    v: RENDERER_VERSION, puppeteer, ratio, seed: tl.seed ?? 1, slice: localSlice(slice),
  });
}

/** sceneHash と pageHash の共通部分。head（JSON にできる値）に、ランタイムとシーンが読むファイルを足す */
function inputHash(projectDir, tl, sceneId, head) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(head));
  hash.update('\0runtime\0').update(runtimeSource());
  const own = fileURLToPath(sceneUrl(projectDir, sceneId));
  const others = new Set(tl.scenes.filter((s) => s.id !== sceneId)
    .map((s) => path.resolve(projectDir, s.file ?? `src/scenes/${s.id}.html`)));
  const seen = new Set();
  collectFiles(own, seen);
  collectFiles(path.join(projectDir, 'assets/fonts/fonts.css'), seen);
  for (const f of listFiles(path.resolve(projectDir, 'src'))) if (!others.has(f)) collectFiles(f, seen);
  for (const f of listFiles(path.resolve(projectDir, 'assets'))) collectFiles(f, seen);
  for (const f of seen) {
    // 名前は制作フォルダからの相対にする（フォルダを移しても描き直さない）
    hash.update(`\0${path.relative(projectDir, f).split(path.sep).join('/')}\0`);
    hash.update(isFile(f) ? fileDigest(f) : 'missing');
  }
  return hash.digest('hex');
}

/**
 * 書き出しの進みを、標準エラー（同じ行を書き換える）と out/progress.log（150 フレームごとと、シーンの終わり）に出す。
 * @param {(line: string) => void} log
 */
export function progressPrinter(log) {
  return ({ frame, frames, sceneId, ratio }) => {
    const line = `${sceneId}（${ratio}）: ${frame}/${frames}`;
    if (frame === frames || frame % 30 === 0) process.stderr.write(`\r${line}`);
    if (frame === frames) process.stderr.write('\n');
    if (frame === frames || frame % 150 === 0) log(line);
  };
}

// ---- 書き出し ----

/**
 * ffmpeg の引数。PNG を標準入力から受けて H.264 / yuv420p の MP4 にする。seam はループの継ぎ目のシーン（SEAM_X264_PARAMS を足す）
 * @param {{fps: number, outWidth: number, outHeight: number}} spec
 * @param {Preset} preset
 * @param {string} outFile
 * @param {{seam?: boolean}} [opts]
 */
export function encodeArgs(spec, preset, outFile, { seam = false } = {}) {
  const { crf, x264 } = PRESETS[preset];
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(spec.fps), '-i', '-',
    '-vf', `scale=${spec.outWidth}:${spec.outHeight}:flags=lanczos`,
    '-c:v', 'libx264', '-preset', x264, '-crf', String(crf), ...(seam ? ['-x264-params', SEAM_X264_PARAMS] : []), '-pix_fmt', 'yuv420p',
    '-r', String(spec.fps), '-an', '-movflags', '+faststart',
    outFile,
  ];
}

/** ffmpeg を起動する（引数は encodeArgs） */
function startFfmpeg(spec, preset, outFile, opts) {
  const args = encodeArgs(spec, preset, outFile, opts);
  const proc = spawn(ffmpegPath(), args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  // 早く終わった ffmpeg へ書いたときの EPIPE は、終了コードの側で扱う
  proc.stdin.on('error', () => {});
  const done = new Promise((resolve, reject) => {
    proc.on('error', (e) => reject(new Error(`ffmpeg を起動できません: ${e.message}`)));
    proc.on('close', (code, signal) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`ffmpeg が失敗しました（終了コード ${code ?? signal}）: ${stderr.trim()}`));
    });
  });
  done.catch(() => {}); // 中断のときは呼び出し側が待つ。未処理の reject にしない
  return { proc, done };
}

/**
 * 書き込みが詰まったら空くまで待つ。ffmpeg が先に終わったら失敗にする。
 * ffmpeg がスクショを撮っている間に終わっていると、close はもう来ないので、書く前と待つ前に終わりを確かめる（待ち続けない）。
 * @param {{proc: import('node:child_process').ChildProcess, done: Promise<unknown>}} ff
 * @param {Buffer} buf
 */
export function writeFrame(ff, buf) {
  const ended = () => ff.proc.exitCode !== null || ff.proc.signalCode !== null || !ff.proc.stdin || ff.proc.stdin.destroyed || !ff.proc.stdin.writable;
  const fail = () => ff.done.then(() => { throw new Error('ffmpeg が途中で終了しました'); });
  if (ended()) return fail();
  if (ff.proc.stdin.write(buf)) return Promise.resolve();
  if (ended()) return fail();
  return new Promise((resolve, reject) => {
    const cleanup = () => { ff.proc.stdin.off('drain', onDrain); ff.proc.off('close', onClose); ff.proc.stdin.off('close', onClose); };
    const onDrain = () => { cleanup(); resolve(undefined); };
    const onClose = () => { cleanup(); fail().then(resolve, reject); };
    ff.proc.stdin.once('drain', onDrain);
    ff.proc.stdin.once('close', onClose);
    ff.proc.once('close', onClose);
  });
}

/** ffmpeg を止め、終わるのを待つ（Windows では開いたままのファイルを消せないため） */
async function killFfmpeg(ff) {
  if (ff.proc.exitCode === null && ff.proc.signalCode === null) {
    ff.proc.stdin.destroy();
    ff.proc.kill();
  }
  await ff.done.catch(() => {});
}

/**
 * シーンを開き、フォントと画像の読み込みを確かめる。
 * onPage は読み込みの前に呼ぶ（点検で、読み込み中のページの例外やコンソールも拾うため）。
 * @param {{onPage?: (page: any) => void}} [opts]
 */
/**
 * シーンのページが読んでよい URL か。制作フォルダの中のファイル（file://）と、data: blob: about: だけ。
 * 外（http、制作フォルダの外のファイル）を読むと、描くたびに絵が変わりうる（決定論が崩れる）うえ、意図しないものが動画に写り込むため。
 * @param {string} url
 * @param {string} projectDir
 */
export function allowedSceneUrl(url, projectDir) {
  if (/^(data|blob|about):/i.test(url)) return true;
  if (!/^file:/i.test(url)) return false;
  let file;
  try {
    file = path.resolve(fileURLToPath(url));
  } catch {
    return false;
  }
  const root = path.resolve(projectDir) + path.sep;
  return process.platform === 'win32' ? file.toLowerCase().startsWith(root.toLowerCase()) : file.startsWith(root);
}

export async function openPage(browser, projectDir, sceneId, ratio, spec, { onPage } = {}) {
  const init = sceneInit(projectDir, sceneId, ratio);
  const page = await browser.newPage();
  onPage?.(page);
  /** 止めた読み込み（制作フォルダの外） */
  const blocked = [];
  let failed;
  try {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (allowedSceneUrl(req.url(), projectDir)) req.continue().catch(() => {});
      else {
        blocked.push(req.url());
        req.abort('blockedbyclient').catch(() => {});
      }
    });
    await page.setViewport({ width: spec.width, height: spec.height, deviceScaleFactor: spec.scale });
    await injectScene(page, init);
    await page.goto(sceneUrl(projectDir, sceneId), { waitUntil: 'load' });
    failed = await page.evaluate(() => window.__ms.ready().then(
      () => null,
      (e) => ({ message: String(e?.message ?? e), missingFonts: e?.missingFonts ?? [], brokenImages: e?.brokenImages ?? [] }),
    ));
  } catch (e) {
    await page.close().catch(() => {});
    throw new Error(`シーン ${sceneId} を開けません: ${e.message}`);
  }
  if (blocked.length) {
    await page.close().catch(() => {});
    const list = [...new Set(blocked)].slice(0, 3).map((u) => (u.length > 120 ? `${u.slice(0, 120)}…` : u)).join('、');
    throw new Error(`シーン ${sceneId} が、制作フォルダの外を読もうとしたので止めました（${list}）。画像・書体・音などの素材は制作フォルダの assets/ に置き、そこから読んでください（ネット上のものや、ほかのフォルダのものは読めません）。`);
  }
  if (failed) {
    const parts = [];
    if (failed.missingFonts.length > 0) {
      parts.push(`フォント「${failed.missingFonts.join('」「')}」を読み込めません。assets/fonts に取り込んで fonts.css から読むようにしてください`);
    }
    if (failed.brokenImages.length > 0) parts.push(`画像を読み込めません: ${failed.brokenImages.join('、')}`);
    if (parts.length === 0) parts.push(failed.message);
    await page.close();
    throw new Error(`シーン ${sceneId} を書き出せません。${parts.join('。')}`);
  }
  return page;
}

/**
 * 書き出しの計測を stats.json に足し合わせる（preset と比率ごとの、フレーム数と秒数の合計。見込みに使う）。
 * 直近の1シーンだけで上書きすると、シーンの重さの違いで見込みがぶれるため。
 * @param {string} projectDir
 * @param {Preset} preset
 * @param {string} ratio
 * @param {number} frames 書き出したフレームの数
 * @param {number} seconds かかった秒
 */
export function recordStats(projectDir, preset, ratio, frames, seconds) {
  if (!(frames > 0)) return;
  addStat(projectDir, `${preset}/${ratio}`, 'secondsPerFrame', 'frames', frames, seconds);
}

/**
 * 音をまとめてつなぐのにかかった時間を stats.json に残す（assemble.mjs から呼ぶ。見込みに使う）。
 * @param {string} projectDir
 * @param {Preset} preset
 * @param {number} seconds かかった秒
 * @param {number} videoSeconds 動画の長さ（秒）
 */
export function recordAssembleStats(projectDir, preset, seconds, videoSeconds) {
  if (!(videoSeconds > 0)) return;
  addStat(projectDir, `assemble/${preset}`, 'secondsPerVideoSecond', 'videoSeconds', videoSeconds, seconds);
}

/** stats.json の key に、量（unit）とかかった秒を足し、合計から rate（1 単位あたりの秒）を出し直す */
function addStat(projectDir, key, rate, unit, amount, seconds) {
  const file = statsFile(projectDir);
  let stats = {};
  try { stats = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 初回 */ }
  const old = stats[key];
  const total = (Number(old?.[unit]) || 0) + amount;
  const spent = (Number(old?.seconds) || 0) + seconds;
  stats[key] = { [rate]: spent / total, [unit]: total, seconds: spent };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(stats, null, 2) + '\n');
  replaceFile(tmp, file);
}

/** ブラウザを渡されなければ起動し、使い終わったら閉じる */
export async function withBrowser(given, fn) {
  if (given) return fn(given);
  const browser = await loadPuppeteer().launch({ headless: 'shell', args: LAUNCH_ARGS });
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

/**
 * 書き出しの計画。鍵を作り、前回の書き出しが使えるかを調べる（鍵は1回だけ作る）。
 * @param {string} projectDir
 * @param {string} sceneId
 * @param {string} ratio
 * @param {Preset} preset
 */
function planScene(projectDir, sceneId, ratio, preset) {
  checkArgs(ratio, preset);
  const tl = readTimeline(projectDir);
  const scene = tl.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`シーン ${sceneId} が見つかりません`);
  const spec = outputSpec(tl, ratio, preset);
  const { f0, frames } = sceneFrames(scene, spec.fps);
  const out = outPaths(projectDir, sceneId, ratio, preset);
  const hash = sceneHash(projectDir, sceneId, ratio, preset);
  return { projectDir, sceneId, ratio, preset, scene, spec, f0, frames, out, hash, seam: seamScene(tl, sceneId), cache: readCache(out, hash) };
}

/**
 * 前回の書き出しの記録。鍵が一致し、MP4 もあるときだけ返す（記録が無い・読めないときは null）。
 * @returns {{hash: string, frames: number} | null}
 */
function readCache(out, hash) {
  try {
    const meta = JSON.parse(fs.readFileSync(out.meta, 'utf8'));
    return meta.hash === hash && fs.existsSync(out.file) ? meta : null;
  } catch {
    return null;
  }
}

/**
 * 計画どおりに描いて MP4 にする。
 * @param {ReturnType<typeof planScene>} plan
 * @param {any} browser
 * @param {((p: Progress) => void) | undefined} onProgress
 * @returns {Promise<SceneResult>}
 */
async function renderPlanned(plan, browser, onProgress, deadline) {
  const { projectDir, sceneId, ratio, preset, scene, spec, f0, frames, out, hash } = plan;
  if (plan.cache) return { file: out.file, cached: true, frames: plan.cache.frames };
  fs.mkdirSync(out.dir, { recursive: true });
  removeFile(out.partial);
  const started = performance.now();
  const page = await openPage(browser, projectDir, sceneId, ratio, spec);
  const ff = startFfmpeg(spec, preset, out.partial, { seam: plan.seam });
  let drawn = 0;
  try {
    for (let i = 0; i < frames; i++) {
      if (deadline?.over()) {
        // 途中までの計測も残す（再開したときの見込みと上限が、実際の速さに近づく）
        if (drawn > 0) recordStats(projectDir, preset, ratio, drawn, (performance.now() - started) / 1000);
        throw deadline.error();
      }
      const t = frameTime(scene, spec.fps, f0, i);
      try {
        await page.evaluate((x) => window.__ms.seek(x), t);
      } catch (e) {
        throw new Error(`シーン ${sceneId} の ${t.toFixed(3)} 秒を描けませんでした: ${e.message}`);
      }
      // 圧縮を弱くして速く撮る（画素は同じ。1920×1080 の平らな色のシーンで 1 コマ 90 → 70 ms ほど、全面のグラデーションで 550 → 200 ms ほど。
      // ファイルは 2〜4 倍大きくなるが、すぐ ffmpeg に渡すので問わない）
      const png = await page.screenshot({ type: 'png', omitBackground: false, optimizeForSpeed: true });
      await writeFrame(ff, png);
      drawn++;
      onProgress?.({ frame: i + 1, frames, sceneId, ratio, preset });
    }
    ff.proc.stdin.end();
    await ff.done;
  } catch (e) {
    await killFfmpeg(ff);
    removeFile(out.partial);
    throw e;
  } finally {
    await page.close().catch(() => {});
  }
  replaceFile(out.partial, out.file);
  fs.writeFileSync(out.meta, JSON.stringify({ hash, frames, fps: spec.fps, ratio, preset }, null, 2) + '\n');
  recordStats(projectDir, preset, ratio, frames, (performance.now() - started) / 1000);
  return { file: out.file, cached: false, frames };
}

/** stats.json（無ければ空） */
function readStats(projectDir) {
  try { return JSON.parse(fs.readFileSync(statsFile(projectDir), 'utf8')); } catch { return {}; }
}

/** まだ書き出していない計画の、書き出しの見込み（秒） */
function plannedSeconds(projectDir, plans) {
  const stats = readStats(projectDir);
  return plans.filter((p) => !readCache(p.out, p.hash)).reduce((sum, p) => sum + p.frames * secondsPerFrame(stats, p.preset, p.ratio), 0);
}

/**
 * 計画をまとめて書き出す。ブラウザは、描き直すものがあるときだけ1回起動する。
 * 始める時の見込みから上限（renderLimit）を決め、超えたら描いている途中のシーンを捨てて止める（例外の code は RENDER_LIMIT）。
 * ただし、この実行で最初に描くシーンは止めずに書き終える（必ず1シーンは進み、計測も増えるので、再実行が同じ所で止まり続けない）。
 * 止めたシーンの途中までの計測も残す。書き終えたシーンは残るので、同じコマンドをもう一度実行すれば残りから続く。
 * @param {Array<ReturnType<typeof planScene>>} plans
 * @param {{onProgress?: (p: Progress) => void, browser?: any, clock?: () => number}} opts clock は秒を返す時計（試験で差し替える）
 */
async function renderPlans(plans, { onProgress, browser, clock = () => performance.now() / 1000 }) {
  const projectDir = plans[0]?.projectDir;
  const expected = projectDir ? plannedSeconds(projectDir, plans) : 0;
  const limit = renderLimit(expected);
  const started = clock();
  /** この実行で書き終えたシーンの数（前から残っていたものは数えない） */
  let rendered = 0;
  const deadline = {
    over: () => rendered > 0 && clock() - started > limit,
    error: () => {
      const rest = plannedSeconds(projectDir, plans);
      return Object.assign(new Error(`書き出しが見込み（約 ${Math.ceil(expected)} 秒）の2倍を超えたので止めました（上限 ${Math.ceil(limit)} 秒）。`
        + `この実行で書き終えた ${rendered} シーンは残してあります（描いている途中のシーンは捨てました）。`
        + `かかった時間（約 ${Math.round(clock() - started)} 秒）と新しい見込み（残り約 ${Math.ceil(rest)} 秒）を利用者に伝えてから、`
        + '同じコマンドをもう一度実行して、残りから再開してください（SKILL.md の「止め時」）。'), { code: 'RENDER_LIMIT' });
    },
  };
  const run = async (b) => {
    const results = [];
    for (const p of plans) {
      const r = await renderPlanned(p, b, onProgress, deadline);
      if (!r.cached) rendered++;
      results.push({ sceneId: p.sceneId, ratio: p.ratio, ...r });
    }
    return results;
  };
  if (browser || plans.every((p) => p.cache)) return run(browser);
  return withBrowser(undefined, run);
}

/**
 * 1つのシーンを MP4 に書き出す。入力が前回と同じなら描き直さない。
 * 出力は out/.scenes/<preset>/<比率の : を x に>/<sceneId>.mp4。途中は <sceneId>.partial.mp4 に書き、終わってから名前を変える。
 * @param {string} projectDir 制作フォルダ
 * @param {string} sceneId
 * @param {{ratio: string, preset: Preset, onProgress?: (p: Progress) => void, browser?: any}} opts
 *   browser を渡すとそれを使う（何シーンも続けて書き出すとき、起動を1回で済ませる）
 * @returns {Promise<SceneResult>}
 */
export async function renderScene(projectDir, sceneId, { ratio, preset, onProgress, browser }) {
  const [r] = await renderPlans([planScene(projectDir, sceneId, ratio, preset)], { onProgress, browser });
  return { file: r.file, cached: r.cached, frames: r.frames };
}

/**
 * すべてのシーンを、比率ごとに書き出す（ブラウザは1回だけ起動する）。
 * @param {string} projectDir
 * @param {{ratios?: string[], preset: Preset, onProgress?: (p: Progress) => void, browser?: any, scenes?: string[], clock?: () => number}} opts
 *   ratios を省くと timeline.json の ratios。scenes を渡すと、そのシーンだけ書き出す。見込みの2倍を超えたら止める（renderPlans）
 * @returns {Promise<Array<SceneResult & {sceneId: string, ratio: string}>>}
 */
export async function renderAll(projectDir, { ratios, preset, onProgress, browser, scenes, clock }) {
  const tl = readTimeline(projectDir);
  const ids = scenes ?? tl.scenes.map((s) => s.id);
  const plans = (ratios ?? tl.ratios).flatMap((ratio) => ids.map((id) => planScene(projectDir, id, ratio, preset)));
  return renderPlans(plans, { onProgress, browser, clock });
}

/**
 * 書き出しにかかる時間の見込み。これまでの計測（out/.scenes/stats.json）の1フレームあたりの秒数を使う。
 * 計測が無ければ、ラフ版は 1フレーム 0.05 秒、全品質はラフ版の計測の 1.25 倍（それも無ければ 0.065 秒）とする。
 * assembleSeconds は、シーンを書き出した後に音をまとめてつなぐ時間（assemble.mjs のとき。計測が無ければ 30 秒と動画1秒あたり 0.06 秒）。
 * @param {string} projectDir
 * @param {{ratios?: string[], preset: Preset}} opts
 * @returns {{frames: number, toRender: number, seconds: number, assembleSeconds: number}} toRender は前回のまま使えるシーンを除いた、書き出すフレームの数。seconds はその見込み
 */
export function estimate(projectDir, { ratios, preset }) {
  const tl = readTimeline(projectDir);
  const stats = readStats(projectDir);
  let frames = 0;
  let toRender = 0;
  let seconds = 0;
  for (const ratio of ratios ?? tl.ratios) {
    checkArgs(ratio, preset);
    const { fps } = outputSpec(tl, ratio, preset);
    for (const s of tl.scenes) {
      const n = sceneFrames(s, fps).frames;
      frames += n;
      if (isCached(projectDir, s.id, ratio, preset)) continue;
      toRender += n;
      seconds += n * secondsPerFrame(stats, preset, ratio);
    }
  }
  const videoSeconds = tl.scenes.length ? tl.scenes[tl.scenes.length - 1].end : 0;
  const measured = stats[`assemble/${preset}`]?.secondsPerVideoSecond;
  const assemble = measured ? videoSeconds * measured : DEFAULT_ASSEMBLE_FIXED_SECONDS + videoSeconds * DEFAULT_ASSEMBLE_SECONDS_PER_VIDEO_SECOND;
  const round = (x) => Math.round(x * 1e6) / 1e6;
  return { frames, toRender, seconds: round(seconds), assembleSeconds: round(assemble) };
}

/** 1フレームあたりの秒数の見込み（計測 → 全品質ならラフ版の計測の倍率 → 既定） */
function secondsPerFrame(stats, preset, ratio) {
  const own = stats[`${preset}/${ratio}`]?.secondsPerFrame;
  if (own) return own;
  if (preset === 'final') {
    const draft = stats[`draft/${ratio}`]?.secondsPerFrame;
    return draft ? draft * FINAL_OVER_DRAFT : DEFAULT_FINAL_SECONDS_PER_FRAME;
  }
  return DEFAULT_SECONDS_PER_FRAME;
}

/** 前回の書き出しをそのまま使えるか（シーンの HTML や道具が無くて鍵を作れないときは、使えないとみなす） */
function isCached(projectDir, sceneId, ratio, preset) {
  try {
    return readCache(outPaths(projectDir, sceneId, ratio, preset), sceneHash(projectDir, sceneId, ratio, preset)) !== null;
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const projectDir = args[0];
  if (!projectDir || projectDir.startsWith('--')) {
    console.error('使い方: node render.mjs <制作フォルダ> [--scene s01] [--ratio 16:9] [--preset draft|final] [--estimate]');
    process.exit(1);
  }
  const preset = /** @type {Preset} */ (opt('--preset') ?? 'draft');
  const sceneId = opt('--scene');
  const ratio = opt('--ratio');
  try {
    assertIntentScenes(projectDir, assertValidTimeline(projectDir));
    const ratios = ratio ? [ratio] : undefined;
    const estimateOnly = args.includes('--estimate');
    if (!sceneId || estimateOnly) {
      const est = estimate(projectDir, { ratios, preset });
      const reuse = est.toRender < est.frames ? `うち ${est.frames - est.toRender} フレームは前回のまま使い、書き出すのは ${est.toRender} フレーム` : '全部を書き出す';
      // 音をまとめてつなぐ時間は、動画全体を書き出すときだけ足す（--scene のシーンだけの書き出しには関係しない）
      const assemble = sceneId ? ''
        : `。assemble.mjs で音をまとめてつなぐなら、さらに約 ${Math.ceil(est.assembleSeconds)} 秒（合わせて約 ${Math.ceil(est.seconds + est.assembleSeconds)} 秒）`;
      console.log(`見込み: ${est.frames} フレーム（${reuse}）、約 ${Math.ceil(est.seconds)} 秒${assemble}`);
      if (estimateOnly) process.exit(0); // 見込みだけ出して、書き出さない（動画全体の見込み）
    }
    const run = beginRun(projectDir, 'render.mjs');
    const onProgress = progressPrinter(run.log);
    const results = await renderAll(projectDir, { ratios, preset, onProgress, scenes: sceneId ? [sceneId] : undefined });
    for (const r of results) console.log(`${r.sceneId}（${r.ratio}）: ${r.cached ? '前回のまま' : '書き出し'} ${r.file}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(exitCodeOf(e));
  }
}
