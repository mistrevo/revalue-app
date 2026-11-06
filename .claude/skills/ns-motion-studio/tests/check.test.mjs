// 自動点検（check.mjs）を、わざと不具合を入れた fixture（broken）と正常な fixture（sample）で検証する。
// 完成版だけの点検（点滅・尺と解像度・音量・ループ）は、ffmpeg の lavfi で作った小さな MP4 で確かめる。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  applyIntents, applyWaivers, checkVideo, contrastRatio, determinismDiffs, flashes, readWaivers, recordRun, runChecks, SAFE_BOTTOM, safeAreaMessage,
  readIntentSeen, stopAdvice, stopRule, timelineFindings, veiled, videoPath, waive,
} from '../scripts/check.mjs';
import { logFeedback } from '../scripts/feedback.mjs';
import { copyTree, removeTree, toolsDir } from '../scripts/paths.mjs';
import { approveGate } from '../scripts/project.mjs';
import { openPage, SEAM_X264_PARAMS } from '../scripts/render.mjs';
import { bundledBinary, defaultExec, hasPackage, loadPuppeteer } from '../scripts/tools.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const SAMPLE = path.join(FIXTURES, 'sample');
const BROKEN = path.join(FIXTURES, 'broken');
const CHECK = fileURLToPath(new URL('../scripts/check.mjs', import.meta.url));
const FFMPEG = defaultExec('ffmpeg -version') !== null ? 'ffmpeg' : bundledBinary(toolsDir(), 'ffmpeg-static');
const HAS_FFMPEG = FFMPEG !== null
  && (defaultExec('ffprobe -version') !== null || bundledBinary(toolsDir(), 'ffprobe-static') !== null);
const HAS_TOOLS = HAS_FFMPEG && hasPackage(toolsDir(), 'puppeteer');

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

/** fixture を、日本語と空白を含む名前の一時フォルダへ複製する */
function copyFixture(src) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsms 点検-'));
  copyTree(src, dir);
  dirs.push(dir);
  return dir;
}

const readTl = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8'));

function toolTest(name, fn, need = HAS_TOOLS) {
  test(name, async (t) => {
    if (!need) return t.skip('道具が未導入');
    await fn(t);
  });
}

/** ffmpeg で動画を作る（lavfi の入力と出力の引数をそのまま渡す） */
function ffmpeg(args) {
  const r = spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

/** 1920×1080・30fps・尺 seconds の MP4。vf は映像に足すフィルター、audio は音の lavfi（無ければ無音のトラックも付けない） */
function makeVideo(file, { seconds = 3, size = '1920x1080', fps = 30, vf, audio, base, final = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const args = ['-f', 'lavfi', '-i', `${base ?? `color=c=black:s=${size}:r=${fps}:d=${seconds}`}${vf ? `,${vf}` : ''}`];
  if (audio) args.push('-f', 'lavfi', '-i', audio);
  // final は書き出しの最終品質（crf 18・medium）と同じ設定で圧縮する
  args.push('-c:v', 'libx264', ...(final ? ['-preset', 'medium', '-crf', '18'] : ['-preset', 'ultrafast']), '-pix_fmt', 'yuv420p');
  if (audio) args.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
  args.push(file);
  ffmpeg(args);
  return file;
}

/** 統合ラウドネスがほぼ -14 LUFS になる正弦波（一度測ってから音量を合わせる） */
function sineAt14(seconds) {
  const base = `sine=frequency=1000:sample_rate=48000:duration=${seconds}`;
  // 点検と同じ測り方（ebur128）で測る
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-f', 'lavfi', '-i', base, '-af', 'ebur128=metadata=1,ametadata=mode=print', '-f', 'null', '-'], { encoding: 'utf8' });
  const measured = Number([...r.stderr.matchAll(/lavfi\.r128\.I=(-?[\d.]+)/g)].at(-1)[1]);
  return `${base},volume=${(-14 - measured).toFixed(2)}dB`;
}

const tmpFile = (name) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsms 点検 動画-'));
  dirs.push(dir);
  return path.join(dir, name);
};

// ---- 道具の要らない計算 ----

test('contrastRatio は WCAG の式で求める', () => {
  assert.equal(Math.round(contrastRatio([255, 255, 255], [0, 0, 0]) * 10) / 10, 21);
  assert.equal(contrastRatio([0, 0, 0], [255, 255, 255]), contrastRatio([255, 255, 255], [0, 0, 0]));
  const gray = contrastRatio([0x88, 0x88, 0x88], [0x77, 0x77, 0x77]);
  assert.ok(gray > 1 && gray < 1.5, String(gray));
});

test('flashes は、明るさが 20% を超えて往復した回数を 1 秒の窓で数える', () => {
  const fps = 30;
  // 0.1 秒ごとに白黒が入れ替わる（毎秒 5 回の点滅）
  const fast = Array.from({ length: 90 }, (_, i) => (Math.floor(i / 3) % 2 ? 235 : 16));
  const hits = flashes(fast, fps);
  assert.ok(hits.length >= 1);
  assert.ok(hits[0].count > 3);
  assert.equal(hits[0].frame, 3);
  // 0.5 秒ごと（毎秒 1 回）なら引っかからない
  const slow = Array.from({ length: 90 }, (_, i) => (Math.floor(i / 15) % 2 ? 235 : 16));
  assert.deepEqual(flashes(slow, fps), []);
  // 20% に満たない揺れは数えない
  const small = Array.from({ length: 90 }, (_, i) => (i % 2 ? 100 : 140));
  assert.deepEqual(flashes(small, fps), []);
  // ゆっくり明るくなるだけなら数えない
  assert.deepEqual(flashes(Array.from({ length: 90 }, (_, i) => i * 2.5), fps), []);
});

test('timelineFindings: 表示時間の不足は hold、声の重なりは narration として、カット番号と時刻つきで返す', () => {
  const tl = JSON.parse(fs.readFileSync(path.join(SAMPLE, 'timeline.json'), 'utf8'));
  assert.deepEqual(timelineFindings(tl), []);
  const sc = tl.scenes[1];
  tl.narration = [
    { id: 'n01', scene: tl.scenes[0].id, text: 'いち', start: sc.start - 0.2, audio: 'audio/narration/n01.wav', duration: 1.0 },
    { id: 'n02', scene: sc.id, text: 'に', start: sc.start + 0.3, audio: 'audio/narration/n02.wav', duration: 0.3 },
  ];
  const f = timelineFindings(tl);
  assert.equal(f.length, 1);
  assert.equal(f[0].check, 'narration');
  assert.equal(f[0].cut, 2); // 重なりの起きる n02 のカット
  assert.equal(f[0].t, sc.start + 0.3);
  assert.equal(f[0].evidence, 'n01,n02');
  assert.match(f[0].message, new RegExp(`^カット2（\\d+:\\d\\d\\.\\d）: .*n01.*n02.*声が重なります`), f[0].message);
  // 字幕の不足で、ナレーションに合わせれば短くてよいときは、その時刻も添える
  tl.narration = [{ id: 'n03', scene: sc.id, text: 'キャッシュの鍵にします。', start: sc.start, audio: 'audio/narration/n03.wav', duration: 1.0 }];
  tl.texts.push({ id: 'tx', scene: sc.id, kind: 'subtitle', text: 'キャッシュの鍵にします。', start: sc.start, end: sc.start + 1.2 });
  const h = timelineFindings(tl);
  assert.deepEqual(h.map((x) => x.check), ['hold']);
  assert.match(h[0].message, /ナレーション n03 と同じ文/);
});

test('safeAreaMessage: 下の帯は比率ごと。16:9・1:1・4:5 は下 10% が字幕の帯、9:16 は下 20% に SNS のボタンが重なり、字幕の帯はその上', () => {
  assert.deepEqual(Object.keys(SAFE_BOTTOM).sort(), ['16:9', '1:1', '4:5', '9:16']);
  // 16:9（高さ 1080）: 下 10%（972px より下）に字幕のほかの文字を入れない。字幕は入ってよい
  for (const kind of ['title', 'label', 'caption']) assert.match(safeAreaMessage(kind, 1000, '16:9'), /下 10% の字幕用の場所/, kind);
  assert.equal(safeAreaMessage('title', 972, '16:9'), null);
  assert.equal(safeAreaMessage('subtitle', 1070, '16:9'), null);
  // 1:1 と 4:5 も下 10%
  assert.match(safeAreaMessage('title', 1000, '1:1'), /下 10%/);
  assert.equal(safeAreaMessage('title', 1200, '4:5'), null);
  assert.match(safeAreaMessage('title', 1250, '4:5'), /下 10%/);
  // 9:16（高さ 1920）: 下 20%（1536px より下）は、字幕も含めてどの文字も入れない
  for (const kind of ['title', 'label', 'caption', 'subtitle']) assert.match(safeAreaMessage(kind, 1900, '9:16'), /下 20%.*SNS/, kind);
  assert.match(safeAreaMessage('subtitle', 1900, '9:16'), /字幕は.*下から 20〜30%/);
  // 字幕の帯（下から 20〜30%、1344〜1536px）は字幕だけ
  assert.equal(safeAreaMessage('subtitle', 1530, '9:16'), null);
  assert.match(safeAreaMessage('title', 1500, '9:16'), /下から 20〜30% の字幕用の場所/);
  assert.equal(safeAreaMessage('title', 1340, '9:16'), null);
});

// ---- 止め時と例外 ----

const run = (stage, keys, at) => ({ at, stage, keys });

test('stopRule: 同じ指摘が3回続けて残れば（2回直しても残れば）止める。毎回違う指摘なら3回では止めず、5回続けて不合格なら止める', () => {
  const t = (s) => `2026-10-22T00:00:${String(s).padStart(2, '0')}.000Z`;
  // 同じ指摘 a が3回続けて残る
  assert.deepEqual(stopRule([run('build', ['a', 'b'], t(1)), run('build', ['a'], t(2)), run('build', ['a', 'c'], t(3))], 'build', 0),
    { kind: 'persistent', keys: ['a'] });
  // 毎回違う指摘（直すたびに進んでいる）なら、3回でも止めない
  const moving = [run('build', ['a'], t(1)), run('build', ['b'], t(2)), run('build', ['c'], t(3))];
  assert.equal(stopRule(moving, 'build', 0), null);
  assert.equal(stopRule([...moving, run('build', ['d'], t(4))], 'build', 0), null);
  // 5回続けて不合格なら、指摘が違っても止める（今の指摘を返す）
  assert.deepEqual(stopRule([...moving, run('build', ['d'], t(4)), run('build', ['e'], t(5))], 'build', 0), { kind: 'many', keys: ['e'] });
  // 合格した回で数え直す
  assert.equal(stopRule([run('build', ['a'], t(1)), run('build', ['a'], t(2)), run('build', [], t(3)), run('build', ['a'], t(4))], 'build', 0), null);
  // 段階ごとに数える（final の回は build に数えない）。final も同じ数え方
  assert.equal(stopRule([run('build', ['a'], t(1)), run('final', ['a'], t(2)), run('build', ['a'], t(3))], 'build', 0), null);
  assert.deepEqual(stopRule([run('final', ['m'], t(1)), run('final', ['m'], t(2)), run('final', ['m'], t(3))], 'final', 0).kind, 'persistent');
  // 数え直しの時刻より前の回は数えない
  assert.equal(stopRule([run('build', ['a'], t(1)), run('build', ['a'], t(2)), run('build', ['a'], t(3))], 'build', Date.parse(t(1))), null);
});

/** 一時の制作フォルダ（見本の timeline と project.json） */
function tmpProjectDir() {
  const dir = copyFixture(SAMPLE);
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ title: '見本', gates: {} }));
  return dir;
}

