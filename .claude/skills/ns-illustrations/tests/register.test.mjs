// 登録の CLI（scripts/register.mjs）。個人の素材集はホームの下なので、HOME と USERPROFILE を一時フォルダへ向けて起動する。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, it } from 'node:test';
import { openLibrary } from '../scripts/library.mjs';
import { SHARED_DIR } from '../scripts/paths.mjs';
import { swapFace } from '../scripts/variants.mjs';

const REGISTER = fileURLToPath(new URL('../scripts/register.mjs', import.meta.url));
const charSvg = (tag) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 760" width="400" height="760"><defs></defs><g data-part="head"><g data-part="face"><path d="${tag}"/></g></g></svg>`;

let home = '';
let personal = '';
/** @type {string[]} */
let sharedFiles = [];
/** @type {Map<string, number>} */
let mtimes = new Map();
let run = /** @type {import('node:child_process').SpawnSyncReturns<string>} */ (/** @type {unknown} */ (null));

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-illustrations-home-'));
  personal = path.join(home, '.claude/ns-illustrations/illustrations');
  fs.mkdirSync(personal, { recursive: true });
  // 共有の pm ロールに新しいポーズを足す（顔の元 char-pm-stand-side-right-smile は共有にだけある）
  fs.writeFileSync(path.join(personal, 'char-pm-zz-side-right-normal.svg'), charSvg('zz'));
  fs.writeFileSync(path.join(personal, 'char-pm-zz-side-right-smile.svg'), charSvg('zz'));
  sharedFiles = fs.readdirSync(SHARED_DIR);
  mtimes = new Map(sharedFiles.map((f) => [f, fs.statSync(path.join(SHARED_DIR, f)).mtimeMs]));
  run = spawnSync(process.execPath, [REGISTER], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
});
after(() => fs.rmSync(home, { recursive: true, force: true }));

it('node register.mjs は個人の素材集へ派生と catalog.md・gallery.html を書き出す', () => {
  assert.equal(run.status, 0, run.stderr);
  for (const f of ['char-pm-zz-side-left-normal.svg', 'char-pm-zz-side-left-smile.svg', 'catalog.md', 'gallery.html']) {
    assert.ok(fs.existsSync(path.join(personal, f)), f);
  }
  // 表情違いの顔は共有の立ちポーズから取る
  const smile = fs.readFileSync(path.join(personal, 'char-pm-zz-side-right-smile.svg'), 'utf8');
  assert.ok(smile.includes('data-part="face"'));
  assert.equal(smile.includes('d="zz"'), false);
});

it('個人の catalog と gallery は個人由来の名前だけを並べる', () => {
  const catalog = fs.readFileSync(path.join(personal, 'catalog.md'), 'utf8');
  assert.match(catalog, /素材 4 点/);
  assert.ok(catalog.includes('register.mjs'));
  // 個人の素材集に style-guide.md は無いので、相対リンクにしない
  assert.equal(catalog.includes('](style-guide.md)'), false);
  assert.ok(catalog.includes('プラグインの assets/illustrations/style-guide.md'));
  // 部品の表の見出しは、実際に基準にした絵の名前
  assert.ok(catalog.includes('| pm（char-pm-zz-side-right-normal） |'));
  assert.equal(catalog.includes('stand-normal'), false);
  assert.ok(catalog.includes('| zz | — | normal smile | normal smile |'));
  assert.equal(catalog.includes('| stand |'), false);
  const gallery = fs.readFileSync(path.join(personal, 'gallery.html'), 'utf8');
  assert.ok(gallery.includes('char-pm-zz-side-right-normal'));
  assert.equal(gallery.includes('char-pm-stand-normal'), false);
  assert.ok(gallery.includes('プラグインの assets/illustrations/style-guide.md'));
});

it('共有の素材集のファイルは増えも更新もされない', () => {
  assert.deepEqual(fs.readdirSync(SHARED_DIR), sharedFiles);
  const touched = sharedFiles.filter((f) => fs.statSync(path.join(SHARED_DIR, f)).mtimeMs !== mtimes.get(f));
  assert.deepEqual(touched, []);
});

