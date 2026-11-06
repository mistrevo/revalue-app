// 同じ制作フォルダで書き出し・点検を重ねて走らせないための鍵（lock.mjs）と、途中の様子の記録
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { acquireLock, beginRun, lockFile, progressFile } from '../scripts/lock.mjs';
import { copyTree } from '../scripts/paths.mjs';

const SCRIPTS = fileURLToPath(new URL('../scripts/', import.meta.url));
const SAMPLE = fileURLToPath(new URL('./fixtures/sample/', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nsms 鍵-'));

test('動いている実行の鍵があれば断り、終われば（release）また取れる', () => {
  const dir = tmp();
  const release = acquireLock(dir, 'render.mjs');
  assert.ok(fs.existsSync(lockFile(dir)));
  assert.throws(() => acquireLock(dir, 'assemble.mjs'), /render\.mjs.*実行中/);
  release();
  assert.ok(!fs.existsSync(lockFile(dir)));
  acquireLock(dir, 'assemble.mjs')();
});

test('鍵を残したまま終わった実行（プロセスがもう無い、または古すぎる）の鍵は取り直す', () => {
  const dir = tmp();
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  fs.mkdirSync(path.dirname(lockFile(dir)), { recursive: true });
  fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: dead, label: 'render.mjs', startedAt: new Date().toISOString() }));
  acquireLock(dir, 'assemble.mjs')();
  fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: process.pid, label: 'render.mjs', startedAt: new Date(Date.now() - 7 * 3600e3).toISOString() }));
  acquireLock(dir, 'assemble.mjs')();
  // 壊れた鍵も取り直す
  fs.writeFileSync(lockFile(dir), '{');
  acquireLock(dir, 'assemble.mjs')();
});

test('beginRun は途中の様子を out/progress.log に書き、終わりの行を足す', () => {
  const dir = tmp();
  const run = beginRun(dir, 'render.mjs');
  run.log('s01（16:9）: 30/45');
  run.end(0);
  const text = fs.readFileSync(progressFile(dir), 'utf8');
  assert.match(text, /render\.mjs を始めました/);
  assert.match(text, /s01（16:9）: 30\/45/);
  assert.match(text, /終わりました（終了コード 0）/);
  assert.ok(!fs.existsSync(lockFile(dir)));
});

test('実行中の制作フォルダでは、render.mjs・assemble.mjs・check.mjs は何もせずに断る', () => {
  const dir = tmp();
  copyTree(SAMPLE, dir);
  fs.mkdirSync(path.dirname(lockFile(dir)), { recursive: true });
  fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: process.pid, label: 'assemble.mjs', startedAt: new Date().toISOString() }));
  for (const [name, ...args] of [['render.mjs'], ['assemble.mjs', '--preset', 'draft'], ['check.mjs']]) {
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, name), dir, ...args], { encoding: 'utf8' });
    assert.equal(r.status, name === 'check.mjs' ? 4 : 1, `${name}: ${r.stderr}`); // 点検が動かなかったときは 4
    assert.match(r.stderr, /assemble\.mjs.*実行中/, name);
  }
  assert.ok(!fs.existsSync(path.join(dir, 'out/.scenes')));
  // 見込みだけなら書き出さないので断らない
  assert.equal(spawnSync(process.execPath, [path.join(SCRIPTS, 'render.mjs'), dir, '--estimate'], { encoding: 'utf8' }).status, 0);
});