const finding = (id, extra = {}) => ({ check: 'contrast', cut: 1, t: 0.5, message: `カット1（0:00.5）: ${id}`, evidence: `証拠 ${id}`, id, ratio: '16:9', ...extra });

test('stopRule: 比率ごとに数え、ある比率だけを点検して通った回では、ほかの比率の続きを切らない', () => {
  const t = (s) => `2026-10-22T00:00:${String(s).padStart(2, '0')}.000Z`;
  const both = ['16:9', '9:16'];
  const runs = [
    { at: t(1), stage: 'build', ratios: both, keys: ['9:16|x'] },
    { at: t(2), stage: 'build', ratios: both, keys: ['9:16|x'] },
    { at: t(3), stage: 'build', ratios: ['16:9'], keys: [] },
    { at: t(4), stage: 'build', ratios: both, keys: ['9:16|x', '|hold|t01'] },
  ];
  assert.deepEqual(stopRule(runs, 'build', 0), { kind: 'persistent', keys: ['9:16|x'] });
  // その比率が通れば数え直す
  assert.equal(stopRule([...runs.slice(0, 2), { at: t(3), stage: 'build', ratios: both, keys: [] }, runs[3]], 'build', 0), null);
  // 比率の無い指摘（表示時間など）は、どの比率にも数える
  const hold = [1, 2, 3].map((s) => ({ at: t(s), stage: 'build', ratios: ['16:9'], keys: ['|hold|t01'] }));
  assert.deepEqual(stopRule(hold, 'build', 0), { kind: 'persistent', keys: ['|hold|t01'] });
});

test('recordRun: check-runs.json には最後の 50 回だけを残す', () => {
  const dir = tmpProjectDir();
  for (let i = 0; i < 55; i++) recordRun(dir, 'build', [], ['16:9'], new Date(Date.now() - 100000 + i).toISOString());
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'reviews/check-runs.json'), 'utf8')).runs.length, 50);
});

test('stopAdvice: 指摘の記録と関門の承認で数え直す。例外では数え直さない（例外にした指摘は次の回から数えない）', () => {
  const dir = tmpProjectDir();
  const past = (s) => new Date(Date.now() - 60000 + s * 1000).toISOString();
  const three = () => { for (let i = 0; i < 3; i++) recordRun(dir, 'build', [finding('a')], ['16:9'], past(i)); };
  three();
  assert.equal(stopAdvice(dir, 'build').kind, 'persistent');
  logFeedback(dir, [{ cut: null, text: '自動点検の指摘を、このまま直し続けて' }], 'rough');
  assert.equal(stopAdvice(dir, 'build'), null);
  recordRun(dir, 'build', [finding('a')], ['16:9'], new Date(Date.now() + 1000).toISOString());
  assert.equal(stopAdvice(dir, 'build'), null, '数え直したあとの1回だけでは止めない');

  const d2 = tmpProjectDir();
  for (let i = 0; i < 3; i++) recordRun(d2, 'build', [finding('a')], ['16:9'], past(i));
  approveGate(d2, 'rough');
  assert.equal(stopAdvice(d2, 'build'), null);

  const d3 = tmpProjectDir();
  for (let i = 0; i < 3; i++) recordRun(d3, 'build', [finding('a'), finding('b')], ['16:9'], past(i));
  waive(d3, [2], '画像で見ると、文字は飾りの帯の上で読める');
  assert.deepEqual(stopAdvice(d3, 'build'), { kind: 'persistent', keys: ['16:9|a', '16:9|b'] });
  // 例外にした b は次の回から数えないが、a は続けて数える
  recordRun(d3, 'build', applyWaivers([finding('a'), finding('b')], readWaivers(d3)), ['16:9']);
  assert.deepEqual(stopAdvice(d3, 'build'), { kind: 'persistent', keys: ['16:9|a'] });
});

test('例外の鍵: 証拠が変わらない点検（点滅・決定論・原稿との食い違い・MP4）は文も鍵に入れ、文が変われば例外でない', () => {
  const dir = tmpProjectDir();
  const mismatch = finding('text-mismatch|2|t03', { check: 'text-mismatch', cut: 2, message: 'カット2（0:01.6）: 画面の文字「始めよ」が原稿と違います。', evidence: 't03' });
  recordRun(dir, 'build', [mismatch], ['16:9']);
  waive(dir, [1], '原稿の直し待ち');
  assert.equal(applyWaivers([mismatch], readWaivers(dir))[0].waived, true);
  const other = { ...mismatch, message: 'カット2（0:01.6）: 画面の文字「始めます」が原稿と違います。' };
  assert.equal(applyWaivers([other], readWaivers(dir))[0].waived, undefined);
  // 証拠が中身で変わる点検（コントラストなど）は、文が変わっても証拠が同じなら例外のまま
  const d2 = tmpProjectDir();
  recordRun(d2, 'build', [finding('c')], ['16:9']);
  waive(d2, [1], '読める');
  assert.equal(applyWaivers([finding('c', { message: 'カット1（0:00.6）: c' })], readWaivers(d2))[0].waived, true);
});

test('waive: 最後の点検の番号の指摘を、理由と一緒に例外にする。例外の指摘は ok と止め時に数えず、証拠が変われば例外でなくなる', () => {
  const dir = tmpProjectDir();
  recordRun(dir, 'build', [finding('a'), finding('b')]);
  assert.throws(() => waive(dir, [1], ' '), /--why/);
  assert.throws(() => waive(dir, [3], '理由'), /番号 3/);
  const [w] = waive(dir, [2], '画像で見ると読める');
  assert.equal(w.why, '画像で見ると読める');
  assert.equal(w.ratio, '16:9');
  assert.equal(w.check, 'contrast');
  assert.deepEqual(readWaivers(dir).map((x) => x.message), ['カット1（0:00.5）: b']);
  const [a, b, changed] = applyWaivers([finding('a'), finding('b'), finding('b', { evidence: '別の証拠' })], readWaivers(dir));
  assert.equal(a.waived, undefined);
  assert.equal(b.waived, true);
  assert.equal(b.why, '画像で見ると読める');
  assert.equal(changed.waived, undefined, '証拠が変わったら例外でない');
  // 比率が違えば例外でない
  assert.equal(applyWaivers([finding('b', { ratio: '9:16' })], readWaivers(dir))[0].waived, undefined);
  // 例外の指摘だけの回は合格として記録する
  recordRun(dir, 'build', [{ ...finding('b'), waived: true }]);
  const runs = JSON.parse(fs.readFileSync(path.join(dir, 'reviews/check-runs.json'), 'utf8')).runs;
  assert.deepEqual(runs.at(-1).keys, []);
});

test('videoPath は out/<題名>_<比率>[_draft].mp4', () => {
  const tl = { title: '見本' };
  assert.equal(videoPath('/p', tl, '16:9', 'final'), path.join('/p', 'out', '見本_16x9.mp4'));
  assert.equal(videoPath('/p', tl, '9:16', 'draft'), path.join('/p', 'out', '見本_9x16_draft.mp4'));
  assert.equal(videoPath('/p', { title: 'a/b:c' }, '1:1', 'final'), path.join('/p', 'out', 'a_b_c_1x1.mp4'));
});

// ---- シーンの点検（ブラウザ） ----

toolTest('正常な見本は build の点検を通り、結果を reviews に保存する', async () => {
  const dir = copyFixture(SAMPLE);
  const r = await runChecks(dir, { ratio: '16:9', stage: 'build', browser });
  assert.deepEqual(r.findings, []);
  assert.equal(r.ok, true);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'reviews/checks-build-16x9.json'), 'utf8'));
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.findings, []);
});

toolTest('比率を指定しなければ、timeline のすべての比率を点検し、比率ごとに結果を保存する（指摘には比率が付く）', async () => {
  const dir = copyFixture(SAMPLE);
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify({ ...readTl(dir), ratios: ['16:9', '1:1'] }, null, 2));
  // 1:1 のカット2 の見出しだけ、画面の外へ出す
  const s02 = path.join(dir, 'src/scenes/s02.html');
  fs.writeFileSync(s02, fs.readFileSync(s02, 'utf8').replace('</style>', '@media (aspect-ratio: 1/1) { .title { left: 1200px !important; } }</style>'));
  const r = await runChecks(dir, { stage: 'build', browser });
  assert.ok(fs.existsSync(path.join(dir, 'reviews/checks-build-16x9.json')));
  assert.ok(fs.existsSync(path.join(dir, 'reviews/checks-build-1x1.json')));
  assert.ok(r.findings.length > 0, JSON.stringify(r.findings));
  assert.ok(r.findings.every((f) => f.ratio === '1:1' && f.cut === 2), JSON.stringify(r.findings));
});