it('個人の素材集のフォルダが無ければ作る', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-illustrations-home-'));
  try {
    const r = spawnSync(process.execPath, [REGISTER], { env: { ...process.env, HOME: empty, USERPROFILE: empty }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(empty, '.claude/ns-illustrations/illustrations/catalog.md')));
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

/** 一時フォルダのホームで register.mjs を起動する */
const runIn = (/** @type {string} */ dir) =>
  spawnSync(process.execPath, [REGISTER], { env: { ...process.env, HOME: dir, USERPROFILE: dir }, encoding: 'utf8' });

it('個人で描き直した顔を消して登録し直すと、作り直した派生が共有と同じになって消え、読み出しは共有に戻る', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-illustrations-home-'));
  const mine = path.join(dir, '.claude/ns-illustrations/illustrations');
  try {
    fs.mkdirSync(mine, { recursive: true });
    // 共有の char-pm-xr-smile は char-pm-stand-smile から顔を取る
    fs.writeFileSync(path.join(mine, 'char-pm-stand-smile.svg'), charSvg('redrawn'));
    const first = runIn(dir);
    assert.equal(first.status, 0, first.stderr);
    assert.ok(fs.readFileSync(path.join(mine, 'char-pm-xr-smile.svg'), 'utf8').includes('d="redrawn"'));

    fs.rmSync(path.join(mine, 'char-pm-stand-smile.svg'));
    const second = runIn(dir);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /削除: 共有と同じ派生 char-pm-xr-smile/);
    assert.equal(fs.existsSync(path.join(mine, 'char-pm-xr-smile.svg')), false);
    const lib = openLibrary({ shared: SHARED_DIR, personal: mine });
    assert.equal(lib.origin('char-pm-xr-smile'), 'shared');
    assert.match(fs.readFileSync(path.join(mine, 'catalog.md'), 'utf8'), /素材 0 点/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('命名規則に合わない素材は、メッセージだけを出して終了コード 1 で止まる', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-illustrations-home-'));
  const mine = path.join(dir, '.claude/ns-illustrations/illustrations');
  try {
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, 'obj-q-side-left.svg'), '<svg viewBox="0 0 10 10"><defs></defs></svg>');
    const r = runIn(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /obj-q-side-left\.svg/);
    assert.equal(r.stderr.includes('at '), false, r.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('共有のポーズに個人で表情の置き場を足すと、顔を差し替えて個人に残す', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-illustrations-home-'));
  const mine = path.join(dir, '.claude/ns-illustrations/illustrations');
  const sharedSvg = (/** @type {string} */ n) => fs.readFileSync(path.join(SHARED_DIR, n + '.svg'), 'utf8');
  try {
    // 共有の char-pm-sit には -smile が無く、共有の char-pm-stand-smile に顔がある
    assert.equal(fs.existsSync(path.join(SHARED_DIR, 'char-pm-sit-smile.svg')), false);
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, 'char-pm-sit-smile.svg'), sharedSvg('char-pm-sit-normal'));
    const r = runIn(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.includes('削除:'), false, r.stdout);
    assert.equal(
      fs.readFileSync(path.join(mine, 'char-pm-sit-smile.svg'), 'utf8'),
      swapFace(sharedSvg('char-pm-sit-normal'), 'char-pm-sit-normal', sharedSvg('char-pm-stand-smile'), 'char-pm-sit-smile'),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('個人で描き直して登録すると、その絵から作った派生を fill.mjs が個人の素材集から埋める', () => {
  const FILL = fileURLToPath(new URL('../scripts/fill.mjs', import.meta.url));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-illustrations-home-'));
  const mine = path.join(dir, '.claude/ns-illustrations/illustrations');
  const deck = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-illustrations-deck-'));
  try {
    fs.mkdirSync(mine, { recursive: true });
    // 共有の char-pm-xr-smile は char-pm-stand-smile から顔を取る派生
    fs.writeFileSync(path.join(mine, 'char-pm-stand-smile.svg'), charSvg('redrawn'));
    const reg = runIn(dir);
    assert.equal(reg.status, 0, reg.stderr);
    const slide = path.join(deck, '01-a.html');
    fs.writeFileSync(slide, '<svg data-illust="char-pm-xr-smile"></svg>');
    const r = spawnSync(process.execPath, [FILL, slide], { env: { ...process.env, HOME: dir, USERPROFILE: dir }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.split('\n').filter((l) => l.trim() === '個人の素材集: char-pm-xr-smile').length, 1, r.stdout);
    assert.ok(fs.readFileSync(slide, 'utf8').includes('d="redrawn"'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(deck, { recursive: true, force: true });
  }
});
