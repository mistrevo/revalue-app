// Gemini の読み上げ・曲づくりを偽の fetch で検証する（応答の形は公式ドキュメント 2026-10-21 のもの）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NOTICE_EXTERNAL_API, composeBgm, geminiTts, lyriaCompose, recordConsent } from '../scripts/gemini.mjs';
import { initProject, readProject } from '../scripts/project.mjs';
import { pcm16ToWav, readWavBuffer } from '../scripts/wav.mjs';

const reply = (data) => new Response(JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'text', text: 'ok' }, { type: 'audio', data: data.toString('base64') }] }] }));

test('geminiTts はキーのヘッダを付け、PCM から 24kHz の WAV を作る', async () => {
  let seen;
  const pcm = Buffer.alloc(48000); // 1 秒
  const fakeFetch = async (url, init) => {
    seen = { url: String(url), init, body: JSON.parse(init.body) };
    return reply(pcm);
  };
  const wav = await geminiTts('こんにちは', { voice: 'Kore', apiKey: 'k-123', fetch: fakeFetch });
  assert.equal(seen.url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.equal(seen.init.headers['x-goog-api-key'], 'k-123');
  assert.equal(seen.body.model, 'gemini-3.8-flash-tts');
  assert.equal(seen.body.input[0].content[0].text, 'こんにちは');
  assert.deepEqual(seen.body.generation_config.speech_config, [{ voice: 'Kore' }]);
  assert.equal(seen.body.response_format.mime_type, 'audio/l16');
  const r = readWavBuffer(wav);
  assert.equal(r.sampleRate, 24000);
  assert.equal(r.duration, 1);
});

test('キーが無いときは日本語で失敗する', async () => {
  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    await assert.rejects(geminiTts('あ', { voice: 'Kore', fetch: async () => reply(Buffer.alloc(2)) }), /GEMINI_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
  }
});

test('lyriaCompose は instrumental を必ず含める', async () => {
  let body;
  const wav = pcm16ToWav(Buffer.alloc(8), { sampleRate: 48000, channels: 2 });
  const out = await lyriaCompose('明るいピアノ 100 BPM', { apiKey: 'k', fetch: async (u, init) => { body = JSON.parse(init.body); return reply(wav); } });
  assert.equal(body.model, 'lyria-3.5');
  assert.match(body.input, /instrumental/i);
  assert.equal(body.response_format.type, 'audio');
  assert.deepEqual(out, wav);
});

test('WAV の指定が拒まれたら既定の形式で頼み直す', async () => {
  const bodies = [];
  const wav = pcm16ToWav(Buffer.alloc(8), { sampleRate: 48000, channels: 2 });
  const fakeFetch = async (u, init) => {
    bodies.push(JSON.parse(init.body));
    return bodies.length === 1 ? new Response('bad', { status: 400 }) : reply(wav);
  };
  await lyriaCompose('x instrumental', { apiKey: 'k', fetch: fakeFetch });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].response_format.mime_type, undefined);
});

test('composeBgm は同意が無いと止まり、同意後は bgm.wav と timeline.bgm と models を書く', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nsms-bgm-')), '制作 1');
  initProject(dir, { title: 't' });
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify({ version: 1, fps: 30, scenes: [], texts: [], narration: [], sfx: [], bgm: null }));
  const wav = pcm16ToWav(Buffer.alloc(16), { sampleRate: 48000, channels: 2 });
  const fakeFetch = async () => reply(wav);
  await assert.rejects(composeBgm(dir, { prompt: 'x', apiKey: 'k', fetch: fakeFetch }), /外部.*同意/);

  recordConsent(dir, { quote: 'はい、Gemini を使ってください' });
  assert.equal(readProject(dir).externalApiConsent.notice, NOTICE_EXTERNAL_API);
  const tl = await composeBgm(dir, { prompt: '穏やかなピアノ 96 BPM', seconds: 60, approved: true, apiKey: 'k', fetch: fakeFetch, log: () => {} });
  assert.ok(fs.existsSync(path.join(dir, 'audio', 'bgm.wav')));
  assert.deepEqual(tl.bgm, { file: 'audio/bgm.wav', bpm: 96, gain: -18, source: 'lyria-3.5', license: 'Gemini API 生成物（SynthID 透かし入り）' });
  const p = readProject(dir);
  assert.equal(p.models.at(-1).kind, 'music');
  assert.match(p.models.at(-1).prompt, /instrumental/i);
  assert.ok(!JSON.stringify(p).includes('k-secret'));
});

test('NOTICE_EXTERNAL_API は spec の6項目を含む', () => {
  assert.equal(NOTICE_EXTERNAL_API.split('\n').length, 6);
  for (const s of ['無料枠では、送った内容が Google の製品改善に使われ', 'VOICEVOX（ローカル）を勧める', '$0.08', '補償は確認できていない', '実在の人物の声は指定しない', '「人が作った」と偽らない']) {
    assert.ok(NOTICE_EXTERNAL_API.includes(s), s);
  }
});

test('recordConsent は利用者本人の言葉（quote）が無いと記録しない。あれば言葉と日時を残す', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nsms-consent-')), '制作 1');
  initProject(dir, { title: 't' });
  assert.throws(() => recordConsent(dir), /利用者.*言葉/);
  assert.throws(() => recordConsent(dir, { quote: '  ' }), /利用者.*言葉/);
  assert.equal(readProject(dir).externalApiConsent ?? null, null);
  recordConsent(dir, { quote: 'はい、了承します' });
  const c = readProject(dir).externalApiConsent;
  assert.equal(c.quote, 'はい、了承します');
  assert.match(c.date, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(c.notice, NOTICE_EXTERNAL_API);
});

test('composeBgm は同意があっても、この実行の了承（approved）が無ければ、回数を示して通信せずに止まる', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nsms-bgm-')), '制作 1');
  initProject(dir, { title: 't' });
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify({ version: 1, fps: 30, scenes: [], texts: [], narration: [], sfx: [], bgm: null }));
  recordConsent(dir, { quote: 'はい' });
  let calls = 0;
  await assert.rejects(composeBgm(dir, { prompt: 'x', apiKey: 'k', fetch: async () => { calls++; return reply(Buffer.alloc(2)); } }), /有料の API を 1 回.*--approved/s);
  assert.equal(calls, 0);
});

test('Lyria の2回目は、要求を断られた（HTTP 400）ときだけ。429 や 500 では1回で止める（見せた回数を超えない）', async () => {
  for (const status of [401, 429, 500]) {
    let calls = 0;
    await assert.rejects(lyriaCompose('x instrumental', { apiKey: 'k', fetch: async () => { calls++; return new Response('no', { status }); } }), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 1, `HTTP ${status}`);
  }
});

test('CLI: --prompt の値が無く、次が --approved のときは、了承とみなさず --prompt が要ると断る', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nsms-gem-')), '制作');
  initProject(dir, { title: 't' });
  const script = new URL('../scripts/gemini.mjs', import.meta.url);
  const r = spawnSync(process.execPath, [script.pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'bgm', dir, '--prompt', '--approved'], { encoding: 'utf8', env: { ...process.env, GEMINI_API_KEY: '' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--prompt が必要です/);
});