toolTest('壊したシーンは、それぞれ対応する点検だけに引っかかる', async () => {
  const dir = copyFixture(BROKEN);
  const r = await runChecks(dir, { ratio: '16:9', stage: 'build', browser });
  assert.equal(r.ok, false);
  const expected = {
    1: ['overflow'],
    2: ['overlap'],
    3: ['text-mismatch'],
    4: ['contrast'],
    5: ['hold'],
    6: ['determinism'],
    7: ['script-error'],
    8: ['safe-area'],
    9: ['hardcoded-text'],
    10: ['overflow'],
  };
  const byCut = {};
  for (const f of r.findings) (byCut[f.cut] ??= new Set()).add(f.check);
  for (const [cut, checks] of Object.entries(expected)) {
    assert.deepEqual([...(byCut[cut] ?? [])].sort(), checks, `カット${cut}: ${JSON.stringify(r.findings.filter((f) => f.cut === Number(cut)))}`);
  }
  for (const f of r.findings) {
    // 利用者に見せる文: 日本語で、カット番号と時刻を含む
    assert.match(f.message, new RegExp(`^カット${f.cut}（\\d+:\\d\\d\\.\\d）`), f.message);
    assert.ok(Number.isFinite(f.t));
  }
  // 字幕（subtitle）は下 10% にあっても引っかからない
  const safe = r.findings.filter((f) => f.check === 'safe-area');
  assert.equal(safe.length, 1);
  assert.match(safe[0].message, /下の端/);
  // 時刻は動画の先頭から（カット5 のテロップは 6.2 秒から）
  assert.equal(r.findings.find((f) => f.check === 'hold').t, 6.2);
  const mismatch = r.findings.find((f) => f.check === 'text-mismatch');
  assert.match(mismatch.message, /違う字/);
  assert.match(mismatch.message, /正しい/);
  assert.match(r.findings.find((f) => f.check === 'hardcoded-text').message, /直書き/);
  assert.match(r.findings.find((f) => f.check === 'script-error').message, /わざと投げた例外/);
  // 同じ文字の同じ不具合は、時刻ごとに何件も出さない
  assert.equal(r.findings.filter((f) => f.check === 'overflow' && f.cut === 1).length, 1);
  // 画面の外に丸ごと置いた文字は、一度も表示されていないと指摘する
  const off = r.findings.find((f) => f.cut === 10);
  assert.match(off.message, /t12「外です」が画面に一度も表示されていません/);
  assert.equal(off.t, 13.6);
});

toolTest('9:16 は下 20% に字幕も入れず、字幕の帯はその上（下から 20〜30%）', async () => {
  const dir = copyFixture(BROKEN);
  const tl = readTl(dir);
  const scene = (titleBottom, subtitleBottom) => `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
  body { background: #111827; color: #ffffff; font-family: system-ui, sans-serif; }
  .t { position: absolute; left: 100px; margin: 0; font-size: 64px; font-weight: 700; white-space: nowrap; }
  .a { bottom: ${titleBottom}px; }
  .b { bottom: ${subtitleBottom}px; }
</style></head><body>
  <p class="t a" data-ms-text="t09"></p>
  <p class="t b" data-ms-text="t10"></p>
<script>ms.scene(() => {});</script>
</body></html>`;
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify({
    ...tl, ratios: ['9:16'],
    scenes: [{ ...tl.scenes[7], start: 0, end: 1.5 }],
    texts: tl.texts.filter((x) => x.scene === 'b08').map((x) => ({ ...x, start: 0.1, end: 1.4 })),
  }, null, 2));
  const file = path.join(dir, 'src/scenes/safe-area.html');
  // 見出しは字幕の帯（下から 20〜30%）、字幕は SNS のボタンが重なる下 20% に置く
  fs.writeFileSync(file, scene(420, 40));
  const r = await runChecks(dir, { ratio: '9:16', stage: 'build', browser });
  assert.deepEqual(r.findings.map((f) => f.check), ['safe-area', 'safe-area'], JSON.stringify(r.findings));
  assert.ok(r.findings.some((f) => /下の端/.test(f.message) && /下から 20〜30% の字幕用の場所/.test(f.message)));
  assert.ok(r.findings.some((f) => /字幕だ/.test(f.message) && /下 20%.*SNS/.test(f.message)));
  // 見出しを帯より上に、字幕を帯の中に置けば通る
  fs.writeFileSync(file, scene(700, 420));
  assert.deepEqual((await runChecks(dir, { ratio: '9:16', stage: 'build', browser })).findings, []);
});

toolTest('static の箱から出る文字の重なりと、画面の端や小さな箱で切れたままの文字を指摘する', async () => {
  // runtime-cases のカット c06 だけを、0 秒から始まる timeline にして点検する
  const dir = copyFixture(path.join(FIXTURES, 'runtime-cases'));
  const tl = readTl(dir);
  const scene = tl.scenes.find((x) => x.id === 'c06');
  const shift = scene.start;
  tl.scenes = [{ ...scene, start: 0, end: scene.end - shift }];
  tl.texts = tl.texts.filter((x) => x.scene === 'c06').map((x) => ({ ...x, start: x.start - shift, end: x.end - shift }));
  tl.poster = 0.5;
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(tl, null, 2));
  const r = await runChecks(dir, { ratio: '16:9', stage: 'build', browser });
  const f = r.findings;
  const about = (id) => f.filter((x) => x.message.includes(tl.texts.find((y) => y.id === id).text));
  // static の箱の中の absolute の文字（t07）は、箱に切られずに t08 と重なって見える
  assert.ok(f.some((x) => x.check === 'overlap' && /箱の外へ/.test(x.message) && /同じ場所/.test(x.message)), JSON.stringify(f));
  // fixed の文字（t09）は見えている（一度も表示されていない、とは言わない）
  assert.deepEqual(about('t09'), []);
  // 舞台の箱（overflow: hidden）があっても、画面の右の端で切れる文字は、はみ出しとして指摘する
  assert.ok(about('t10').some((x) => x.check === 'overflow' && /画面の外にはみ出しています/.test(x.message)), JSON.stringify(f));
  // 小さな箱で切れたままの文字も、はみ出しとして指摘する
  assert.ok(about('t11').some((x) => x.check === 'overflow' && /隠れたまま/.test(x.message)), JSON.stringify(f));
  assert.equal(f.filter((x) => x.check === 'overflow').length, 2, JSON.stringify(f));
});

toolTest('行の高さぴったりのマスクと data-ms-scroll の中の流れる文字は指摘せず、省略記号で切った文字は指摘する', async (t) => {
  const dir = copyFixture(path.join(FIXTURES, 'runtime-cases'));
  const tl = readTl(dir);
  const scene = tl.scenes.find((x) => x.id === 'c07');
  const shift = scene.start;
  tl.scenes = [{ ...scene, start: 0, end: scene.end - shift }];
  tl.texts = tl.texts.filter((x) => x.scene === 'c07').map((x) => ({ ...x, start: x.start - shift, end: x.end - shift }));
  tl.poster = 0.5;
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(tl, null, 2));
  const r = await runChecks(dir, { ratio: '16:9', stage: 'build', browser });
  if (r.findings.some((x) => x.check === 'script-error' && /Noto Sans JP/.test(x.message))) return t.skip('Noto Sans JP が未導入');
  const overflow = r.findings.filter((x) => x.check === 'overflow');
  assert.equal(overflow.length, 1, JSON.stringify(r.findings));
  assert.match(overflow[0].message, /t15「省略記号で切れた文字」の一部が、表示のあいだずっと隠れたまま/);
  assert.deepEqual(r.findings.filter((x) => x.check !== 'overflow'), [], JSON.stringify(r.findings));
});

toolTest('背景の箱からはみ出したままのテロップは指摘し、収まる文字・飾りの形より大きい文字・入場の途中のはみ出しは指摘しない', async () => {
  const dir = copyFixture(path.join(FIXTURES, 'runtime-cases'));
  const tl = readTl(dir);
  const scene = tl.scenes.find((x) => x.id === 'c08');
  const shift = scene.start;
  tl.scenes = [{ ...scene, start: 0, end: scene.end - shift }];
  tl.texts = tl.texts.filter((x) => x.scene === 'c08').map((x) => ({ ...x, start: x.start - shift, end: x.end - shift }));
  tl.poster = 0.5;
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(tl, null, 2));
  const r = await runChecks(dir, { ratio: '16:9', stage: 'build', browser });
  const overflow = r.findings.filter((x) => x.check === 'overflow');
  // t16（行より長い）と t20（拭き取りで出し終えると枠からはみ出す）だけ。t17・t18・t19（滑り込みの途中だけ箱の外）・t21（static の札の外に置いた absolute）は問わない
  assert.deepEqual(overflow.map((x) => /テロップ (t\d+)/.exec(x.message)?.[1]).sort(), ['t16', 't20'], JSON.stringify(r.findings));
  assert.match(overflow.find((x) => x.message.includes('t16')).message,
    /^カット1（0:00\.0）: テロップ t16「背景の箱からはみ出す長いテロップ」が、表示のあいだずっと、背景の箱からはみ出しています/);
  assert.deepEqual(r.findings.filter((x) => x.check !== 'overflow'), [], JSON.stringify(r.findings));
});

toolTest('行の高さ normal で字面の箱より低い札は、はみ出しにも切れたままにもしない', async (t) => {
  const dir = copyFixture(path.join(FIXTURES, 'runtime-cases'));
  const tl = readTl(dir);
  const scene = tl.scenes.find((x) => x.id === 'c09');
  const shift = scene.start;
  tl.scenes = [{ ...scene, start: 0, end: scene.end - shift }];
  tl.texts = tl.texts.filter((x) => x.scene === 'c09').map((x) => ({ ...x, start: x.start - shift, end: x.end - shift }));
  tl.poster = 0.5;
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(tl, null, 2));
  const r = await runChecks(dir, { ratio: '16:9', stage: 'build', browser });
  if (r.findings.some((x) => x.check === 'script-error' && /Noto Sans JP/.test(x.message))) return t.skip('Noto Sans JP が未導入');
  assert.deepEqual(r.findings, [], JSON.stringify(r.findings));
});

