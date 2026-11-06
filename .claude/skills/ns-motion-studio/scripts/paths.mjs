// 道具の置き場。利用者のホームの下に固定（プラグインのインストール先へは書き込まない）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * from を to に置き換える（rename）。Windows では、動画プレーヤー・エクスプローラーのプレビュー・OneDrive・ウイルス対策が
 * to を一時的に握ると EPERM・EBUSY・EACCES になるので、少しずつ長く待ってやり直す。それでも駄目なら、閉じてから再実行するよう日本語で伝える。
 * @param {string} from
 * @param {string} to
 * Windows のほかでは、権限の誤りはファイルを握られているせいではないので、やり直さずにそのまま投げる。
 * @param {{rename?: (from: string, to: string) => void, tries?: number, waitMs?: number, platform?: NodeJS.Platform}} [opts]
 */
export function replaceFile(from, to, { rename = fs.renameSync, tries = 6, waitMs = 500, platform = process.platform } = {}) {
  for (let i = 1; ; i++) {
    try {
      rename(from, to);
      return;
    } catch (e) {
      if (platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) throw e;
      if (i >= tries) {
        throw new Error(`${to} を置き換えられませんでした（ほかのソフトが開いているようです）。動画プレーヤーやエクスプローラーのプレビューで開いていれば閉じて、同じコマンドをもう一度実行してください。`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs * i);
    }
  }
}

// Windows では、日本語などを含むパスに fs.rmSync（ファイル1つでも）や fs.cpSync の recursive を使うと、Node ごと落ちる
// （rmSync は Node 24.13.1 より前の 24.x、cpSync は 24.15.0 より前と 22.23。nodejs/node#56049・#61108・#61950。エラーにもならない）。
// 制作フォルダは「制作 1」のような名前が普通なので、unlinkSync・rmdirSync を使い、フォルダは JS で1つずつたどって消す・写す。

/** ファイルを消す（無ければ何もしない）。fs.rmSync(file, {force: true}) の代わり */
export function removeFile(file) {
  try { fs.unlinkSync(file); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
}

/** フォルダを中身ごと消す（無ければ何もしない）。fs.rmSync(dir, {recursive: true, force: true}) の代わり */
export function removeTree(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
    if (e?.code === 'ENOENT') return;
    if (e?.code === 'ENOTDIR') return removeFile(dir);
    throw e;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) removeTree(p);
    else removeFile(p);
  }
  fs.rmdirSync(dir);
}

/** フォルダを中身ごと写す（to が無ければ作る）。fs.cpSync(from, to, {recursive: true}) の代わり */
export function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** 道具（puppeteer / ffmpeg-static / ffprobe-static）の置き場 */
export function toolsDir() {
  return path.join(os.homedir(), '.claude/ns-motion-studio/tools');
}

/** puppeteer のブラウザ本体の置き場（道具置き場の中。PUPPETEER_CACHE_DIR に渡す） */
export const chromeCacheDir = () => path.join(toolsDir(), 'chrome');

/**
 * このモジュールが node で直接実行されたか。シンボリックリンクやジャンクション越しに呼ばれても判定できるよう、
 * 両側を実体のパスへ解決して比べる（path.resolve だけだと false になり、CLI が何もせず exit 0 で終わる）。
 * @param {string} metaUrl 呼び出し側の import.meta.url
 */
export function isMain(metaUrl) {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return fs.realpathSync(path.resolve(arg)) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
