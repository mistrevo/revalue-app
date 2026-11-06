// 効果音の合成と配置を検証する
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SFX_PRESETS, renderSfxTrack, synthSfx } from '../scripts/sfx.mjs';
import { pcm16ToWav, readWav, writeWav } from '../scripts/wav.mjs';

const peakOf = (chans) => Math.max(...chans.map((c) => c.reduce((m, v) => Math.max(m, Math.abs(v)), 0)));

test('どのプリセットも 2ch・短い・クリップしない・seed で決まる', () => {
  for (const p of SFX_PRESETS) {
    const a = synthSfx(p, { seed: 1 });
    assert.equal(a.length, 2, p);
    const sec = a[0].length / 48000;
    assert.ok(sec >= 0.05 && sec <= 1, `${p}: ${sec}`);
    assert.ok(peakOf(a) < 1.0, p);
    const b = synthSfx(p, { seed: 1 });
    assert.deepEqual(a[0], b[0], p);
    assert.deepEqual(a[1], b[1], p);
  }
  // seed が違えばノイズ系は別の波形になる
  assert.notDeepEqual(synthSfx('whoosh', { seed: 1 })[0], synthSfx('whoosh', { seed: 2 })[0]);
});

test('知らないプリセットは日本語で失敗する', () => {
  assert.throws(() => synthSfx('boom'), /知らない効果音/);
});

test('renderSfxTrack は t の 1 フレーム後に置く', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsms-sfx-'));
  const file = path.join(dir, 'sfx.wav');
  renderSfxTrack({ fps: 30, sfx: [{ id: 'x01', t: 1.0, preset: 'pop', gain: -6 }] }, file);
  const w = readWav(file);
  assert.equal(w.sampleRate, 48000);
  assert.equal(w.channels, 2);
  const first = w.data[0].findIndex((v) => v !== 0);
  assert.ok(Math.abs(first - 48000 * (1 + 1 / 30)) <= 48, `first=${first}`);
});

test('重なった効果音でもクリップしない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsms-sfx-'));
  const file = path.join(dir, 'sfx.wav');
  const sfx = SFX_PRESETS.map((preset, i) => ({ id: `x${i}`, t: 0.5, preset, gain: 0 }));
  renderSfxTrack({ fps: 30, sfx }, file);
  assert.ok(peakOf(readWav(file).data) < 1.0);
});

test('wav: 書いて読むと同じ形で戻り、pcm16ToWav は 24kHz のヘッダを付ける', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsms-wav-'));
  const file = path.join(dir, 'a.wav');
  const l = Float32Array.from([0, 0.5, -0.5, 0.25]);
  writeWav(file, { sampleRate: 48000, channels: 2, data: [l, l] });
  const r = readWav(file);
  assert.equal(r.channels, 2);
  assert.equal(r.data[0].length, 4);
  assert.ok(Math.abs(r.data[0][1] - 0.5) < 1e-3);
  const pcm = pcm16ToWav(Buffer.alloc(48000), { sampleRate: 24000, channels: 1 });
  assert.equal(pcm.readUInt32LE(24), 24000);
  fs.writeFileSync(file, pcm);
  assert.equal(readWav(file).duration, 1);
});