toolTest('文字の上に半透明の面を重ねたときは、面を重ねた文字の色で地と比べ、表示のあいだずっと不透明な板の下に隠れた文字は一度も表示されていないとし、一部の時間だけ隠れた文字は問わない', async () => {
  const dir = copyFixture(path.join(FIXTURES, 'runtime-cases'));
  const tl = readTl(dir);
  const scene = tl.scenes.find((x) => x.id === 'c10');
  const shift = scene.start;
  tl.scenes = [{ ...scene, start: 0, end: scene.end - shift }];
  tl.texts = tl.texts.filter((x) => x.scene === 'c10').map((x) => ({ ...x, start: x.start - shift, end: x.end - shift }));
  tl.poster = 0.5;
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(tl, null, 2));
  const r = await runChecks(dir, { ratio: '16:9', stage: 'build', browser });
  // t24 は CSS の色（#1d1d1f）なら白く飛んだ地とも差があるが、70% の白い面の下では薄く見える。t25（穴の中）は通る。
  // t26 は表示のあいだずっと不透明な板の下にあって見えないので、読みにくさは問わず、一度も表示されていないとする。t27（最初の 1 秒だけ板の下）は通る
  assert.deepEqual(r.findings.map((x) => [x.check, /「(.+?)」/.exec(x.message)?.[1]]), [['contrast', '面の下の文字'], ['overflow', '板の下']], JSON.stringify(r.findings));
  assert.match(r.findings[1].message, /t26「板の下」が画面に一度も表示されていません/);
  assert.match(r.findings[0].evidence, /重なった面を足すと rgb\(/);
});

toolTest('表示の一部の時間だけ不透明な板の下に隠れた文字は、何も指摘しない', async () => {
  const dir = copyFixture(path.join(FIXTURES, 'runtime-cases'));
  const tl = readTl(dir);
  const scene = tl.scenes.find((x) => x.id === 'c10');
  const shift = scene.start;
  tl.scenes = [{ ...scene, start: 0, end: scene.end - shift }];
  // t27 は最初の 1 秒だけ板の下にあり、そのあと見える（ほかの文字は原稿から外し、画面からも消す）
  tl.texts = tl.texts.filter((x) => x.id === 't27').map((x) => ({ ...x, start: x.start - shift, end: x.end - shift }));
  tl.poster = 0.5;
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(tl, null, 2));
  const html = path.join(dir, 'src', 'scenes', 'veil.html');
  fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replace(/<div class="(under|lit|hidden)" data-ms-text="t2[456]"><\/div>/g, ''));
  const r = await runChecks(dir, { ratio: '16:9', stage: 'build', browser });
  assert.deepEqual(r.findings, [], JSON.stringify(r.findings));
});

/** runtime-cases のカット id だけを、0 秒から始まる timeline にした制作フォルダ */
function onlyCase(id) {
  const dir = copyFixture(path.join(FIXTURES, 'runtime-cases'));
  const tl = readTl(dir);
  const scene = tl.scenes.find((x) => x.id === id);
  const shift = scene.start;
  tl.scenes = [{ ...scene, start: 0, end: scene.end - shift }];
  tl.texts = tl.texts.filter((x) => x.scene === id).map((x) => ({ ...x, start: x.start - shift, end: x.end - shift }));
  tl.poster = 0.5;
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(tl, null, 2));
  return dir;
}

toolTest('語ごとの span に分けて透明から現れる見出しでも、札で切れたままの行は指摘し、札に収まる見出しは指摘しない', async () => {
  const r = await runChecks(onlyCase('c11'), { ratio: '16:9', stage: 'build', browser });
  // t28（語ごとに現れる。3行目が札で切れたまま）と t29（同じ見出しを動かさずに置いた）だけ。t30（2行で札に収まる）は問わない
  assert.deepEqual(r.findings.map((x) => [x.check, /テロップ (t\d+)/.exec(x.message)?.[1]]).sort(), [['overflow', 't28'], ['overflow', 't29']], JSON.stringify(r.findings));
  for (const f of r.findings) assert.match(f.message, /表示のあいだずっと隠れたまま/);
});

toolTest('文字の上に形が重なり続けるときは cover として指摘し、文字の後ろを通る形・一瞬で横切る形・data-ms-wipe の面は指摘しない', async () => {
  const r = await runChecks(onlyCase('c12'), { ratio: '16:9', stage: 'build', browser });
  assert.deepEqual(r.findings.map((x) => x.check), ['cover'], JSON.stringify(r.findings));
  const [f] = r.findings;
  assert.equal(f.id, 'cover|1|t31');
  assert.equal(f.t, 0);
  assert.match(f.message, /^カット1（0:00\.0）: 文字「Covered title」の上に、形（div\.sh\.sq）が重なっています/);
  assert.match(f.message, /data-ms-wipe/);
  assert.match(f.evidence, /隠れた割合 \d+%/);
});

toolTest('cover は字の帯で見る: 行の下の余白の下線と、乗算で重ねた帯は指摘せず、oklch() と color-mix() の色の形は指摘する', async () => {
  const r = await runChecks(onlyCase('c14'), { ratio: '16:9', stage: 'build', browser });
  assert.deepEqual(r.findings.map((x) => x.id).sort(), ['cover|1|t38', 'cover|1|t39'], JSON.stringify(r.findings));
});

toolTest('カットの最初のコマだけが背景だけ（前のカットの最後と2コマ目には絵がある）なら blank として指摘し、最初のコマから絵があるとき・何も無い地からのふつうの入場（フェード、拭き取り）・動画の最初のカットは指摘しない', async () => {
  const dir = copyFixture(path.join(FIXTURES, 'runtime-cases'));
  const tl = readTl(dir);
  const ids = ['c12', 'c13'];
  const shift = tl.scenes.find((x) => x.id === 'c12').start;
  tl.scenes = tl.scenes.filter((x) => ids.includes(x.id)).map((x) => ({ ...x, start: x.start - shift, end: x.end - shift }));
  tl.texts = tl.texts.filter((x) => ids.includes(x.scene)).map((x) => ({ ...x, start: x.start - shift, end: x.end - shift }));
  tl.poster = 0.5;
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(tl, null, 2));
  const blank = async () => (await runChecks(dir, { ratio: '16:9', stage: 'build', browser })).findings.filter((x) => x.check === 'blank');
  const found = await blank();
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.equal(found[0].id, 'blank|2');
  assert.equal(found[0].t, 2);
  assert.match(found[0].message, /^カット2（0:02\.0）: カットの最初のコマが背景だけ/);
  // 例外の鍵に入る証拠には、隣のカット（前のカットの最後のコマ）の値を入れない（隣を直しただけで例外が外れないように）
  assert.doesNotMatch(found[0].evidence, /前のカット/);
  // シーンを開き直さない2回目（前回の結果を使う）でも、同じく指摘する
  const opened = [];
  assert.deepEqual((await runChecks(dir, { ratio: '16:9', stage: 'build', browser: counting(opened) })).findings.filter((x) => x.check === 'blank'), found);
  assert.deepEqual(opened, []);
  // 最初のコマから面が半分開いていれば、つなぎ目で画面が空にならない
  const html = path.join(dir, 'src/scenes/cut-in.html');
  const orig = fs.readFileSync(html, 'utf8');
  for (const mode of ['held', 'fade', 'ease', 'expo', 'gradease', 'wipe']) {
    // held: 最初のコマから面が半分開いている。fade（0.5 秒で一様に現れる）、ease（0.5 秒の outCubic で現れる）、
    // expo（0.4 秒の outExpo。motion-rules の勧める速さ）、gradease（淡いグラデーションの地の上の ease）、wipe（0.6 秒で拭き取るように開く）は、
    // 何も無い地から始まるふつうの入場で、2コマ目にはまだ絵が出そろっていないので、ちらつきではない
    fs.writeFileSync(html, orig.replace('<body>', `<body data-start="${mode}">`));
    assert.deepEqual(await blank(), [], mode);
  }
  // 60fps では、1コマの穴（16 ms）も、2コマの穴（33 ms。30fps の1コマと同じ長さ）も指摘する
  const tl60 = readTl(dir);
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify({ ...tl60, fps: 60 }, null, 2));
  for (const mode of ['flick', 'hole2']) {
    fs.writeFileSync(html, orig.replace('<body>', `<body data-start="${mode}">`));
    assert.deepEqual((await blank()).map((x) => x.id), ['blank|2'], `60fps ${mode}`);
  }
  fs.writeFileSync(html, orig.replace('<body>', '<body data-start="expo">'));
  assert.deepEqual(await blank(), [], '60fps expo');
  // 動画の最初のカットは、前のコマが無いので問わない
  const first = onlyCase('c13');
  assert.deepEqual((await runChecks(first, { ratio: '16:9', stage: 'build', browser })).findings.filter((x) => x.check === 'blank'), []);
});

/** browser の代わりに渡し、開いたシーンの HTML のファイル名を opened に記録する */
function counting(opened) {
  return {
    newPage: async () => {
      const page = await browser.newPage();
      const goto = page.goto.bind(page);
      page.goto = (url, o) => {
        opened.push(path.basename(decodeURIComponent(new URL(url).pathname)));
        return goto(url, o);
      };
      return page;
    },
  };
}

