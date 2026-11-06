// 同じ制作フォルダで書き出し・点検を重ねて走らせないための鍵と、途中の様子の記録（out/progress.log）。
// 書き出しは数分〜十数分かかるので、スキルはバックグラウンドで実行させ、様子はこの記録で見る。
import fs from 'node:fs';
import path from 'node:path';
import { removeFile } from './paths.mjs';

/** これより古い鍵は、残ったままの鍵とみなす（全品質の書き出しを比率4つで回しても、ここまではかからない） */
const STALE_MS = 6 * 3600e3;

export const lockFile = (projectDir) => path.join(projectDir, 'out', '.lock');
export const progressFile = (projectDir) => path.join(projectDir, 'out', 'progress.log');

/** out/progress.log に残す行の数（古い行から捨てる） */
const KEEP_LINES = 2000;

/** プロセスがまだ動いているか（権限が無くて確かめられないときは、動いているとみなす） */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * 鍵を取る。ほかの実行が動いていれば、何をいつ始めたかを添えて断る。
 * 鍵を残したまま終わった実行（プロセスがもう無い、6時間より古い、壊れている）の鍵は取り直す。
 * @param {string} projectDir
 * @param {string} label 何の実行か（render.mjs など）
 * @returns {() => void} 鍵を外す関数
 */
export function acquireLock(projectDir, label) {
  const file = lockFile(projectDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify({ pid: process.pid, label, startedAt: new Date().toISOString() });
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, body, { flag: 'wx' });
      return () => {
        try {
          if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) removeFile(file);
        } catch { /* もう無い */ }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let held = null;
    try { held = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { held = null; }
    const stale = !held || !Number.isInteger(held.pid) || !alive(held.pid) || !(Date.now() - Date.parse(held.startedAt) < STALE_MS);
    if (!stale) {
      // この文はモデルが読んで手当てする。利用者に見せる文ではないので、鍵や PID のことは利用者に伝えないよう添える（SKILL.md の「よくある間違い」）
      throw new Error(`同じ制作フォルダで ${held.label} が実行中です（PID ${held.pid}、${held.startedAt} に開始。途中の様子: ${progressFile(projectDir)}）。`
        + `自分で始めた実行がまだ動いているなら、終わりの知らせを待ってから実行してください。`
        + `動いていない（止めた・時間切れになった実行の残り）なら、${file} を消してから実行し直してください。`
        + 'どちらの場合も、この鍵のことは利用者に伝えなくてよい（待ち時間が延びるときだけ、その見込みを伝える）。');
    }
    removeFile(file);
  }
  throw new Error(`鍵を取れませんでした: ${file}`);
}

/**
 * 実行を始める。鍵を取り、out/progress.log を書き始め、プロセスが終わるときに終わりの行を足して鍵を外す。
 * @param {string} projectDir
 * @param {string} label
 * @returns {{log: (line: string) => void, end: (code?: number) => void}}
 */
export function beginRun(projectDir, label) {
  const release = acquireLock(projectDir, label);
  const file = progressFile(projectDir);
  const stamp = () => new Date().toLocaleTimeString('ja-JP', { hour12: false });
  const write = (line) => {
    try { fs.appendFileSync(file, `${stamp()} ${line}\n`); } catch { /* 記録できなくても実行は続ける */ }
  };
  // 前の実行の記録は消さずに残す（書き出しの後に音や点検を走らせても、書き出しの様子が読める）。長くなりすぎたら古い行から捨てる
  try {
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
    if (old.length > KEEP_LINES) fs.writeFileSync(file, old.slice(-KEEP_LINES).join('\n'));
    if (old.length > 1) fs.appendFileSync(file, '\n');
  } catch { /* 同上 */ }
  write(`${label} を始めました`);
  let ended = false;
  const end = (code = process.exitCode ?? 0) => {
    if (ended) return;
    ended = true;
    write(`終わりました（終了コード ${code}）`);
    release();
  };
  process.on('exit', (code) => end(code));
  return { log: write, end };
}
