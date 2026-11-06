// 道具の入れ方（setup-tools.mjs）。通信せずに、入れる版と置き場だけを確かめる
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromeCacheDir, toolsDir } from '../scripts/paths.mjs';
import { installCommand, installEnv, LOCK_DIR, outdatedTools, setupTools, TOOL_PACKAGES, TOOL_VERSIONS } from '../scripts/setup-tools.mjs';
import { filterScriptArgs, useToolsChrome } from '../scripts/tools.mjs';

test('入れる道具の版は、試した版に固定してある', () => {
  assert.deepEqual(TOOL_PACKAGES, ['puppeteer', 'ffmpeg-static', 'ffprobe-static']);
  assert.deepEqual(TOOL_VERSIONS, { puppeteer: '25.15.0', 'ffmpeg-static': '5.3.0', 'ffprobe-static': '3.1.0' });
  // 依存の依存まで固定するため、プラグインに同梱した package-lock.json を写して npm ci で入れる
  const pkg = JSON.parse(fs.readFileSync(path.join(LOCK_DIR, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies, TOOL_VERSIONS);
  const lock = JSON.parse(fs.readFileSync(path.join(LOCK_DIR, 'package-lock.json'), 'utf8'));
  for (const [p, v] of Object.entries(TOOL_VERSIONS)) assert.equal(lock.packages[`node_modules/${p}`].version, v, p);
  assert.equal(installCommand('C:/x/tools'), 'npm ci --prefix "C:/x/tools"');
});

test('ブラウザ本体は道具置き場の chrome に入れる（PUPPETEER_CACHE_DIR。利用者が決めた値は変えない）', () => {
  const env = installEnv('/t/tools', { PATH: 'p' });
  assert.equal(env.PUPPETEER_CACHE_DIR, path.join('/t/tools', 'chrome'));
  assert.equal(env.PATH, 'p');
  assert.equal(chromeCacheDir(), path.join(toolsDir(), 'chrome'));
  assert.equal(installEnv('/t/tools', { PUPPETEER_CACHE_DIR: 'D:/mine' }).PUPPETEER_CACHE_DIR, 'D:/mine');
});

/** 試した版がそろった道具置き場の偽物（中身は package.json だけ） */
function fakeInstalled() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsms-tools-'));
  for (const [p, v] of Object.entries(TOOL_VERSIONS)) {
    fs.mkdirSync(path.join(dir, 'node_modules', p), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', p, 'package.json'), JSON.stringify({ version: v }));
  }
  return dir;
}
const quiet = { log: () => {}, error: () => {} };

test('setupTools: 道具はそろっていてもブラウザ本体が無ければ入れ、それでも無ければ 1 と取得先の案内', () => {
  const tools = fakeInstalled();
  const runs = [];
  const errors = [];
  const code = setupTools({ tools, env: {}, run: (r) => { runs.push(r); return 0; }, browser: () => null, ...quiet, error: (m) => errors.push(m) });
  assert.equal(code, 1);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].node.slice(-3), ['browsers', 'install', 'chrome-headless-shell']);
  assert.equal(runs[0].env.PUPPETEER_CACHE_DIR, path.join(tools, 'chrome'));
  assert.match(errors.join('\n'), /storage\.googleapis\.com/);
  assert.match(errors.join('\n'), /HTTPS_PROXY/);
});

test('setupTools: ブラウザ本体を入れて見つかれば 0。そろっていれば何も実行しない', () => {
  const tools = fakeInstalled();
  let has = false;
  const runs = [];
  assert.equal(setupTools({ tools, env: {}, run: (r) => { runs.push(r); has = true; return 0; }, browser: () => (has ? 'chrome.exe' : null), ...quiet }), 0);
  assert.equal(runs.length, 1);
  assert.equal(setupTools({ tools, env: {}, run: () => { throw new Error('呼ばない'); }, browser: () => 'chrome.exe', ...quiet }), 0);
});

test('setupTools: 道具が足りなければ、同梱の package.json と package-lock.json を写して npm ci で入れる', () => {
  const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'nsms-tools-'));
  const runs = [];
  const code = setupTools({ tools, env: {}, run: (r) => { runs.push(r); return 1; }, browser: () => null, ...quiet });
  assert.equal(code, 1, 'npm が失敗したら 1');
  assert.equal(runs[0].shell, `npm ci --prefix "${tools}"`);
  assert.ok(fs.existsSync(path.join(tools, 'package-lock.json')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tools, 'package.json'), 'utf8')).dependencies, TOOL_VERSIONS);
});

test('outdatedTools は、無い道具と版の違う道具を返す', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsms-tools-'));
  const put = (p, v) => {
    fs.mkdirSync(path.join(dir, 'node_modules', p), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', p, 'package.json'), JSON.stringify({ version: v }));
  };
  put('puppeteer', '24.0.0');
  put('ffmpeg-static', TOOL_VERSIONS['ffmpeg-static']);
  assert.deepEqual(outdatedTools(dir), ['puppeteer', 'ffprobe-static']);
});

test('useToolsChrome は、道具置き場に chrome があるときだけ PUPPETEER_CACHE_DIR をそこにする（利用者が決めた値は変えない）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsms-tools-'));
  const env = {};
  useToolsChrome(dir, env);
  assert.equal(env.PUPPETEER_CACHE_DIR, undefined, '無ければ、前の置き場（~/.cache/puppeteer）のまま');
  fs.mkdirSync(path.join(dir, 'chrome'));
  useToolsChrome(dir, env);
  assert.equal(env.PUPPETEER_CACHE_DIR, path.join(dir, 'chrome'));
  const own = { PUPPETEER_CACHE_DIR: 'D:/mine' };
  useToolsChrome(dir, own);
  assert.equal(own.PUPPETEER_CACHE_DIR, 'D:/mine');
});

test('filterScriptArgs: ffmpeg 7 より前は -filter_complex_script、7 以降と版の読めないものは -/filter_complex', () => {
  assert.deepEqual(filterScriptArgs('f.txt', 'ffmpeg version 6.1.1-essentials_build-www.gyan.dev Copyright'), ['-filter_complex_script', 'f.txt']);
  assert.deepEqual(filterScriptArgs('f.txt', 'ffmpeg version n6.0 Copyright'), ['-filter_complex_script', 'f.txt']);
  assert.deepEqual(filterScriptArgs('f.txt', 'ffmpeg version 7.0.2 Copyright'), ['-/filter_complex', 'f.txt']);
  assert.deepEqual(filterScriptArgs('f.txt', 'ffmpeg version 9.0.1-full_build-www.gyan.dev Copyright'), ['-/filter_complex', 'f.txt']);
  assert.deepEqual(filterScriptArgs('f.txt', 'ffmpeg version N-118000-g1234abcd Copyright'), ['-/filter_complex', 'f.txt']);
  assert.deepEqual(filterScriptArgs('f.txt', null), ['-/filter_complex', 'f.txt']);
});