toolTest('点検は、前回から変わっていないシーンを開き直さずに前回の指摘を使い、毎回動画全体の結果を書く。シーンの HTML・原稿の文字・点検の版が変われば開き直す', async () => {
  const dir = copyFixture(path.join(FIXTURES, 'runtime-cases'));
  const tl = readTl(dir);
  // c08（指摘あり）・c09・c10（指摘あり）を 0 秒からの3カットにする
  const ids = ['c08', 'c09', 'c10'];
  const shift = tl.scenes.find((x) => x.id === 'c08').start;
  tl.scenes = tl.scenes.filter((x) => ids.includes(x.id)).map((x) => ({ ...x, start: x.start - shift, end: x.end - shift }));
  tl.texts = tl.texts.filter((x) => ids.includes(x.scene)).map((x) => ({ ...x, start: x.start - shift, end: x.end - shift }));
  tl.poster = 0.5;
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(tl, null, 2));
  const saved = () => JSON.parse(fs.readFileSync(path.join(dir, 'reviews/checks-build-16x9.json'), 'utf8')).findings;
  const first = await runChecks(dir, { ratio: '16:9', browser });
  assert.ok(first.findings.some((x) => x.cut === 1) && first.findings.some((x) => x.cut === 3), JSON.stringify(first.findings));

  // 何も変えなければ、どのシーンも開かず、同じ結果を全体のファイルに書く
  let opened = [];
  fs.unlinkSync(path.join(dir, 'reviews/checks-build-16x9.json'));
  const again = await runChecks(dir, { ratio: '16:9', browser: counting(opened) });
  assert.deepEqual(opened, []);
  assert.deepEqual(again.findings, first.findings);
  assert.deepEqual(saved(), first.findings);

  // シーンの HTML を変えれば、そのシーンだけ開く（決定論の点検で、同じシーンを2回開く）
  const veil = path.join(dir, tl.scenes[2].file);
  fs.appendFileSync(veil, '\n<!-- 直した -->\n');
  opened = [];
  await runChecks(dir, { ratio: '16:9', browser: counting(opened) });
  assert.deepEqual([...new Set(opened)], [path.basename(veil)]);

  // 原稿の文字を変えれば、そのカットだけ開く
  const tl2 = readTl(dir);
  tl2.texts.find((x) => x.scene === 'c09').text += '。';
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(tl2, null, 2));
  opened = [];
  await runChecks(dir, { ratio: '16:9', browser: counting(opened) });
  assert.deepEqual([...new Set(opened)], [path.basename(tl.scenes[1].file)]);

  // assets/ の素材を差し替えれば（JS のテンプレート文字列で読む画像でも見落とさないよう）、全部開く
  fs.mkdirSync(path.join(dir, 'assets/shots'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets/shots/screen.png'), 'a');
  opened = [];
  await runChecks(dir, { ratio: '16:9', browser: counting(opened) });
  assert.equal(new Set(opened).size, 3);

  // 点検の版が変われば、全部開く
  opened = [];
  const changed = await runChecks(dir, { ratio: '16:9', browser: counting(opened), checker: 'x' });
  assert.equal(new Set(opened).size, 3);
  assert.deepEqual(changed.findings.map((x) => x.id), (await runChecks(dir, { ratio: '16:9', browser, checker: 'x' })).findings.map((x) => x.id));
});

toolTest('loop が true なら、最初か最後のシーンが変わったときだけ、両方を開いて継ぎ目を見直す', async () => {
  const dir = copyFixture(SAMPLE);
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify({ ...readTl(dir), loop: true }, null, 2));
  assert.deepEqual((await runChecks(dir, { ratio: '16:9', browser })).findings.map((f) => f.check), ['loop']);
  let opened = [];
  const before = (await runChecks(dir, { ratio: '16:9', browser: counting(opened) })).findings;
  assert.deepEqual(before.map((f) => f.check), ['loop']);
  assert.deepEqual(opened, []);
  // 最後のシーンの地を最初のシーンと同じ色にすれば、両方を開き直して継ぎ目を測り直す（違う画素が減る）
  const s02 = path.join(dir, 'src/scenes/s02.html');
  fs.writeFileSync(s02, fs.readFileSync(s02, 'utf8').replace('#0b3d91', '#111827'));
  opened = [];
  const after = (await runChecks(dir, { ratio: '16:9', browser: counting(opened) })).findings;
  assert.deepEqual([...new Set(opened)].sort(), ['s01.html', 's02.html']);
  assert.deepEqual(after.map((f) => f.check), ['loop']);
  const pct = (f) => Number(/違う画素 ([\d.]+)%/.exec(f.evidence)[1]);
  assert.ok(pct(after[0]) < pct(before[0]), `${after[0].evidence} / ${before[0].evidence}`);
});

toolTest('描画のエラーと決定論の崩れが出たシーンは、前回の結果として残さず、次の点検でも開き直す', async () => {
  const dir = copyFixture(BROKEN);
  const tl = readTl(dir);
  // b06（決定論の崩れ）と b07（描画のエラー）を 0 秒からの2カットにする
  tl.scenes = [{ ...tl.scenes[5], start: 0, end: 1.5 }, { ...tl.scenes[6], start: 1.5, end: 3 }];
  tl.texts = [{ ...tl.texts.find((x) => x.id === 't07'), start: 0.1, end: 1.4 }, { ...tl.texts.find((x) => x.id === 't08'), start: 1.6, end: 2.9 }];
  tl.poster = 0.5;
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(tl, null, 2));
  const first = await runChecks(dir, { ratio: '16:9', browser });
  assert.deepEqual([...new Set(first.findings.map((f) => f.check))].sort(), ['determinism', 'script-error'], JSON.stringify(first.findings));
  const opened = [];
  await runChecks(dir, { ratio: '16:9', browser: counting(opened) });
  assert.deepEqual([...new Set(opened)].sort(), ['determinism.html', 'script-error.html']);
});

test('check.mjs に --scene は無い（毎回動画全体を点検し、変わっていないシーンは開き直さない）', () => {
  assert.doesNotMatch(fs.readFileSync(CHECK, 'utf8'), /'--scene'/);
});

test('veiled は、上に重なった半透明の面を下から順に文字の色へ重ねる', () => {
  assert.deepEqual(veiled([0, 0, 0], []), [0, 0, 0]);
  assert.deepEqual(veiled([0, 0, 0], [{ rgb: [255, 255, 255], a: 0.5 }]), [127.5, 127.5, 127.5]);
  assert.deepEqual(veiled([200, 100, 0], [{ rgb: [0, 0, 0], a: 0.5 }, { rgb: [100, 100, 100], a: 0.5 }]), [100, 75, 50]);
});

toolTest('決定論の点検は、先にあとの時刻を撮ったページでも、正常なシーンを誤って指摘しない', async () => {
  const spec = { width: 1920, height: 1080, scale: 1 };
  const page = await openPage(browser, SAMPLE, 's01', '16:9', spec);
  try {
    // 動いている層を一番大きい倍率で描かせておく（縁の画素がわずかに変わる条件）
    await page.evaluate(() => window.__ms.seek(1.4));
    await page.screenshot({ type: 'png' });
    assert.deepEqual(await determinismDiffs(page, () => openPage(browser, SAMPLE, 's01', '16:9', spec), 0.75), []);
  } finally {
    await page.close();
  }
  // 前のフレームの状態に頼るシーンは、同じ手順で引っかかる
  const bad = await openPage(browser, BROKEN, 'b06', '16:9', spec);
  try {
    await bad.evaluate(() => window.__ms.seek(1.4));
    await bad.screenshot({ type: 'png' });
    const diffs = await determinismDiffs(bad, () => openPage(browser, BROKEN, 'b06', '16:9', spec), 0.75);
    assert.ok(diffs.length > 0);
  } finally {
    await bad.close();
  }
});

toolTest('build でも、loop が true なら最初と最後のコマを比べる', async () => {
  // 見本は、最初（暗い地だけ）と最後（青い地に見出し）が大きく違う
  const dir = copyFixture(SAMPLE);
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify({ ...readTl(dir), loop: true }, null, 2));
  const r = await runChecks(dir, { ratio: '16:9', stage: 'build', browser });
  assert.deepEqual(r.findings.map((f) => [f.check, f.cut]), [['loop', 2]]);
  assert.match(r.findings[0].message, /^カット2（0:02\.9）/);

  // 動かない1シーンなら、最初と最後が同じなので引っかからない
  const still = copyFixture(BROKEN);
  const tl = readTl(still);
  fs.writeFileSync(path.join(still, 'timeline.json'), JSON.stringify({
    ...tl, loop: true,
    scenes: [{ ...tl.scenes[3], start: 0, end: 1.5 }],
    texts: [{ ...tl.texts.find((x) => x.id === 't05'), start: 0.1, end: 1.4 }],
  }, null, 2));
  const s = await runChecks(still, { ratio: '16:9', stage: 'build', browser });
  assert.deepEqual(s.findings.map((f) => f.check), ['contrast']);
});

toolTest('CLI は問題があれば終了コード 1、無ければ 0 で、--json で結果を出す', async () => {
  const good = copyFixture(SAMPLE);
  const ok = spawnSync(process.execPath, [CHECK, good, '--json'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), { ok: true, findings: [] });

  const bad = copyFixture(BROKEN);
  const tl = readTl(bad);
  // 時間を短くするため、例外を投げるシーンだけにする
  tl.scenes = [tl.scenes[6]];
  tl.scenes[0] = { ...tl.scenes[0], start: 0, end: 1.5 };
  tl.texts = [{ ...tl.texts.find((t) => t.id === 't08'), start: 0.1, end: 1.4 }];
  fs.writeFileSync(path.join(bad, 'timeline.json'), JSON.stringify(tl, null, 2));
  const ng = spawnSync(process.execPath, [CHECK, bad, '--stage', 'build'], { encoding: 'utf8' });
  assert.equal(ng.status, 1);
  assert.match(ng.stdout, /カット1/);
  assert.ok(fs.existsSync(path.join(bad, 'reviews/checks-build-16x9.json')));
});

