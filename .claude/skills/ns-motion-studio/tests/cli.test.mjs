// スキルの手順から呼ぶ CLI（project / feedback / timeline / fonts / voicevox）の引数の読み方を、実際に node で起動して確かめる。
// ネットワークを使うもの（fonts、voicevox）は、使い方の誤りで止まることだけを見る。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFeedbackLog } from '../scripts/feedback.mjs';
import { readProject } from '../scripts/project.mjs';

const SCRIPTS = fileURLToPath(new URL('../scripts/', import.meta.url));
const SAMPLE_TL = fileURLToPath(new URL('./fixtures/sample/timeline.json', import.meta.url));

/** node <scripts>/<name> ...args */
const run = (name, ...args) => spawnSync(process.execPath, [path.join(SCRIPTS, name), ...args], { encoding: 'utf8' });

function tmpProject() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nsms-cli-')), '動画 テスト', '新製品 紹介');
}

test('project.mjs: init で制作フォルダを作り、approve と stage で記録する', () => {
  const dir = tmpProject();
  const init = run('project.mjs', 'init', dir, '--title', '新製品 紹介');
  assert.equal(init.status, 0, init.stderr);
  assert.equal(readProject(dir).title, '新製品 紹介');
  assert.ok(fs.statSync(path.join(dir, 'src/scenes')).isDirectory());

  const ok = run('project.mjs', 'approve', dir, 'brief', '--note', '素材はあとで');
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(readProject(dir).gates.briefing.note, '素材はあとで');

  const st = run('project.mjs', 'stage', dir, 'style');
  assert.equal(st.status, 0, st.stderr);
  assert.equal(readProject(dir).stage, 'style');
});

test('project.mjs: 知らない関門・段階、題名なしの init、知らないコマンドは終了コード 1 で理由を出す', () => {
  const dir = tmpProject();
  assert.equal(run('project.mjs', 'init', dir).status, 1);
  assert.equal(fs.existsSync(path.join(dir, 'project.json')), false);
  run('project.mjs', 'init', dir, '--title', 't');
  const gate = run('project.mjs', 'approve', dir, 'final');
  assert.equal(gate.status, 1);
  assert.match(gate.stderr, /知らない関門/);
  const stage = run('project.mjs', 'stage', dir, 'done');
  assert.equal(stage.status, 1);
  assert.match(stage.stderr, /知らない段階/);
  const usage = run('project.mjs', 'oops', dir);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /使い方/);
});

test('feedback.mjs: log は指摘を記録して番号を JSON で返し、読めない行は unresolved に残す。resolve で対応を書く', () => {
  const dir = tmpProject();
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(SAMPLE_TL, path.join(dir, 'timeline.json'));
  const input = path.join(dir, 'reviews', 'feedback-in.txt');
  fs.mkdirSync(path.dirname(input), { recursive: true });
  fs.writeFileSync(input, ['[ns-motion-studio 指摘] 見本 / rough', 'カット2（0:01.5〜0:03）：文字を大きく', 'なんとなく暗い'].join('\n'));

  const r = run('feedback.mjs', 'log', dir, input, '--gate', 'rough');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.logged, [{ index: 0, cut: 2, text: '文字を大きく' }]);
  assert.deepEqual(out.unresolved, ['なんとなく暗い']);
  assert.equal(readFeedbackLog(dir).items[0].gate, 'rough');

  // 同じ指摘を貼り直しても、二重に記録せず、そのことを知らせる
  const again = run('feedback.mjs', 'log', dir, input, '--gate', 'rough');
  assert.equal(again.status, 0, again.stderr);
  const dup = JSON.parse(again.stdout);
  assert.deepEqual(dup.logged, []);
  assert.equal(dup.duplicates[0].index, 0);
  assert.match(dup.duplicates[0].note, /記録済み/);
  assert.equal(readFeedbackLog(dir).items.length, 1);

  const ok = run('feedback.mjs', 'resolve', dir, '0', '--how', '見出しを 96px から 120px に');
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(readFeedbackLog(dir).items[0].resolved.how, '見出しを 96px から 120px に');

  assert.equal(run('feedback.mjs', 'log', dir, input).status, 1, '--gate が無ければ止まる');
  assert.equal(run('feedback.mjs', 'resolve', dir, '5', '--how', 'x').status, 1, '無い番号は止まる');
  assert.equal(run('feedback.mjs', 'resolve', dir, '0').status, 1, '--how が無ければ止まる');
});

