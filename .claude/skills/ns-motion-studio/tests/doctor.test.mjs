// diagnose を偽の exec / fetch / 道具置き場で検証する（ネットワークも実物の ffmpeg も使わない）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { describe, diagnose } from '../scripts/doctor.mjs';
import { TOOL_VERSIONS } from '../scripts/setup-tools.mjs';

const TOOLS = ['puppeteer', 'ffmpeg-static', 'ffprobe-static'];

/** 道具置き場の偽物を作る。入れるパッケージを選べる */
function fakeTools(pkgs, versions = TOOL_VERSIONS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsms-tools-'));
  for (const p of pkgs) {
    const d = path.join(dir, 'node_modules', p);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ version: versions[p] }));
  }
  if (pkgs.includes('ffmpeg-static')) {
    fs.writeFileSync(path.join(dir, 'node_modules/ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), '');
  }
  return dir;
}

const okExec = () => 'ffmpeg version 7';
const noExec = () => null;
const upFetch = async () => ({ ok: true });
const downFetch = async () => { throw new Error('refused'); };

function base(over = {}) {
  return { exec: okExec, fetch: downFetch, toolsDir: fakeTools(TOOLS), nodeVersion: 'v24.0.0', env: {}, browser: () => 'chrome-headless-shell.exe', ...over };
}

test('node が 18 なら node.ok も全体の ok も false', async () => {
  const r = await diagnose(base({ nodeVersion: 'v18.0.0' }));
  assert.equal(r.node.ok, false);
  assert.equal(r.node.need, '22.12.0');
  assert.equal(r.ok, false);
});

test('ffmpeg が PATH に無く tools に ffmpeg-static があれば bundled', async () => {
  const r = await diagnose(base({ exec: noExec }));
  assert.equal(r.ffmpeg.source, 'bundled');
  assert.equal(r.ffmpeg.ok, true);
  assert.equal(r.ok, true);
});

test('システムに ffmpeg があれば system', async () => {
  const r = await diagnose(base());
  assert.equal(r.ffmpeg.source, 'system');
});

test('ffmpeg がどこにも無ければ ok は false', async () => {
  const r = await diagnose(base({ exec: noExec, toolsDir: fakeTools(['puppeteer']) }));
  assert.equal(r.ffmpeg.ok, false);
  assert.equal(r.ffmpeg.source, null);
  assert.equal(r.ok, false);
});

test('道具が欠けていれば missing に出て ok は false', async () => {
  const r = await diagnose(base({ toolsDir: fakeTools(['ffmpeg-static', 'ffprobe-static']) }));
  assert.deepEqual(r.tools.missing, ['puppeteer']);
  assert.equal(r.tools.ok, false);
  assert.equal(r.ok, false);
});

test('VOICEVOX が応答すれば running、応答しなければ false', async () => {
  const urls = [];
  const r = await diagnose(base({ fetch: async (u) => { urls.push(String(u)); return { ok: true }; } }));
  assert.equal(r.voicevox.running, true);
  assert.equal(urls[0], 'http://127.0.0.1:50021/version');
  assert.equal((await diagnose(base())).voicevox.running, false);
});

test('GEMINI_API_KEY が空なら keySet は false だが全体の ok は変わらない', async () => {
  const r = await diagnose(base({ fetch: upFetch, env: { GEMINI_API_KEY: '' } }));
  assert.equal(r.gemini.keySet, false);
  assert.equal(r.ok, true);
  assert.equal((await diagnose(base({ env: { GEMINI_API_KEY: 'x' } }))).gemini.keySet, true);
});

test('describe: Gemini の説明に画像生成を含めず、案内は setup-tools.mjs の絶対パス', async () => {
  const bad = await diagnose(base({ toolsDir: fakeTools([]), exec: noExec }));
  const text = describe(bad);
  assert.ok(!text.includes('画像生成'));
  assert.ok(text.includes('ナレーション音声'));
  // ホームに空白があってもそのまま貼れるよう、引用符で囲む
  const m = /node "([^"]+setup-tools\.mjs)"/.exec(text);
  assert.ok(m && path.isAbsolute(m[1]));
  const withKey = describe(await diagnose(base({ env: { GEMINI_API_KEY: 'x' } })));
  assert.ok(!withKey.includes('画像生成') && withKey.includes('ナレーション音声と BGM'));
});

test('道具の版を出し、試した版と違えば outdated に出して ok は false（入れ直しを案内する）', async () => {
  const good = await diagnose(base());
  assert.deepEqual(good.tools.versions, TOOL_VERSIONS);
  assert.deepEqual(good.tools.outdated, []);
  const r = await diagnose(base({ toolsDir: fakeTools(TOOLS, { ...TOOL_VERSIONS, puppeteer: '26.0.0' }) }));
  assert.equal(r.tools.versions.puppeteer, '26.0.0');
  assert.deepEqual(r.tools.outdated, ['puppeteer']);
  assert.equal(r.tools.ok, false);
  assert.equal(r.ok, false);
  assert.match(describe(r), /puppeteer 26.0.0.*25.15.0/);
});

test('Node は 22.12 以上が必要（puppeteer 25 の求め）。小さい版まで比べる', async () => {
  assert.equal((await diagnose(base({ nodeVersion: 'v22.11.0' }))).node.ok, false);
  assert.equal((await diagnose(base({ nodeVersion: 'v22.12.0' }))).node.ok, true);
  assert.equal((await diagnose(base({ nodeVersion: 'v23.0.0' }))).node.ok, true);
  assert.match(describe(await diagnose(base({ nodeVersion: 'v20.18.0' }))), /22\.12\.0 以上/);
});

test('ブラウザ本体が無ければ ok は false で、入れ直しを案内する', async () => {
  const r = await diagnose(base({ browser: () => null }));
  assert.equal(r.browser.ok, false);
  assert.equal(r.ok, false);
  const text = describe(r);
  assert.match(text, /ブラウザ本体/);
  assert.match(text, /setup-tools\.mjs/);
  const good = await diagnose(base());
  assert.equal(good.browser.ok, true);
  assert.equal(good.browser.path, 'chrome-headless-shell.exe');
});