toolTest('CLI: 同じ指摘が3回続けて残れば終了コード 2 で止め時の案内を出し、--waive で例外にすると次は通り、結果に理由が残る', async () => {
  const dir = copyFixture(SAMPLE);
  const tl = readTl(dir);
  tl.texts[0].end = 1.0; // 「ようこそ」は 1.3 秒要る
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(tl, null, 2));
  const cli = (...a) => spawnSync(process.execPath, [CHECK, dir, ...a], { encoding: 'utf8' });
  assert.equal(cli().status, 1);
  assert.equal(cli().status, 1);
  const third = cli();
  assert.equal(third.status, 2, third.stdout + third.stderr);
  assert.match(third.stdout, /1\. カット1（0:00\.1）: 文字「ようこそ」の表示が/);
  assert.match(third.stdout, /ここで止めて利用者に相談/);
  assert.match(third.stdout, /3回続けて残った/);
  assert.match(third.stdout, /--waive/);
  // 例外のコマンドは、ほかの案内と同じく道具の絶対パスを引用符で囲んで出す
  assert.ok(third.stdout.includes(`node "${CHECK}" "${dir}" --waive`), third.stdout);
  assert.match(third.stdout, /compromises\.md/);
  const noWhy = cli('--waive', '1');
  assert.equal(noWhy.status, 1);
  assert.match(noWhy.stderr, /--why/);
  const w = cli('--waive', '1', '--why', '0.9 秒でも読める短い語。画像で確かめた');
  assert.equal(w.status, 0, w.stderr);
  assert.match(w.stdout, /例外にしました/);
  const ok = cli('--json');
  assert.equal(ok.status, 0, ok.stdout);
  const r = JSON.parse(ok.stdout);
  assert.equal(r.ok, true);
  assert.equal(r.findings[0].waived, true);
  assert.equal(r.findings[0].why, '0.9 秒でも読める短い語。画像で確かめた');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'reviews/checks-build-16x9.json'), 'utf8'));
  assert.equal(saved.ok, true);
  assert.equal(saved.findings[0].waived, true);
});

// ---- 完成版だけの点検（MP4） ----

toolTest('完成版: 設定どおりの動画なら問題なし。尺・解像度・fps が違えば media', async () => {
  const tl = readTl(SAMPLE);
  const good = makeVideo(tmpFile('good.mp4'));
  assert.deepEqual(await checkVideo(good, tl, { ratio: '16:9', preset: 'final' }), []);

  const bad = makeVideo(tmpFile('bad.mp4'), { seconds: 2, size: '1280x720', fps: 25 });
  const f = await checkVideo(bad, tl, { ratio: '16:9', preset: 'final' });
  assert.ok(f.length >= 3, JSON.stringify(f));
  assert.ok(f.every((x) => x.check === 'media'));
  assert.ok(f.some((x) => /1280×720/.test(x.message) && /1920×1080/.test(x.message)));
  assert.ok(f.some((x) => /25/.test(x.message) && /fps/.test(x.message)));
  assert.ok(f.some((x) => /尺/.test(x.message)));

  // ラフ版は 960×540・30fps
  const draft = makeVideo(tmpFile('draft.mp4'), { size: '960x540' });
  assert.deepEqual(await checkVideo(draft, tl, { ratio: '16:9', preset: 'draft' }), []);

  // 映像の尺が無い入れ物（MKV）はファイル全体の尺で見る。どちらも無ければ、読み取れないと指摘する
  const mkv = makeVideo(tmpFile('good.mkv'));
  assert.deepEqual(await checkVideo(mkv, tl, { ratio: '16:9', preset: 'final' }), []);
  const raw = makeVideo(tmpFile('raw.h264'));
  const nr = await checkVideo(raw, tl, { ratio: '16:9', preset: 'final' });
  assert.ok(nr.some((x) => x.check === 'media' && /尺を読み取れません/.test(x.message)), JSON.stringify(nr));
}, HAS_FFMPEG);

toolTest('完成版: MP4 の指摘は問題ごとに別の id で、fps の問題を例外にしても、同じファイルの解像度の問題は例外にならない', async () => {
  const tl = readTl(SAMPLE);
  const file = tmpFile('fps.mp4');
  const fps = (await checkVideo(makeVideo(file, { fps: 25 }), tl, { ratio: '16:9', preset: 'final' })).map((f) => ({ ...f, ratio: '16:9' }));
  assert.deepEqual(fps.map((f) => f.id), ['media|fps']);
  const dir = tmpProjectDir();
  recordRun(dir, 'final', fps, ['16:9']);
  waive(dir, [1], '25fps で納める約束');
  assert.equal(applyWaivers(fps, readWaivers(dir))[0].waived, true);
  // 同じファイルを書き出し直したら、解像度も違った
  const res = (await checkVideo(makeVideo(file, { fps: 25, size: '1280x720' }), tl, { ratio: '16:9', preset: 'final' })).map((f) => ({ ...f, ratio: '16:9' }));
  assert.deepEqual(res.map((f) => f.id).sort(), ['media|fps', 'media|resolution']);
  const marked = applyWaivers(res, readWaivers(dir));
  assert.equal(marked.find((f) => f.id === 'media|resolution').waived, undefined);
  assert.equal(marked.find((f) => f.id === 'media|fps').waived, true);
}, HAS_FFMPEG);

toolTest('完成版: 毎秒 3 回を超える点滅は flash、ゆっくりな切り替えは通る', async () => {
  const tl = readTl(SAMPLE);
  const blink = makeVideo(tmpFile('blink.mp4'), { vf: "drawbox=c=white:t=fill:enable='lt(mod(t,0.2),0.1)'" });
  const f = await checkVideo(blink, tl, { ratio: '16:9', preset: 'final' });
  assert.deepEqual([...new Set(f.map((x) => x.check))], ['flash']);
  assert.equal(f[0].cut, 1);
  assert.match(f[0].message, /^カット1（0:00\.\d）/);

  const slow = makeVideo(tmpFile('slow.mp4'), { vf: "drawbox=c=white:t=fill:enable='lt(mod(t,1),0.5)'" });
  assert.deepEqual(await checkVideo(slow, tl, { ratio: '16:9', preset: 'final' }), []);
}, HAS_FFMPEG);

toolTest('完成版: 音があれば -14 LUFS ±1 とトゥルーピーク -1 dBTP 以下を確かめる', async () => {
  // ナレーションがあるときの規則（効果音だけなら別）
  const tl = { ...readTl(SAMPLE), narration: [{ id: 'n01', scene: 's01', text: 'ようこそ', start: 0.3, audio: 'audio/n01.wav', duration: 1 }] };
  const ok = makeVideo(tmpFile('loud-ok.mp4'), { audio: sineAt14(3) });
  assert.deepEqual(await checkVideo(ok, tl, { ratio: '16:9', preset: 'final' }), []);

  const quiet = makeVideo(tmpFile('quiet.mp4'), { audio: 'sine=frequency=1000:sample_rate=48000:duration=3,volume=-20dB' });
  const f = await checkVideo(quiet, tl, { ratio: '16:9', preset: 'final' });
  assert.deepEqual(f.map((x) => x.check), ['loudness']);
  assert.match(f[0].message, /LUFS/);

  const peak = makeVideo(tmpFile('peak.mp4'), { audio: 'sine=frequency=1000:sample_rate=48000:duration=3,volume=19dB' });
  const p = await checkVideo(peak, tl, { ratio: '16:9', preset: 'final' });
  assert.ok(p.some((x) => x.check === 'loudness' && /dBTP/.test(x.message)), JSON.stringify(p));
}, HAS_FFMPEG);

toolTest('完成版: loop が true なら、先頭と末尾の絵が大きく違うと loop', async () => {
  const tl = { ...readTl(SAMPLE), loop: true };
  const jump = makeVideo(tmpFile('jump.mp4'), { vf: "drawbox=c=white:t=fill:enable='gte(t,1.5)'" });
  const f = await checkVideo(jump, tl, { ratio: '16:9', preset: 'final' });
  assert.deepEqual(f.map((x) => x.check), ['loop']);
  assert.equal(f[0].cut, tl.scenes.length);
  // 同じ動画でも loop が false なら見ない
  assert.deepEqual(await checkVideo(jump, readTl(SAMPLE), { ratio: '16:9', preset: 'final' }), []);
  const same = makeVideo(tmpFile('same.mp4'));
  assert.deepEqual(await checkVideo(same, tl, { ratio: '16:9', preset: 'final' }), []);
}, HAS_FFMPEG);

toolTest('final の点検は、完成版の動画が無ければ media、あれば見本は ok', async () => {
  const dir = copyFixture(SAMPLE);
  const missing = await runChecks(dir, { ratio: '16:9', stage: 'final', browser });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.findings.map((x) => x.check), ['media']);
  assert.match(missing.findings[0].message, /見つかりません/);

  makeVideo(videoPath(dir, readTl(dir), '16:9', 'final'), { audio: sineAt14(3) });
  const r = await runChecks(dir, { ratio: '16:9', stage: 'final', browser });
  assert.deepEqual(r.findings, []);
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(dir, 'reviews/checks-final-16x9.json')));
});