test('timeline.mjs: validate は誤りと表示時間の不足を出して終了コード 1、正しければ 0。slice はシーンの JSON を出す', () => {
  const dir = tmpProject();
  fs.mkdirSync(dir, { recursive: true });
  const tl = JSON.parse(fs.readFileSync(SAMPLE_TL, 'utf8'));
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(tl));
  const ok = run('timeline.mjs', 'validate', dir);
  assert.equal(ok.status, 0, ok.stderr);

  const slice = run('timeline.mjs', 'slice', dir, 's02');
  assert.equal(slice.status, 0, slice.stderr);
  assert.deepEqual(JSON.parse(slice.stdout).texts.map((t) => [t.id, t.start]), [['t02', 0.1]]);

  tl.fps = 29;
  tl.texts[0] = { ...tl.texts[0], text: 'とても長いテロップで読み切れません', end: 0.6 };
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(tl));
  const ng = run('timeline.mjs', 'validate', dir);
  assert.equal(ng.status, 1);
  assert.match(ng.stdout, /fps/);
  assert.match(ng.stdout, /t01/);

  // 声が重なるナレーションも誤りとして出す
  const tl2 = JSON.parse(fs.readFileSync(SAMPLE_TL, 'utf8'));
  const sc = tl2.scenes[0];
  tl2.narration = [
    { id: 'n01', scene: sc.id, text: 'いち', start: sc.start, audio: 'audio/narration/n01.wav', duration: 1.0 },
    { id: 'n02', scene: sc.id, text: 'に', start: sc.start + 0.5, audio: 'audio/narration/n02.wav', duration: 0.3 },
  ];
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(tl2));
  const ov = run('timeline.mjs', 'validate', dir);
  assert.equal(ov.status, 1);
  assert.match(ov.stdout, /n01.*n02.*声が重なります/);

  assert.equal(run('timeline.mjs', 'slice', dir).status, 1, 'シーンの id が無ければ止まる');
  assert.equal(run('timeline.mjs').status, 1);
});

test('fonts.mjs と voicevox.mjs: 引数が足りなければ通信せずに使い方を出して止まる', () => {
  for (const args of [['fonts.mjs'], ['fonts.mjs', tmpProject(), 'Noto Sans JP'], ['fonts.mjs', tmpProject(), 'Noto Sans JP', '400,abc'], ['voicevox.mjs', 'oops']]) {
    const r = run(...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /使い方/, args.join(' '));
  }
});

test('render.mjs --estimate: 見込みだけを出して、書き出さずに終わる', () => {
  const dir = tmpProject();
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(SAMPLE_TL, path.join(dir, 'timeline.json'));
  // 3 秒 × 30fps = 90 フレーム。シーンの HTML が無くても見込みは出せる
  const r = run('render.mjs', dir, '--preset', 'final', '--estimate');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /見込み: 90 フレーム/);
  assert.match(r.stdout, /assemble.mjs/);
  assert.equal(fs.existsSync(path.join(dir, 'out')), false);
  // --scene のときは、音をまとめてつなぐ時間は出さない（シーンだけの書き出しには関係しない）
  const one = run('render.mjs', dir, '--scene', 's01', '--estimate');
  assert.equal(one.status, 0, one.stderr);
  assert.match(one.stdout, /見込み: /);
  assert.doesNotMatch(one.stdout, /assemble/);
});

test('project.mjs fallback: on で settings.fallback を claude-motion にし、off で外す', () => {
  const dir = tmpProject();
  run('project.mjs', 'init', dir, '--title', 't');
  const on = run('project.mjs', 'fallback', dir, 'on');
  assert.equal(on.status, 0, on.stderr);
  assert.equal(readProject(dir).settings.fallback, 'claude-motion');
  const off = run('project.mjs', 'fallback', dir, 'off');
  assert.equal(off.status, 0, off.stderr);
  assert.equal('fallback' in readProject(dir).settings, false);
  assert.equal(run('project.mjs', 'fallback', dir, 'maybe').status, 1);
});

