// 公開後に残した問題の点検（ブラウザも ffmpeg も使わない）。
// 鍵で断られた --waive の終了コード、途中の様子の記録を消さない、上書きのやり直しは Windows だけ、
// 確認ページの開き方（カンマ）、読み上げの入れ替えの失敗の案内、README の写しでのリンク、宣言した要素の数、本番に上げた後の止め時。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { recordRun, stopAdvice } from '../scripts/check.mjs';
import { beginRun, progressFile } from '../scripts/lock.mjs';
import { copyTree, removeTree, replaceFile } from '../scripts/paths.mjs';
import { approveGate, initProject, setCourse } from '../scripts/project.mjs';
import { buildReviewPage, openArgs } from '../scripts/review-page.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPTS = path.join(ROOT, 'scripts');
const SAMPLE = fileURLToPath(new URL('./fixtures/sample/', import.meta.url));
const run = (name, ...args) => spawnSync(process.execPath, [path.join(SCRIPTS, name), ...args], { encoding: 'utf8' });

function copySample() {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nsms 残り-')), '新製品 紹介');
  copyTree(SAMPLE, dir);
  return dir;
}

test('check --waive がほかの実行中で断られたら、終了コード 4（点検が動かなかった）', () => {
  const dir = copySample();
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'out', '.lock'), JSON.stringify({ pid: process.pid, label: 'render.mjs', startedAt: new Date().toISOString() }));
  const r = run('check.mjs', dir, '--waive', '1', '--why', 'x');
  assert.equal(r.status, 4, r.stderr);
  // 使い方の誤りは 1 のまま
  fs.unlinkSync(path.join(dir, 'out', '.lock'));
  assert.equal(run('check.mjs', dir, '--waive', 'x').status, 1);
});

test('beginRun は途中の様子の記録を消さずに足していく（前の書き出しの記録が残る）', () => {
  const dir = copySample();
  const a = beginRun(dir, 'render.mjs');
  a.log('s01: 30/45');
  a.end(0);
  const b = beginRun(dir, 'mix.mjs');
  b.end(0);
  const text = fs.readFileSync(progressFile(dir), 'utf8');
  assert.match(text, /render\.mjs を始めました[\s\S]*s01: 30\/45[\s\S]*mix\.mjs を始めました/);
});

test('replaceFile のやり直しは Windows だけ。ほかの OS の権限の誤りはすぐにそのまま投げる', () => {
  let n = 0;
  const denied = () => { n++; throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); };
  assert.throws(() => replaceFile('a', 'b', { rename: denied, waitMs: 1, platform: 'linux' }), /EACCES/);
  assert.equal(n, 1);
  n = 0;
  assert.throws(() => replaceFile('a', 'b', { rename: denied, waitMs: 1, platform: 'win32' }), /閉じて/);
  assert.ok(n > 1);
});

test('openArgs: Windows ではパスを引用符で囲んで渡す（カンマで区切られない。シェルは通さない）', () => {
  const abs = 'C:\\作業\\a,b\\reviews\\deliver.html';
  const [cmd, args, extra] = openArgs(abs, 'win32');
  assert.equal(cmd, 'explorer.exe');
  assert.deepEqual(args, [`"${abs}"`]);
  assert.equal(extra.windowsVerbatimArguments, true);
  assert.ok(!extra.shell);
});

test('読み上げは、声の入れ替えが途中で止まったら、もう一度実行すれば作り直さずに入れ替えをやり直せると知らせる', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'narration.mjs'), 'utf8');
  assert.match(src, /入れ替えの途中で止まりました/);
});

test('プラグインの README は、紹介ページを GitHub の場所でも示す', () => {
  const md = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(md, /https:\/\/github\.com\/nextscape\/ns-skills\/(tree|blob)\/main\/plugins\/ns-motion-studio\/docs\/intro/);
});

test('確認ページの「シーンの中で外した箇所」に、宣言した要素の数を出す', () => {
  const dir = copySample();
  initProject(dir, { title: '見本' });
  fs.mkdirSync(path.join(dir, 'reviews'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'reviews/intent-seen.json'), JSON.stringify([{ scene: 's01', check: 'contrast', firstSeenAt: 'x', count: 3 }]));
  const html = fs.readFileSync(buildReviewPage(dir, 'deliver'), 'utf8');
  assert.match(html, /要素 3 個/);
});

test('本番に上げて plan の承認が外れても、止め時の数え直しの基準は前に戻らない', () => {
  const dir = copySample();
  initProject(dir, { title: 't' });
  setCourse(dir, 'sample');
  approveGate(dir, 'plan');
  // plan の承認の後に3回同じ指摘で落ちても、本番に上げた（数え直し）後の回だけを数える
  const f = [{ check: 'hold', cut: 1, t: 0, message: 'm', id: 'hold|x', ratio: '16:9' }];
  const t0 = Date.now();
  recordRun(dir, 'build', f, ['16:9'], new Date(t0 + 1000).toISOString());
  recordRun(dir, 'build', f, ['16:9'], new Date(t0 + 2000).toISOString());
  const p = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  // 本番に上げた時刻を、2回目の後にする
  setCourse(dir, 'full');
  const q = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  for (const h of q.gateHistory) h.until = new Date(t0 + 2500).toISOString();
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(q));
  recordRun(dir, 'build', f, ['16:9'], new Date(t0 + 3000).toISOString());
  assert.equal(stopAdvice(dir, 'build'), null, JSON.stringify(p.gates));
});

test('removeTree と copyTree は、日本語と空白を含むパスでも中身ごと消す・写す（Node の rmSync・cpSync の recursive は Windows で落ちる版がある）', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nsms 制作-'));
  const src = path.join(base, '素材 1');
  fs.mkdirSync(path.join(src, '下の階層'), { recursive: true });
  fs.writeFileSync(path.join(src, 'a.txt'), 'a');
  fs.writeFileSync(path.join(src, '下の階層', 'ｂ.txt'), 'b');
  const dst = path.join(base, '写し 2');
  copyTree(src, dst);
  assert.equal(fs.readFileSync(path.join(dst, '下の階層', 'ｂ.txt'), 'utf8'), 'b');
  removeTree(base);
  assert.ok(!fs.existsSync(base));
  removeTree(base); // 無ければ何もしない
});