toolTest('final の点検は、loop が true ならループ版（_loop.mp4）があり、本編より新しく、尺が合い、継ぎ目が合っているかも見る', async () => {
  const dir = copyFixture(SAMPLE);
  const tl = { ...readTl(dir), loop: true };
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(tl, null, 2));
  const main = makeVideo(videoPath(dir, tl, '16:9', 'final'), { audio: sineAt14(3) });
  const loop = main.replace(/\.mp4$/, '_loop.mp4');
  const checks = async () => (await runChecks(dir, { ratio: '16:9', stage: 'final', browser })).findings;

  // 無ければ media
  let f = await checks();
  assert.deepEqual(f.map((x) => x.check), ['media'], JSON.stringify(f));
  assert.match(f[0].message, /ループ版.*見つかりません/);
  assert.equal(f[0].evidence, loop);

  // 音なしで本編と同じ尺なら通る
  makeVideo(loop);
  const later = fs.statSync(main).mtime.getTime() / 1000 + 5;
  fs.utimesSync(loop, later, later);
  assert.deepEqual(await checks(), []);

  // 本編より古ければ、書き出し直しを促す
  const earlier = fs.statSync(main).mtime.getTime() / 1000 - 60;
  fs.utimesSync(loop, earlier, earlier);
  f = await checks();
  assert.deepEqual(f.map((x) => x.check), ['media'], JSON.stringify(f));
  assert.match(f[0].message, /ループ版.*古い/);

  // 尺が違えば media（本編と同じ規則）、音が入っていれば media
  makeVideo(loop, { seconds: 2 });
  fs.utimesSync(loop, later, later);
  f = await checks();
  assert.ok(f.some((x) => x.check === 'media' && /ループ版の尺/.test(x.message)), JSON.stringify(f));
  makeVideo(loop, { audio: sineAt14(3) });
  fs.utimesSync(loop, later, later);
  f = await checks();
  assert.deepEqual(f.map((x) => x.check), ['media'], JSON.stringify(f));
  assert.match(f[0].message, /ループ版に音が入っています/);

  // 継ぎ目が合っていなければ loop（本編は合っている）
  makeVideo(loop, { vf: "drawbox=c=white:t=fill:enable='gte(t,1.5)'" });
  fs.utimesSync(loop, later, later);
  f = await checks();
  assert.deepEqual(f.map((x) => x.check), ['loop'], JSON.stringify(f));
  assert.match(f[0].message, /ループ版/);
  assert.match(f[0].evidence, /PSNR/);
});

toolTest('完成版: 効果音だけの動画は、-14 LUFS より小さくても通り、-14 LUFS を超えると loudness', async () => {
  const tl = { ...readTl(SAMPLE), narration: [], bgm: null };
  const quiet = makeVideo(tmpFile('sfx-quiet.mp4'), { audio: 'sine=frequency=1000:sample_rate=48000:duration=3,volume=-30dB' });
  assert.deepEqual(await checkVideo(quiet, tl, { ratio: '16:9', preset: 'final' }), []);
  const loud = makeVideo(tmpFile('sfx-loud.mp4'), { audio: 'sine=frequency=1000:sample_rate=48000:duration=3,volume=12dB' });
  const f = await checkVideo(loud, tl, { ratio: '16:9', preset: 'final' });
  assert.ok(f.some((x) => x.check === 'loudness' && /LUFS/.test(x.message)), JSON.stringify(f));
}, HAS_FFMPEG);

toolTest('完成版: 最後のコマに細い線が1本残っているだけでも loop', async () => {
  const tl = { ...readTl(SAMPLE), loop: true };
  // 最初は黒、最後の0.5秒だけ1画素幅の白い縦線が残る
  const strip = makeVideo(tmpFile('strip.mp4'), { final: true, vf: "drawbox=x=960:y=0:w=1:h=1080:c=white:t=fill:enable='gte(t,2.5)'" });
  const f = await checkVideo(strip, tl, { ratio: '16:9', preset: 'final' });
  assert.deepEqual(f.map((x) => x.check), ['loop'], JSON.stringify(f));
}, HAS_FFMPEG);

toolTest('完成版: 元の絵が同じなら、圧縮の揺らぎでは loop にしない（グラデーションとロゴ風の箱、途中だけ動く）', async () => {
  const tl = { ...readTl(SAMPLE), loop: true };
  const base = "nullsrc=s=1920x1080:r=30:d=3,geq=r='255*X/W':g='255*Y/H':b='128+60*sin(X/90)*cos(Y/70)'";
  const vf = "drawbox=x=300:y=400:w=500:h=120:c=0xE91E63:t=fill,drawbox=x=900:y=200:w=700:h=500:c=white@0.8:t=fill:enable='between(t,0.5,2.5)'";
  const v = makeVideo(tmpFile('gradient.mp4'), { final: true, base, vf });
  assert.deepEqual(await checkVideo(v, tl, { ratio: '16:9', preset: 'final' }), []);
}, HAS_FFMPEG);

toolTest('完成版: ロゴが最初の絵から動いて同じ位置へ戻る動画は、継ぎ目のシーンの圧縮（SEAM_X264_PARAMS）なら loop にしない', async () => {
  const tl = { ...readTl(SAMPLE), loop: true };
  // 紺の地のロゴ（白、斜めの縁あり）が 0.3 秒から上へ動き、2.4 秒で元の位置へ戻って止まる（会社紹介のループ版で起きた形）
  const logo = fileURLToPath(new URL('./fixtures/loop-edge.png', import.meta.url));
  const make = (name, extra) => {
    const file = tmpFile(name);
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x001037:s=1920x1080:r=30:d=3', '-i', logo, '-filter_complex',
      "[0][1]overlay=x=660:y='if(lt(t,0.3),480,if(lt(t,2.4),480-200*sin((t-0.3)/2.1*PI),480))'",
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', ...extra, '-pix_fmt', 'yuv420p', file]);
    return file;
  };
  // 既定の圧縮では、最初のコマのロゴの縁だけが粗く圧縮され（後で使われない区画の質を下げる仕組みのため）、元の絵が同じでも差が出る
  const plain = await checkVideo(make('seam-plain.mp4', []), tl, { ratio: '16:9', preset: 'final' });
  assert.deepEqual(plain.map((x) => x.check), ['loop'], JSON.stringify(plain));
  const seam = await checkVideo(make('seam.mp4', ['-x264-params', SEAM_X264_PARAMS]), tl, { ratio: '16:9', preset: 'final' });
  assert.deepEqual(seam, []);
}, HAS_FFMPEG);

// ---- 意図した演出の宣言（settings.intent と data-ms-intent） ----

/** 灰色の地に灰色の文字（b04）だけの1シーンの制作フォルダ。intent を渡すと、文字を <div data-ms-intent="…"> で包む */
function contrastOnly(intent) {
  const dir = copyFixture(BROKEN);
  const tl = readTl(dir);
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify({
    ...tl, scenes: [{ ...tl.scenes[3], start: 0, end: 1.5 }],
    texts: [{ ...tl.texts.find((x) => x.id === 't05'), start: 0.1, end: 1.4 }], poster: 0.5,
  }, null, 2));
  if (intent !== undefined) {
    const file = path.join(dir, 'src/scenes/contrast.html');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('<p class="t a" data-ms-text="t05"></p>', `<div data-ms-intent="${intent}"><p class="t a" data-ms-text="t05"></p></div>`));
  }
  return dir;
}

toolTest('祖先の data-ms-intent="contrast" は中の文字の contrast を意図どおりにし、合格にする', async () => {
  const dir = contrastOnly('contrast');
  const r = await runChecks(dir, { ratio: '16:9', stage: 'build', browser });
  assert.deepEqual(r.findings.map((f) => [f.check, f.intended]), [['contrast', true]], JSON.stringify(r.findings));
  assert.equal(r.ok, true);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'reviews/checks-build-16x9.json'), 'utf8'));
  assert.equal(saved.ok, true);
  assert.equal(saved.findings[0].intended, true);
});

toolTest('data-ms-intent に知らない名前や宣言できない名前があれば script-error で知らせる', async () => {
  const dir = contrastOnly('contrast text-mismatch flicker');
  const r = await runChecks(dir, { ratio: '16:9', stage: 'build', browser });
  const e = r.findings.find((x) => x.check === 'script-error');
  assert.ok(e, JSON.stringify(r.findings));
  assert.match(e.message, /text-mismatch/);
  assert.match(e.message, /flicker/);
  assert.equal(r.ok, false);
});

toolTest('settings.intent（scenes なし）は動画全体のその点検を意図どおりにし、理由を残す', async () => {
  const dir = contrastOnly();
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ title: 't', stage: 'build', gates: {}, settings: { course: 'full', kind: '', fps: 30,
    ratios: ['16:9'], loop: false, audio: { narration: 'none', bgm: 'none', sfx: false },
    intent: [{ check: 'contrast', why: '背景に薄く敷く文字', addedAt: '2026-10-22T00:00:00Z', stage: 'style' }] }, models: [] }));
  const r = await runChecks(dir, { ratio: '16:9', stage: 'build', browser });
  assert.equal(r.findings[0].intended, true);
  assert.equal(r.findings[0].intendedWhy, '背景に薄く敷く文字');
  assert.equal(r.ok, true);
});

toolTest('settings.intent に宣言できない名前があれば、点検の前に止める', async () => {
  const dir = contrastOnly();
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ title: 't', stage: 'build', gates: {}, settings: { course: 'full', kind: '', fps: 30,
    ratios: ['16:9'], loop: false, audio: { narration: 'none', bgm: 'none', sfx: false },
    intent: [{ check: 'determinism', why: 'x', addedAt: 'a', stage: 'build' }] }, models: [] }));
  await assert.rejects(runChecks(dir, { ratio: '16:9', stage: 'build', browser }), /determinism.*宣言できません/);
});

toolTest('意図どおりの指摘は止め時に数えない', async () => {
  const dir = contrastOnly('contrast');
  for (let i = 0; i < 4; i++) {
    const r = await runChecks(dir, { ratio: '16:9', stage: 'build', browser });
    assert.equal(r.stop, undefined);
  }
});

toolTest('シーンの宣言を初めて見た日時を intent-seen.json に残し、2回目は変えない', async () => {
  const dir = contrastOnly('contrast');
  await runChecks(dir, { ratio: '16:9', stage: 'build', browser });
  const first = readIntentSeen(dir);
  assert.deepEqual(first.map((x) => [x.scene, x.check]), [['b04', 'contrast']]);
  // シーンを書き換えて開き直させても、初めて見た日時は変わらない
  const file = path.join(dir, 'src/scenes/contrast.html');
  fs.appendFileSync(file, '\n<!-- 書き換え -->\n');
  await runChecks(dir, { ratio: '16:9', stage: 'build', browser });
  assert.deepEqual(readIntentSeen(dir), first);
});

