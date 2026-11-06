// 入れた道具（puppeteer / ffmpeg）の読み込みと場所の解決。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolsDir } from './paths.mjs';

/** 案内に出す導入のコマンド（ホームのパスに空白があってもそのまま貼れるよう、引用符で囲む） */
export const SETUP_COMMAND = `node "${fileURLToPath(new URL('./setup-tools.mjs', import.meta.url))}"`;

/** コマンドを実行して標準出力を返す。実行できなければ null */
export function defaultExec(cmd) {
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 ? r.stdout : null;
}

/** 道具置き場にそのパッケージが入っているか */
export function hasPackage(tools, name) {
  return fs.existsSync(path.join(tools, 'node_modules', name, 'package.json'));
}

/**
 * 道具置き場の ffmpeg-static / ffprobe-static の実行ファイル。無ければ null。
 * パッケージを読み込まずファイルの有無だけで見る（診断を軽く、テストしやすくするため）。
 * @param {string} tools
 * @param {'ffmpeg-static'|'ffprobe-static'} pkg
 */
export function bundledBinary(tools, pkg) {
  const bin = pkg === 'ffmpeg-static' ? 'ffmpeg' : 'ffprobe';
  const exe = process.platform === 'win32' ? `${bin}.exe` : bin;
  const candidates = [
    path.join(tools, 'node_modules', pkg, exe),
    path.join(tools, 'node_modules', pkg, 'bin', process.platform, process.arch, exe), // ffprobe-static の配置
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/** @type {Map<string, string>} 見つけた場所（1回の実行の中では変わらないので覚えておく。shell 経由で 1 回 0.25 秒ほどかかる） */
const binCache = new Map();

/**
 * ffmpeg / ffprobe の場所。システムにあればそれ、無ければ道具置き場のもの。どちらも無ければ案内を出して終了コード 1。
 * @param {'ffmpeg'|'ffprobe'} cmd
 */
function resolveBin(cmd) {
  const known = binCache.get(cmd);
  if (known) return known;
  if (defaultExec(`${cmd} -version`) !== null) {
    binCache.set(cmd, cmd);
    return cmd;
  }
  const bundled = bundledBinary(toolsDir(), cmd === 'ffmpeg' ? 'ffmpeg-static' : 'ffprobe-static');
  if (bundled) {
    binCache.set(cmd, bundled);
    return bundled;
  }
  console.error(`${cmd} が見つかりません。次を実行して道具を入れてください:\n  ${SETUP_COMMAND}`);
  process.exit(1);
}

export function ffmpegPath() {
  return resolveBin('ffmpeg');
}

export function ffprobePath() {
  return resolveBin('ffprobe');
}

/**
 * フィルターをファイルから読ませる ffmpeg の引数。7.0 から `-/filter_complex <ファイル>` になり、
 * 前の `-filter_complex_script` は新しい版（9.0.1 で確認）では受け付けない。同梱の ffmpeg-static（6.x）は前の書き方しか知らない。
 * @param {string} file
 * @param {string|null} versionText `ffmpeg -version` の出力。読めない版（自分で作った版など）は新しい書き方にする
 * @returns {string[]}
 */
export function filterScriptArgs(file, versionText) {
  const major = Number(/ffmpeg version n?(\d+)\./.exec(versionText ?? '')?.[1]);
  return Number.isFinite(major) && major < 7 ? ['-filter_complex_script', file] : ['-/filter_complex', file];
}

let ffmpegVersionText;
/** 使う ffmpeg の `-version` の出力（1回だけ調べる） */
export function ffmpegVersion() {
  if (ffmpegVersionText === undefined) {
    const r = spawnSync(ffmpegPath(), ['-version'], { encoding: 'utf8', windowsHide: true });
    ffmpegVersionText = r.status === 0 ? String(r.stdout) : null;
  }
  return ffmpegVersionText;
}

/**
 * ffmpeg を走らせ、標準エラー出力（音量の測定値など）を返す。失敗したら末尾の数行を添えて投げる。
 * @param {string[]} args
 * @returns {string}
 */
export function runFfmpeg(args) {
  const r = spawnSync(ffmpegPath(), ['-y', '-hide_banner', '-nostats', ...args], { encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true });
  if (r.status !== 0) throw new Error(`ffmpeg が失敗しました: ${String(r.stderr).split('\n').slice(-6).join('\n')}`);
  return String(r.stderr);
}

/**
 * 統合ラウドネス（LUFS）とトゥルーピーク（dBTP）を ebur128（ITU-R BS.1770、4 倍のオーバーサンプルで頂点を測る）で測る。
 * 音のミックス（mix.mjs）と完成版の点検（check.mjs）は、どちらもこれで測る（測り方をそろえ、合わせた音が点検で外れないように）。
 * loudnorm の測定より 10 倍ほど速い（5 分の音で 16 秒 → 1.3 秒）。値は loudnorm と 0.3 dB ほど違うことがある。
 * 無音（-70 LUFS 以下）なら i は NaN、頂点が無ければ tp は -Infinity。
 * @param {string} file
 * @returns {{i: number, tp: number}}
 */
export function measureLoudness(file) {
  const err = runFfmpeg(['-i', file, '-vn', '-af', 'ebur128=peak=true:metadata=1,ametadata=mode=print', '-f', 'null', '-']);
  const values = (re) => [...err.matchAll(re)].map((m) => Number(m[1]));
  // 統合ラウドネスは、最後のコマの値が全体の値
  const i = values(/lavfi\.r128\.I=(-?[\d.]+|-?inf)/g).at(-1);
  // チャンネルごとの頂点は、それまでの最大で出る。全部の最大を取る
  const peak = Math.max(...values(/lavfi\.r128\.true_peaks_ch\d+=([\d.]+)/g));
  return { i: Number.isFinite(i) && i > -70 ? i : NaN, tp: peak > 0 ? 20 * Math.log10(peak) : -Infinity };
}

/**
 * 道具置き場に chrome/ があれば、puppeteer のブラウザ本体をそこから使う（PUPPETEER_CACHE_DIR）。
 * 無ければ前の置き場（~/.cache/puppeteer）のまま。利用者が自分で決めた値は変えない。
 * @param {string} tools
 * @param {Record<string, string|undefined>} [env]
 */
export function useToolsChrome(tools, env = process.env) {
  const dir = path.join(tools, 'chrome');
  if (!env.PUPPETEER_CACHE_DIR && fs.existsSync(dir)) env.PUPPETEER_CACHE_DIR = dir;
}

/**
 * puppeteer が使うブラウザ本体（chrome-headless-shell。この版の puppeteer が決めた版）の実行ファイル。入っていなければ null。
 * 探す場所は描画のときと同じ順（利用者の PUPPETEER_CACHE_DIR、道具置き場の chrome/、前の置き場 ~/.cache/puppeteer）。
 * @param {string} tools
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null}
 */
export function browserExecutable(tools, env = process.env) {
  if (!hasPackage(tools, 'puppeteer')) return null;
  try {
    const req = createRequire(path.join(tools, 'package.json'));
    const browsers = req('@puppeteer/browsers');
    const { PUPPETEER_REVISIONS } = req('puppeteer-core/internal/revisions.js');
    const local = path.join(tools, 'chrome');
    const cacheDir = env.PUPPETEER_CACHE_DIR || (fs.existsSync(local) ? local : path.join(os.homedir(), '.cache', 'puppeteer'));
    const exe = browsers.computeExecutablePath({
      cacheDir, browser: 'chrome-headless-shell', buildId: PUPPETEER_REVISIONS['chrome-headless-shell'], platform: browsers.detectBrowserPlatform(),
    });
    return fs.existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

/** @returns {any} puppeteer */
export function loadPuppeteer() {
  const tools = toolsDir();
  if (!hasPackage(tools, 'puppeteer')) {
    console.error(`描画の道具（puppeteer）が入っていません。次を実行してください:\n  ${SETUP_COMMAND}`);
    process.exit(1);
  }
  useToolsChrome(tools);
  try {
    return createRequire(path.join(tools, 'package.json'))('puppeteer');
  } catch (e) {
    // 入っているのに読めない（壊れた導入など）。元のエラーを添える
    console.error(`描画の道具（puppeteer）を読めませんでした: ${e instanceof Error ? e.message : String(e)}\n入れ直すときは次を実行してください:\n  ${SETUP_COMMAND}`);
    process.exit(1);
  }
}
