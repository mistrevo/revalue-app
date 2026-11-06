// 制作フォルダと project.json の読み書きを、日本語と空白を含む一時フォルダで検証する
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GITIGNORE, STAGES, addIntent, approveGate, briefingFile, initProject, readProject, setCourse, setStage } from '../scripts/project.mjs';

function tmpProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nsms-proj-'));
  return path.join(root, '動画 テスト', '新製品 紹介');
}

test('initProject は必須ディレクトリと project.json を作る', () => {
  const dir = tmpProject();
  const p = initProject(dir, { title: '新製品紹介' });
  for (const d of ['assets', 'audio', 'src/scenes', 'reviews', 'out']) {
    assert.ok(fs.statSync(path.join(dir, d)).isDirectory(), d);
  }
  assert.ok(fs.existsSync(path.join(dir, 'project.json')));
  assert.equal(p.title, '新製品紹介');
  assert.equal(p.stage, 'setup');
  assert.ok(STAGES.includes(p.stage));
});

test('initProject を2回呼んでも createdAt は変わらず、上書きしない', () => {
  const dir = tmpProject();
  const a = initProject(dir, { title: '最初' });
  const b = initProject(dir, { title: '別名' });
  assert.equal(b.createdAt, a.createdAt);
  assert.equal(b.title, '最初');
});

test('initProject は .gitignore を置き、動画・wav・中間データを外す。既にある .gitignore は書き換えない', () => {
  const dir = tmpProject();
  initProject(dir, { title: 't' });
  const text = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert.equal(text, GITIGNORE);
  for (const line of ['out/*.mp4', 'audio/**/*.wav', 'out/.scenes/', 'reviews/.check-cache/', 'reviews/frames/', 'audio/.narration-partial/']) {
    assert.ok(text.split('\n').includes(line), line);
  }
  fs.writeFileSync(path.join(dir, '.gitignore'), 'mine\n');
  initProject(dir, { title: 't' });
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'mine\n');
});

test('approveGate と setStage は保存され、一時ファイルを残さない', () => {
  const dir = tmpProject();
  initProject(dir, { title: 't' });
  approveGate(dir, 'briefing', '了承');
  setStage(dir, 'briefing');
  const p = readProject(dir);
  assert.equal(new Date(p.gates.briefing.approvedAt).toISOString(), p.gates.briefing.approvedAt);
  assert.equal(p.gates.briefing.note, '了承');
  assert.equal(p.stage, 'briefing');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp')), []);
});

test('setStage は未知の段階を拒否する', () => {
  const dir = tmpProject();
  initProject(dir, { title: 't' });
  assert.throws(() => setStage(dir, 'nope'), /段階/);
});

test('初版の制作フォルダを読み替える', () => {
  const dir = tmpProject();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ title: 't', createdAt: 'x', stage: 'brief',
    gates: { brief: { approvedAt: '2026-10-21T00:00:00Z' } }, settings: { type: 'service-intro', fps: 30, ratios: ['16:9'], loop: false,
      audio: { narration: 'none', bgm: 'none', sfx: true } }, models: [] }));
  const p = readProject(dir);
  assert.equal(p.stage, 'briefing');
  assert.equal(p.gates.briefing.approvedAt, '2026-10-21T00:00:00Z');
  assert.equal(p.gates.brief, undefined);
  assert.equal(p.settings.course, 'full');
  assert.equal(p.settings.kind, 'サービス紹介');
  assert.equal(p.settings.type, undefined);
});

test('brief の名前でも承認と段階を受け付ける', () => {
  const dir = tmpProject();
  initProject(dir, { title: 't' });
  approveGate(dir, 'brief');
  setStage(dir, 'brief');
  const p = readProject(dir);
  assert.ok(p.gates.briefing.approvedAt);
  assert.equal(p.stage, 'briefing');
});

test('briefingFile は brief.md しか無ければそれを返す', () => {
  const dir = tmpProject();
  initProject(dir, { title: 't' });
  fs.writeFileSync(path.join(dir, 'brief.md'), '#');
  assert.equal(path.basename(briefingFile(dir)), 'brief.md');
  fs.writeFileSync(path.join(dir, 'briefing.md'), '#');
  assert.equal(path.basename(briefingFile(dir)), 'briefing.md');
});

test('plan の承認は3つの関門を via: plan で承認する', () => {
  const dir = tmpProject();
  initProject(dir, { title: 't' });
  setCourse(dir, 'sample');
  approveGate(dir, 'plan');
  const p = readProject(dir);
  for (const g of ['briefing', 'style', 'storyboard']) assert.equal(p.gates[g].via, 'plan');
  assert.ok(p.gates.plan.approvedAt);
});

test('本番に上げると plan でまとめた承認と省いた印を外し、履歴に残す', () => {
  const dir = tmpProject();
  initProject(dir, { title: 't' });
  setCourse(dir, 'sample');
  approveGate(dir, 'plan');
  setCourse(dir, 'full');
  const p = readProject(dir);
  for (const g of ['briefing', 'style', 'storyboard', 'plan', 'rough']) assert.equal(p.gates[g], undefined, g);
  assert.ok(p.gateHistory.some((h) => h.gate === 'briefing' && h.record.via === 'plan'));
  assert.ok(p.gateHistory.some((h) => h.gate === 'plan'));
  assert.equal(p.settings.course, 'full');
});

test('コースを下げると、未承認でそのコースに無い関門を「省いた」と記録する', () => {
  const dir = tmpProject();
  initProject(dir, { title: 't' });
  approveGate(dir, 'briefing');
  setCourse(dir, 'trial');
  const p = readProject(dir);
  assert.ok(p.gates.briefing.approvedAt);
  assert.equal(p.gates.style.skipped, true);
  assert.equal(p.gates.rough.skipped, true);
  assert.equal(p.gates.deliver, undefined);
  assert.throws(() => setCourse(dir, 'fast'), /コース/);
});

test('意図の宣言は日時と段階を残し、宣言できない点検は断る', () => {
  const dir = tmpProject();
  initProject(dir, { title: 't' });
  setStage(dir, 'build');
  addIntent(dir, { check: 'flash', why: 'サイバーな演出', scenes: ['s02'] });
  const it = readProject(dir).settings.intent[0];
  assert.equal(it.check, 'flash');
  assert.equal(it.stage, 'build');
  assert.ok(it.addedAt);
  assert.deepEqual(it.scenes, ['s02']);
  assert.throws(() => addIntent(dir, { check: 'text-mismatch', why: 'x' }), /宣言できません/);
  assert.throws(() => addIntent(dir, { check: 'flash', why: '  ' }), /理由/);
});

test('新しく作る制作フォルダは course: full、kind は空、fps 30', () => {
  const dir = tmpProject();
  const p = initProject(dir, { title: 't' });
  assert.equal(p.settings.course, 'full');
  assert.equal(p.settings.kind, '');
  assert.equal(p.settings.fps, 30);
  assert.equal(p.settings.type, undefined);
});

test('構成の確認（plan）の承認は、サンプルのコースのときだけ受け付ける', () => {
  const dir = tmpProject();
  initProject(dir, { title: 't' });
  assert.throws(() => approveGate(dir, 'plan'), /サンプル/);
  setCourse(dir, 'sample');
  approveGate(dir, 'plan');
  assert.ok(readProject(dir).gates.plan.approvedAt);
});