test('applyIntents: scenes に無いシーンの指摘は残し、正しく作るための点検には宣言が効かない', () => {
  const tl = { scenes: [{ id: 's01', start: 0, end: 1 }, { id: 's02', start: 1, end: 2 }] };
  const f = (check, cut, extra = {}) => ({ check, cut, t: cut - 0.5, message: 'm', id: `${check}|${cut}`, ...extra });
  const intents = [{ check: 'hold', why: '一瞬で流す', scenes: ['s02'], addedAt: 'a', stage: 'build' },
    { check: 'text-mismatch', why: 'x', addedAt: 'a', stage: 'build' }];
  const out = applyIntents([f('hold', 1), f('hold', 2), f('text-mismatch', 1, { intent: ['text-mismatch'] })], intents, tl);
  assert.equal(out[0].intended, undefined);
  assert.equal(out[1].intended, true);
  assert.equal(out[1].intendedWhy, '一瞬で流す');
  assert.equal(out[2].intended, undefined);
});

test('applyIntents: 音量は scenes の付いた宣言では外れず、scenes の無い宣言だけで外れる', () => {
  const tl = { scenes: [{ id: 's01', start: 0, end: 1 }] };
  const loud = { check: 'loudness', cut: 1, t: 0, message: 'm', id: 'loudness|lufs' };
  assert.equal(applyIntents([loud], [{ check: 'loudness', why: 'x', scenes: ['s01'], addedAt: 'a', stage: 'build' }], tl)[0].intended, undefined);
  assert.equal(applyIntents([loud], [{ check: 'loudness', why: '静かな環境音', addedAt: 'a', stage: 'build' }], tl)[0].intended, true);
});

toolTest('data-ms-intent に動画全体の点検（flash など）を書くと、project.mjs intent を使うよう知らせる', async () => {
  const dir = contrastOnly('contrast flash');
  const r = await runChecks(dir, { ratio: '16:9', stage: 'build', browser });
  const e = r.findings.find((x) => x.check === 'script-error');
  assert.ok(e, JSON.stringify(r.findings));
  assert.match(e.message, /flash/);
  assert.match(e.message, /project\.mjs intent/);
});

toolTest('シーンから宣言を外したら、intent-seen.json からも消える（残る宣言の初めて見た日時は変えない）', async () => {
  const dir = contrastOnly('contrast cover');
  await runChecks(dir, { ratio: '16:9', stage: 'build', browser });
  const first = readIntentSeen(dir);
  assert.deepEqual(first.map((x) => x.check).sort(), ['contrast', 'cover']);
  const file = path.join(dir, 'src/scenes/contrast.html');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('data-ms-intent="contrast cover"', 'data-ms-intent="contrast"'));
  await runChecks(dir, { ratio: '16:9', stage: 'build', browser });
  const now = readIntentSeen(dir);
  assert.deepEqual(now.map((x) => x.check), ['contrast']);
  assert.equal(now[0].firstSeenAt, first.find((x) => x.check === 'contrast').firstSeenAt);
});

toolTest('timeline.json から消したシーンの宣言は、intent-seen.json から消える', async () => {
  const dir = contrastOnly('contrast');
  await runChecks(dir, { ratio: '16:9', stage: 'build', browser });
  assert.equal(readIntentSeen(dir).length, 1);
  // 同じ絵のシーンを別の id にして入れ替える（b04 は timeline.json から消える）
  const tl = readTl(dir);
  tl.scenes[0].id = 'b09';
  tl.texts[0].scene = 'b09';
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(tl, null, 2));
  await runChecks(dir, { ratio: '16:9', stage: 'build', browser });
  assert.deepEqual(readIntentSeen(dir).map((x) => x.scene), ['b09']);
});

toolTest('fps だけを変えても、点検の結果を使い回さない（つなぎ目のコマは完成版の fps で見るため）', async () => {
  const dir = copyFixture(SAMPLE);
  await runChecks(dir, { ratio: '16:9', stage: 'build', browser });
  const cache = path.join(dir, 'reviews', '.check-cache', '16x9.json');
  const before = Object.keys(JSON.parse(fs.readFileSync(cache, 'utf8')).scenes);
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify({ ...readTl(dir), fps: 60 }, null, 2));
  await runChecks(dir, { ratio: '16:9', stage: 'build', browser });
  const after = Object.keys(JSON.parse(fs.readFileSync(cache, 'utf8')).scenes);
  assert.equal(after.length, before.length);
  assert.ok(after.every((k) => !before.includes(k)), '鍵が変わる');
});

test('settings.intent の scenes に、timeline.json に無いシーンの id があれば、点検の前に知らせる', async () => {
  const dir = copyFixture(SAMPLE);
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ title: 't', stage: 'build', gates: {}, settings: { course: 'full', kind: '', fps: 30,
    ratios: ['16:9'], loop: false, audio: { narration: 'none', bgm: 'none', sfx: false },
    intent: [{ check: 'hold', why: '一瞬で流す', scenes: ['s99'], addedAt: 'a', stage: 'build' }] }, models: [] }));
  await assert.rejects(runChecks(dir, { ratio: '16:9', stage: 'build' }), /s99/);
});

toolTest('点検は、開いたシーンごとに見た時刻の数・撮った画面の数・秒数を log に出す（前回のままのシーンは数だけ）', async () => {
  const dir = copyFixture(SAMPLE);
  const lines = [];
  await runChecks(dir, { ratio: '16:9', browser, log: (l) => lines.push(l) });
  assert.equal(lines[0], '点検（build）: 比率 16:9、カット 2（3 秒）');
  assert.match(lines[1], /^点検 16:9 カット 1\/2（1\.5 秒）: 時刻 \d+、撮影 \d+ 枚、[\d.]+ 秒$/);
  assert.match(lines[2], /^点検 16:9 カット 2\/2（1\.5 秒）: /);
  assert.match(lines[3], /^点検 16:9 シーン: 開いて点検 2、前回のまま 0、[\d.]+ 秒$/);
  lines.length = 0;
  await runChecks(dir, { ratio: '16:9', browser, log: (l) => lines.push(l) });
  assert.match(lines.at(-1), /開いて点検 0、前回のまま 2/);
});

toolTest('動かない文字でも、後ろの背景が途中で明るくなれば、測り直してコントラストを指摘する（足りていた文字は間隔をあけて測り直す）', async () => {
  const dir = copyFixture(SAMPLE);
  // s01 の見出しを最初から出したまま動かさず、0.8 秒から地を白に近くする
  fs.writeFileSync(path.join(dir, 'src/scenes/s01.html'), `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
  body { background: #111827; font-family: system-ui, sans-serif; }
  .title { position: absolute; left: 0; right: 0; top: 40%; text-align: center; font-size: 120px; font-weight: 700; color: #ffffff; }
</style></head><body><div class="title" data-ms-text="t01"></div>
<script>ms.scene((t) => { document.body.style.background = t >= 0.8 ? '#f8fafc' : '#111827'; });</script></body></html>
`);
  // s02（動かない見出し）を 6 秒まで伸ばす
  const tl = readTl(dir);
  tl.scenes[1].end = 6;
  tl.texts[1].end = 5.9;
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(tl, null, 2));
  const lines = [];
  const r = await runChecks(dir, { ratio: '16:9', browser, log: (l) => lines.push(l) });
  const c = r.findings.filter((f) => f.check === 'contrast');
  assert.equal(c.length, 1, JSON.stringify(r.findings));
  assert.equal(c[0].cut, 1);
  assert.ok(c[0].t >= 0.8 && c[0].t <= 0.8 + 0.5 + 0.2, String(c[0].t));
  // 撮った画面は、見た時刻より少ない（足りていたあいだは毎回は撮らない）
  const [, samples, shots] = /時刻 (\d+)、撮影 (\d+) 枚/.exec(lines.find((l) => l.includes('カット 2/2')));
  assert.ok(Number(shots) < Number(samples), lines.join('\n'));
});

toolTest('前のシーンの尺が変わって後ろへずれただけのシーンは開き直さず、前回の指摘の時刻をずらして使う。下書きの点検の結果は、完成版の点検でも使う', async () => {
  const dir = copyFixture(path.join(FIXTURES, 'runtime-cases'));
  const tl = readTl(dir);
  // c08（指摘あり）・c09・c10（指摘あり）を 0 秒からの3カットにする
  const ids = ['c08', 'c09', 'c10'];
  const shift = tl.scenes.find((x) => x.id === 'c08').start;
  tl.scenes = tl.scenes.filter((x) => ids.includes(x.id)).map((x) => ({ ...x, start: x.start - shift, end: x.end - shift }));
  tl.texts = tl.texts.filter((x) => ids.includes(x.scene)).map((x) => ({ ...x, start: x.start - shift, end: x.end - shift }));
  tl.poster = 0.5;
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(tl, null, 2));
  const first = await runChecks(dir, { ratio: '16:9', browser });
  assert.ok(first.findings.some((x) => x.cut === 3), JSON.stringify(first.findings));

  // 1カット目を 0.5 秒伸ばし、後ろの2カットをずらす（コマの格子とのずれは変わらない）
  const d = 0.5;
  const moved = readTl(dir);
  moved.scenes[0].end += d;
  for (const s of moved.scenes.slice(1)) Object.assign(s, { start: s.start + d, end: s.end + d });
  for (const x of moved.texts) if (x.scene !== 'c08') Object.assign(x, { start: x.start + d, end: x.end + d });
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(moved, null, 2));
  let opened = [];
  const reused = await runChecks(dir, { ratio: '16:9', browser: counting(opened) });
  assert.deepEqual([...new Set(opened)], [path.basename(tl.scenes[0].file)]);
  // 全部を開き直したときと、時刻も文も同じになる
  const pick = (r) => r.findings.map(({ id, cut, t, message }) => ({ id, cut, t, message }));
  const all = await runChecks(dir, { ratio: '16:9', browser, checker: 'x' });
  assert.deepEqual(pick(reused), pick(all));
  assert.ok(reused.findings.some((x) => x.cut === 3 && x.t >= moved.scenes[2].start), JSON.stringify(reused.findings));

  // 下書き（build）の点検の結果を、完成版の preset でも使う
  opened = [];
  const final = await runChecks(dir, { ratio: '16:9', preset: 'final', browser: counting(opened), checker: 'x' });
  assert.deepEqual(opened, []);
  assert.deepEqual(pick(final), pick(all));
});