test('review-page.mjs: 静止画が無くても絵コンテのページを作れる（道具なしの逃げ道のとき）', () => {
  const dir = tmpProject();
  run('project.mjs', 'init', dir, '--title', 't');
  fs.copyFileSync(SAMPLE_TL, path.join(dir, 'timeline.json'));
  const r = run('review-page.mjs', dir, 'storyboard', '--no-open');
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(dir, 'reviews', 'storyboard.html'), 'utf8'), /静止画はまだありません/);
});

test('review-page.mjs: ページがもうあれば、作り直してもブラウザを開かず、再読み込みを頼む', () => {
  const dir = tmpProject();
  run('project.mjs', 'init', dir, '--title', 't');
  fs.copyFileSync(SAMPLE_TL, path.join(dir, 'timeline.json'));
  // 1回目は試験なので --no-open で作る（利用者のブラウザを開かない）
  assert.equal(run('review-page.mjs', dir, 'storyboard', '--no-open').status, 0);
  const again = run('review-page.mjs', dir, 'storyboard');
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /ページを作り直しました。開いているページを再読み込みしてください（閉じていれば、次のファイルを開いてください）: .*storyboard\.html/);
});

test('gemini.mjs consent: --yes なしは注意事項を出して終了コード 0（誤りではない）で止まり、何も記録しない。--yes で記録する', () => {
  const dir = tmpProject();
  assert.equal(run('project.mjs', 'init', dir, '--title', 't').status, 0);
  const preview = run('gemini.mjs', 'consent', dir);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /課金設定済み/);
  assert.equal(readProject(dir).externalApiConsent ?? null, null);
  // 利用者本人の言葉（--quote）が無ければ記録しない
  const noQuote = run('gemini.mjs', 'consent', dir, '--yes');
  assert.equal(noQuote.status, 1);
  assert.match(noQuote.stderr, /--quote/);
  assert.equal(readProject(dir).externalApiConsent ?? null, null);
  const yes = run('gemini.mjs', 'consent', dir, '--yes', '--quote', 'はい、使ってください');
  assert.equal(yes.status, 0, yes.stderr);
  assert.equal(readProject(dir).externalApiConsent.quote, 'はい、使ってください');
});

test('有料の実行（gemini.mjs bgm、narration.mjs --engine gemini）は --approved が無ければ、呼ぶ回数を出して何も送らずに止まる', () => {
  const dir = tmpProject();
  assert.equal(run('project.mjs', 'init', dir, '--title', 't').status, 0);
  const tl = JSON.parse(fs.readFileSync(SAMPLE_TL, 'utf8'));
  tl.narration = [
    { id: 'n01', scene: tl.scenes[0].id, text: 'ひとつめ', start: 0.2, audio: null, duration: null },
    { id: 'n02', scene: tl.scenes[0].id, text: 'ふたつめ', start: 1.5, audio: null, duration: null },
  ];
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(tl));
  const lines = 2;
  assert.equal(run('gemini.mjs', 'consent', dir, '--yes', '--quote', 'はい').status, 0);
  const bgm = run('gemini.mjs', 'bgm', dir, '--prompt', 'calm piano 96 bpm');
  assert.equal(bgm.status, 1);
  assert.match(bgm.stderr, /有料の API を 1 回/);
  const nar = run('narration.mjs', dir, '--engine', 'gemini', '--voice', 'Kore');
  assert.equal(nar.status, 1);
  assert.match(nar.stderr, new RegExp(`有料の API を ${lines} 回`));
  assert.ok(!fs.existsSync(path.join(dir, 'audio', 'bgm.wav')));
});

test('project.mjs: course と intent を記録し、宣言できない点検は終了コード 1', () => {
  const dir = tmpProject();
  run('project.mjs', 'init', dir, '--title', 't');
  const c = run('project.mjs', 'course', dir, 'sample');
  assert.equal(c.status, 0, c.stderr);
  assert.equal(readProject(dir).settings.course, 'sample');
  const i = run('project.mjs', 'intent', dir, '--check', 'contrast', '--why', '薄く敷く文字', '--scenes', 's01,s02');
  assert.equal(i.status, 0, i.stderr);
  assert.deepEqual(readProject(dir).settings.intent[0].scenes, ['s01', 's02']);
  assert.equal(run('project.mjs', 'intent', dir, '--check', 'determinism', '--why', 'x').status, 1);
  assert.equal(run('project.mjs', 'course', dir, 'fast').status, 1);
});
