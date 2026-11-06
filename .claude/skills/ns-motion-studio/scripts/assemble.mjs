// 完成品の組み立て。シーンの MP4 をつなぎ（再エンコードしない）、音を足して out/ に書く。
// ポスターの静止画と、音なしのループ版もここで作る。出力は一時の名前に書き、終わってから名前を変える。
// コマンドで全品質（--preset final）を書き出すと、続けて全品質のコンタクトシートを撮り、完成版の点検（check.mjs --stage final）を通す。
// 終了コードは点検の結果（0: 問題なし、1: 問題あり、2: 止め時）。
import fs from 'node:fs';
import path from 'node:path';
import { loopVideoPath, printChecks, runChecks, videoPath } from './check.mjs';
import { contactSheet, stills } from './frames.mjs';
import { AAC_ARGS, mixAudio } from './mix.mjs';
import { isMain, removeFile, replaceFile } from './paths.mjs';
import { assertIntentScenes } from './project.mjs';
import { assertValidTimeline, readTimeline } from './timeline.mjs';
import { beginRun } from './lock.mjs';
import { checkArgs, exitCodeOf, progressPrinter, recordAssembleStats, renderAll } from './render.mjs';
import { runFfmpeg } from './tools.mjs';

const ffmpeg = (args) => runFfmpeg(['-loglevel', 'error', ...args]);

/** concat demuxer の一覧ファイルに書く 1 行（単一引用符はバックスラッシュで逃がす） */
const listLine = (f) => `file '${path.resolve(f).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;

/** シーンの MP4 を並べて、再エンコードせずにつなぐ（audio があれば AAC 192kbps で付ける）。一時の名前に書いて名前を変える */
function concat(files, out, audio) {
  const list = `${out}.list.txt`;
  const partial = `${out}.partial.mp4`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(list, files.map(listLine).join('\n') + '\n');
  try {
    const audioIn = audio ? ['-i', audio] : [];
    const audioOut = audio ? ['-map', '0:v:0', '-map', '1:a:0', ...AAC_ARGS] : ['-an'];
    ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, ...audioIn, '-c:v', 'copy', ...audioOut, '-movflags', '+faststart', '-f', 'mp4', partial]);
    replaceFile(partial, out);
  } finally {
    removeFile(list);
    removeFile(partial);
  }
}

/** 比率ごとのシーン MP4 を、timeline の並びで取り出す */
const sceneFiles = (tl, results, ratio) =>
  tl.scenes.map((s) => results.find((r) => r.ratio === ratio && r.sceneId === s.id).file);

/**
 * シーンを書き出し、音を混ぜ、比率ごとに 1 本の MP4 へつなぐ。
 * @param {string} projectDir
 * @param {{ratios?: string[], preset?: 'draft'|'final', onProgress?: Function}} [opts]
 * @returns {Promise<Array<{ratio: string, file: string, scenes: string[]}>>} scenes はつないだシーンの MP4（ループ版で使い回す）
 */
export async function assemble(projectDir, { ratios, preset = 'final', onProgress } = {}) {
  const tl = readTimeline(projectDir);
  const rs = ratios ?? tl.ratios;
  for (const r of rs) checkArgs(r, preset);
  const results = await renderAll(projectDir, { ratios: rs, preset, onProgress });
  const started = performance.now();
  const master = await mixAudio(projectDir);
  const out = rs.map((ratio) => {
    const file = videoPath(projectDir, tl, ratio, preset);
    const scenes = sceneFiles(tl, results, ratio);
    concat(scenes, file, master);
    return { ratio, file, scenes };
  });
  // 音をまとめてつなぐ時間を残す（次の見込みに使う）
  recordAssembleStats(projectDir, preset, (performance.now() - started) / 1000, tl.scenes.length ? tl.scenes[tl.scenes.length - 1].end : 0);
  return out;
}

/**
 * timeline.poster の時刻を全品質で撮り、out/<題名>_<比率>_poster.png に置く。
 * @param {string} projectDir
 * @param {string} ratio
 * @returns {Promise<string>}
 */
export async function poster(projectDir, ratio) {
  const tl = readTimeline(projectDir);
  if (typeof tl.poster !== 'number') throw new Error('timeline.json に poster（ポスターにする時刻）がありません。');
  checkArgs(ratio, 'final');
  const [shot] = await stills(projectDir, [tl.poster], { ratio, preset: 'final' });
  const out = videoPath(projectDir, tl, ratio, 'final').replace(/\.mp4$/, '_poster.png');
  const partial = `${out}.partial`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(shot, partial);
  replaceFile(partial, out);
  return out;
}

/**
 * loop が true のとき、音なしの _loop.mp4 を作る（全品質）。
 * @param {string} projectDir
 * @param {string} ratio
 * @param {{scenes?: string[]}} [opts] scenes を渡すと、そのシーンの MP4（final）をつなぐ。省くと書き出す（前回のまま使えるものは描き直さない）
 * @returns {Promise<string>}
 */
export async function loopVersion(projectDir, ratio, { scenes } = {}) {
  const tl = readTimeline(projectDir);
  if (!tl.loop) throw new Error('timeline.json の loop が true ではないので、ループ版は作りません。');
  checkArgs(ratio, 'final');
  const files = scenes ?? sceneFiles(tl, await renderAll(projectDir, { ratios: [ratio], preset: 'final' }), ratio);
  const out = loopVideoPath(projectDir, tl, ratio);
  concat(files, out, null);
  return out;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const projectDir = args[0];
  if (!projectDir || projectDir.startsWith('--')) {
    console.error('使い方: node assemble.mjs <制作フォルダ> [--preset draft|final] [--ratio 16:9]');
    process.exit(1);
  }
  const preset = opt('--preset') ?? 'final';
  const ratio = opt('--ratio');
  try {
    const tl = assertValidTimeline(projectDir);
    assertIntentScenes(projectDir, tl);
    const run = beginRun(projectDir, 'assemble.mjs');
    const outs = await assemble(projectDir, { ratios: ratio ? [ratio] : undefined, preset, onProgress: progressPrinter(run.log) });
    run.log('音をまとめて、つなぎました');
    for (const o of outs) {
      console.log(`${o.ratio}: ${o.file}`);
      if (preset === 'final') {
        console.log(`  ポスター: ${await poster(projectDir, o.ratio)}`);
        if (tl.loop) console.log(`  ループ版: ${await loopVersion(projectDir, o.ratio, { scenes: o.scenes })}`);
      }
    }
    // 全品質では、続けて全品質のコンタクトシートと完成版の点検まで通す（1回の書き出しが、点検の1回になる）
    if (preset === 'final') {
      run.log('コンタクトシートと完成版の点検');
      for (const f of await contactSheet(projectDir, { ratio, preset: 'final' })) console.log(`コンタクトシート: ${f}`);
      process.exitCode = printChecks(await runChecks(projectDir, { ratio, stage: 'final', log: run.log }), projectDir);
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(exitCodeOf(e));
  }
}
