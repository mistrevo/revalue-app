// ナレーションの生成と尺の調整を偽の fetch で検証する
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { recordConsent } from '../scripts/gemini.mjs';
import { synthesizeNarration } from '../scripts/narration.mjs';
import { applyReadings, readReadings } from '../scripts/readings.mjs';
import { initProject, readProject } from '../scripts/project.mjs';
import { removeFile, removeTree } from '../scripts/paths.mjs';
import { pcm16ToWav } from '../scripts/wav.mjs';

/** 指定秒の無音 WAV（24kHz モノ）。呼び出しごとに次の長さを返す */
function voicevoxFake(durations) {
  let i = 0;
  return async (url) => {
    const u = String(url);
    if (u.endsWith('/speakers')) return new Response(JSON.stringify([{ name: 'ずんだもん', styles: [{ name: 'ノーマル', id: 3 }] }]));
    if (u.includes('/audio_query')) return new Response('{}');
    return new Response(pcm16ToWav(Buffer.alloc(Math.round(durations[i++] * 24000) * 2), { sampleRate: 24000, channels: 1 }));
  };
}

function setup() {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nsms-nar-')), '制作 1');
  initProject(dir, { title: 't' });
  const tl = {
    version: 1, title: 't', fps: 30, ratios: ['16:9'], loop: false, seed: 1,
    scenes: [
      { id: 's01', start: 0, end: 3.2, purpose: 'a', file: 'src/scenes/s01.html' },
      { id: 's02', start: 3.2, end: 6.0, purpose: 'b', file: 'src/scenes/s02.html' },
    ],
    texts: [],
    narration: [
      { id: 'n01', scene: 's01', text: '一つめ', start: 0, audio: null, duration: null },
      { id: 'n02', scene: 's02', text: '二つめ', start: 3.2, audio: null, duration: null },
    ],
    sfx: [], bgm: null, poster: 0,
  };
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(tl));
  return dir;
}

test('VOICEVOX: 声に合わせてシーンを伸ばし、後続をずらし、シーンごとの長さの表を出す', async () => {
  const dir = setup();
  const logs = [];
  // 合成前の見積もりは「一つめ」3 文字 = 0.6 秒。s01 の余白は 3.2 - 0.6 = 2.6 秒、s02 は 6.0 - 3.8 = 2.2 秒
  const tl = await synthesizeNarration(dir, { engine: 'voicevox', speakerOrVoice: 3, fetch: voicevoxFake([4.1, 1.0]), log: (m) => logs.push(m) });
  assert.equal(tl.scenes[0].end, 6.7);
  assert.equal(tl.scenes[1].start, 6.7);
  assert.equal(tl.scenes[1].end, 9.9);
  assert.equal(tl.narration[0].duration, 4.1);
  assert.equal(tl.narration[0].audio, 'audio/narration/n01.wav');
  assert.equal(tl.narration[1].start, 6.7); // 後続のナレーションもずれる
  assert.ok(fs.existsSync(path.join(dir, 'audio', 'narration', 'n02.wav')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8')), tl);
  assert.deepEqual(readProject(dir).credits, ['VOICEVOX:ずんだもん']);
  assert.match(logs.join('\n'), /総尺 6 → 9\.9 秒/);
  assert.match(logs.join('\n'), /s01: 3\.2 → 6\.7 秒（\+3\.5）/);
});

test('作り直して声が短くなれば、前に伸ばしたシーンを縮める（伸びたまま残らない）', async () => {
  const dir = setup();
  await synthesizeNarration(dir, { engine: 'voicevox', speakerOrVoice: 3, fetch: voicevoxFake([4.1, 1.0]), log: () => {} });
  // 文も声も同じなので、作り直すには force を付ける
  const tl = await synthesizeNarration(dir, { engine: 'voicevox', speakerOrVoice: 3, force: true, fetch: voicevoxFake([1.0, 1.0]), log: () => {} });
  assert.equal(tl.scenes[0].end, 3.6);
  assert.equal(tl.scenes[1].start, 3.6);
  assert.equal(tl.narration[1].start, 3.6);
  assert.equal(tl.scenes[1].end, 6.8);
});

test('合成した長さで声が重なるときは、後ろの行を声の終わり + 0.5 秒へずらし、重なりを残さない', async () => {
  const dir = setup();
  const tlFile = path.join(dir, 'timeline.json');
  const tl0 = JSON.parse(fs.readFileSync(tlFile, 'utf8'));
  tl0.narration.splice(1, 0, { id: 'n03', scene: 's01', text: '三つめ', start: 1.0, audio: null, duration: null });
  fs.writeFileSync(tlFile, JSON.stringify(tl0));
  const warnings = [];
  const tl = await synthesizeNarration(dir, { engine: 'voicevox', speakerOrVoice: 3, fetch: voicevoxFake([2.0, 1.0, 1.0]), warn: (m) => warnings.push(m), log: () => {} });
  assert.equal(tl.narration.find((n) => n.id === 'n03').start, 2.5);
  assert.deepEqual(warnings, []);
});

test('BGM があれば、合わせ直しの後に BGM を確かめ直すよう知らせる', async () => {
  const dir = setup();
  const tlFile = path.join(dir, 'timeline.json');
  const tl0 = JSON.parse(fs.readFileSync(tlFile, 'utf8'));
  tl0.bgm = { file: 'audio/bgm.wav', bpm: 100, gain: -18 };
  fs.writeFileSync(tlFile, JSON.stringify(tl0));
  const warnings = [];
  await synthesizeNarration(dir, { engine: 'voicevox', speakerOrVoice: 3, fetch: voicevoxFake([2.0, 1.0]), warn: (m) => warnings.push(m), log: () => {} });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /BGM.*audio\.md/);
});

test('合わせ直した後も読み切れない文字があれば、時刻の点検の言葉で知らせる', async () => {
  const dir = setup();
  const tlFile = path.join(dir, 'timeline.json');
  const tl0 = JSON.parse(fs.readFileSync(tlFile, 'utf8'));
  // 声の中だけに出る長い文字（声が縮むと一緒に縮む）
  tl0.narration[0].duration = 3.0;
  tl0.texts.push({ id: 't09', scene: 's01', kind: 'caption', text: 'あいうえおかきくけこ', start: 0.2, end: 2.9 });
  fs.writeFileSync(tlFile, JSON.stringify(tl0));
  const warnings = [];
  await synthesizeNarration(dir, { engine: 'voicevox', speakerOrVoice: 3, fetch: voicevoxFake([1.0, 1.0]), warn: (m) => warnings.push(m), log: () => {} });
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], /t09.*読み切るには 2\.5 秒/);
});

test('Gemini は同意が無いと外部 API の同意を求める例外になる（通信もしない）', async () => {
  const dir = setup();
  let called = false;
  await assert.rejects(
    synthesizeNarration(dir, { engine: 'gemini', speakerOrVoice: 'Kore', apiKey: 'k', fetch: async () => { called = true; return new Response(''); } }),
    /外部.*同意/,
  );
  assert.equal(called, false);
});

test('Gemini: 同意があっても、この実行の了承（approved）が無ければ、行数ぶんの回数と文字数を示して通信せずに止まる', async () => {
  const dir = setup();
  recordConsent(dir, { quote: 'はい' });
  let calls = 0;
  await assert.rejects(
    synthesizeNarration(dir, { engine: 'gemini', speakerOrVoice: 'Kore', apiKey: 'k', fetch: async () => { calls++; return new Response(''); }, log: () => {} }),
    /有料の API を 2 回.*6 文字.*--approved/s,
  );
  assert.equal(calls, 0);
});

test('Gemini: 同意後は WAV を作り、models に記録する（キーは書かない）', async () => {
  const dir = setup();
  recordConsent(dir, { quote: 'はい、Gemini を使ってください' });
  const pcm = Buffer.alloc(24000 * 2); // 1 秒
  const fakeFetch = async () => new Response(JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: pcm.toString('base64') }] }] }));
  const tl = await synthesizeNarration(dir, { engine: 'gemini', speakerOrVoice: 'Kore', approved: true, apiKey: 'k-secret', fetch: fakeFetch, log: () => {} });
  assert.equal(tl.narration[0].duration, 1);
  const p = readProject(dir);
  assert.equal(p.models.at(-1).kind, 'tts');
  // 作り直すときに同じ声を選べるよう、声の名前も残す
  assert.equal(p.models.at(-1).voice, 'Kore');
  assert.ok(!JSON.stringify(p).includes('k-secret'));
});

test('VOICEVOX: 「名前/スタイル」で話者を引き、速さと抑揚を synthesis に渡し、models に声と値を残す', async () => {
  const dir = setup();
  const bodies = [];
  const inner = voicevoxFake([1.0, 1.0]);
  const fakeFetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/speakers')) {
      return new Response(JSON.stringify([
        { name: 'ずんだもん', styles: [{ name: 'ノーマル', id: 3 }] },
        { name: '四国めたん', styles: [{ name: 'ノーマル', id: 2 }, { name: 'あまあま', id: 0 }] },
      ]));
    }
    if (u.includes('/synthesis')) bodies.push({ url: u, body: JSON.parse(init.body) });
    return inner(url, init);
  };
  await synthesizeNarration(dir, { engine: 'voicevox', speakerOrVoice: '四国めたん/ノーマル', speed: 1.1, intonation: 1.2, fetch: fakeFetch, log: () => {} });
  assert.equal(bodies.length, 2);
  for (const b of bodies) {
    assert.match(b.url, /speaker=2$/);
    assert.equal(b.body.speedScale, 1.1);
    assert.equal(b.body.intonationScale, 1.2);
  }
  const p = readProject(dir);
  assert.deepEqual(p.credits, ['VOICEVOX:四国めたん']);
  const m = p.models.at(-1);
  assert.equal(m.kind, 'tts');
  assert.equal(m.model, 'voicevox');
  assert.equal(m.speaker, 2);
  assert.equal(m.voice, '四国めたん/ノーマル');
  assert.equal(m.character, '四国めたん');
  assert.equal(m.style, 'ノーマル');
  assert.equal(m.speed, 1.1);
  assert.equal(m.intonation, 1.2);
});

test('VOICEVOX: 声・速さ・抑揚を省くと、四国めたん/ノーマル・1.1・1.2 で作り、規約の場所と確かめた日を models に残す', async () => {
  const dir = setup();
  const bodies = [];
  const inner = voicevoxFake([1.0, 1.0]);
  const fakeFetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/speakers')) return new Response(JSON.stringify([{ name: '四国めたん', styles: [{ name: 'ノーマル', id: 2 }] }]));
    if (u.includes('/synthesis')) bodies.push({ url: u, body: JSON.parse(init.body) });
    return inner(url, init);
  };
  await synthesizeNarration(dir, { engine: 'voicevox', fetch: fakeFetch, log: () => {} });
  assert.equal(bodies.length, 2);
  for (const b of bodies) {
    assert.match(b.url, /speaker=2$/);
    assert.equal(b.body.speedScale, 1.1);
    assert.equal(b.body.intonationScale, 1.2);
  }
  const m = readProject(dir).models.at(-1);
  assert.deepEqual([m.voice, m.speed, m.intonation], ['四国めたん/ノーマル', 1.1, 1.2]);
  assert.equal(m.terms, 'https://zunko.jp/con_ongen_kiyaku.html');
  assert.match(m.termsChecked, /^\d{4}-\d{2}-\d{2}$/);
});

test('VOICEVOX: 使ってよい一覧に無いキャラクターは、何も作らずに止める', async () => {
  const dir = setup();
  const fakeFetch = async (url) => {
    if (String(url).endsWith('/speakers')) return new Response(JSON.stringify([{ name: '青山龍星', styles: [{ name: 'ノーマル', id: 13 }] }]));
    throw new Error('合成まで進んだ');
  };
  await assert.rejects(synthesizeNarration(dir, { engine: 'voicevox', speakerOrVoice: 13, fetch: fakeFetch, log: () => {} }), /青山龍星 は使えません/);
  assert.ok(!fs.existsSync(path.join(dir, 'audio', 'narration', 'n01.wav')));
});

test('VOICEVOX: 範囲の外の速さ・抑揚は、通信も書き込みもせずに日本語で断る', async () => {
  const dir = setup();
  let called = false;
  const f = async () => { called = true; return new Response('[]'); };
  await assert.rejects(synthesizeNarration(dir, { engine: 'voicevox', speakerOrVoice: 3, speed: 2.5, fetch: f }), /--speed.*0\.5〜2\.0/);
  await assert.rejects(synthesizeNarration(dir, { engine: 'voicevox', speakerOrVoice: 3, intonation: -1, fetch: f }), /--intonation.*0〜2\.0/);
  assert.equal(called, false);
  assert.ok(!fs.existsSync(path.join(dir, 'audio', 'narration')));
});

test('CLI: --speed が数でなければ、エンジンに触れずに日本語で終わる', () => {
  const dir = setup();
  const r = spawnSync(process.execPath, [path.join(import.meta.dirname, '../scripts/narration.mjs'), dir, '--engine', 'voicevox', '--speaker', '3', '--speed', '速め'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--speed（話す速さ）は 0\.5〜2\.0/);
});

test('Gemini に速さや抑揚を渡すと断る（使われないまま黙って進まない）', async () => {
  const dir = setup();
  recordConsent(dir, { quote: 'はい、Gemini を使ってください' });
  await assert.rejects(
    synthesizeNarration(dir, { engine: 'gemini', speakerOrVoice: 'Kore', speed: 1.2, apiKey: 'k', fetch: async () => new Response('') }),
    /--speed.*--intonation.*VOICEVOX/,
  );
});

/** 読みの辞書を audio/readings.json に書く */
function writeReadings(dir, entries) {
  fs.mkdirSync(path.join(dir, 'audio'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'audio', 'readings.json'), JSON.stringify(entries));
}

test('applyReadings は長い語から置き換え、英字の語はひとまとまりの語のときだけ置き換える', () => {
  const entries = [
    { surface: 'ns', reading: 'エヌエス' },
    { surface: 'ffmpeg', reading: 'エフエフエムペグ' },
    { surface: 'Node.js', reading: 'ノードジェイエス' },
    { surface: 'node', reading: 'ノード' },
    { surface: '章ごと', reading: 'しょうごと' },
  ];
  assert.equal(applyReadings('ns-skills の options を ffmpeg へ', entries), 'ns-skills の options を エフエフエムペグ へ');
  assert.equal(applyReadings('ns と ffmpeg.', entries), 'エヌエス と エフエフエムペグ.');
  assert.equal(applyReadings('Node.js と node と nodes', entries), 'ノードジェイエス と ノード と nodes');
  assert.equal(applyReadings('章ごとの連作', entries), 'しょうごとの連作');
  assert.equal(applyReadings('変えない文', []), '変えない文');
});

test('applyReadings は英字・数字・記号のつながった語の途中には当てない（その語そのものの見出しなら当てる）', () => {
  const entries = [
    { surface: 'v2', reading: 'ブイツー' },
    { surface: '.NET', reading: 'ドットネット' },
    { surface: 'NET', reading: 'ネット' },
    { surface: 'ns', reading: 'エヌエス' },
    { surface: 'ns-skills', reading: 'エヌエススキルズ' },
    { surface: 'json', reading: 'ジェイソン' },
  ];
  assert.equal(applyReadings('v2.1 と v2 へ', entries), 'v2.1 と ブイツー へ');
  assert.equal(applyReadings('ASP.NET と .NET と NET', entries), 'ASP.NET と ドットネット と ネット');
  assert.equal(applyReadings('dns と ns-skills と ns', entries), 'dns と エヌエススキルズ と エヌエス');
  assert.equal(applyReadings('timeline.json と（json）', entries), 'timeline.json と（ジェイソン）');
});

test('readReadings は同じ見出しが2回あれば、その語を挙げて日本語で断る', () => {
  const dir = setup();
  writeReadings(dir, [{ surface: 'ffmpeg', reading: 'エフエフエムペグ' }, { surface: 'ffmpeg', reading: 'エフエフエンペグ' }]);
  assert.throws(() => readReadings(dir), /readings\.json.*「ffmpeg」.*2 回/);
});

test('readReadings は無ければ空、形が違えば日本語で断る', () => {
  const dir = setup();
  assert.deepEqual(readReadings(dir), []);
  writeReadings(dir, [{ surface: 'ffmpeg', reading: 'エフエフエムペグ' }]);
  assert.deepEqual(readReadings(dir), [{ surface: 'ffmpeg', reading: 'エフエフエムペグ' }]);
  writeReadings(dir, [{ surface: 'ffmpeg' }]);
  assert.throws(() => readReadings(dir), /readings\.json.*surface.*reading/);
  fs.writeFileSync(path.join(dir, 'audio', 'readings.json'), '{壊れた');
  assert.throws(() => readReadings(dir), /readings\.json/);
});

test('VOICEVOX: 読みの辞書を当てた文で合成し、timeline の原稿と字幕は元の文のまま。models に辞書の語数を残す', async () => {
  const dir = setup();
  const tlFile = path.join(dir, 'timeline.json');
  const tl0 = JSON.parse(fs.readFileSync(tlFile, 'utf8'));
  tl0.narration[0].text = 'その PNG を ffmpeg へ';
  tl0.texts.push({ id: 't01', scene: 's01', kind: 'subtitle', text: 'その PNG を ffmpeg へ', start: 0, end: 3.0 });
  fs.writeFileSync(tlFile, JSON.stringify(tl0));
  writeReadings(dir, [{ surface: 'ffmpeg', reading: 'エフエフエムペグ' }]);
  const sent = [];
  const inner = voicevoxFake([1.0, 1.0]);
  const f = async (url, init) => {
    if (String(url).includes('/audio_query')) sent.push(new URL(String(url)).searchParams.get('text'));
    return inner(url, init);
  };
  const tl = await synthesizeNarration(dir, { engine: 'voicevox', speakerOrVoice: 3, fetch: f, warn: () => {}, log: () => {} });
  assert.equal(sent[0], 'そのPNGをエフエフエムペグへ');
  assert.equal(tl.narration[0].text, 'その PNG を ffmpeg へ');
  assert.equal(tl.texts[0].text, 'その PNG を ffmpeg へ');
  assert.equal(readProject(dir).models.at(-1).readings, 1);
});

test('Gemini: 読みの辞書を当てた文を送る（空白は詰めない）', async () => {
  const dir = setup();
  recordConsent(dir, { quote: 'はい、Gemini を使ってください' });
  writeReadings(dir, [{ surface: 'ffmpeg', reading: 'エフエフエムペグ' }]);
  const tlFile = path.join(dir, 'timeline.json');
  const tl0 = JSON.parse(fs.readFileSync(tlFile, 'utf8'));
  tl0.narration[0].text = 'その PNG を ffmpeg へ';
  fs.writeFileSync(tlFile, JSON.stringify(tl0));
  const sent = [];
  const pcm = Buffer.alloc(24000 * 2);
  const fakeFetch = async (url, init) => {
    sent.push(JSON.parse(init.body).input[0].content[0].text);
    return new Response(JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: pcm.toString('base64') }] }] }));
  };
  await synthesizeNarration(dir, { engine: 'gemini', speakerOrVoice: 'Kore', approved: true, apiKey: 'k', fetch: fakeFetch, warn: () => {}, log: () => {} });
  assert.equal(sent[0], 'その PNG を エフエフエムペグ へ');
});

test('辞書の形が違えば、何も合成せずに止まる', async () => {
  const dir = setup();
  writeReadings(dir, [{ surface: '', reading: 'x' }]);
  let called = false;
  await assert.rejects(
    synthesizeNarration(dir, { engine: 'voicevox', speakerOrVoice: 3, fetch: async () => { called = true; return new Response('[]'); } }),
    /readings\.json/,
  );
  assert.equal(called, false);
});

test('途中の行で合成に失敗したら、前の音声ファイルも時刻表も変えない（新しい声と古い長さが混ざらない）', async () => {
  const dir = setup();
  await synthesizeNarration(dir, { engine: 'voicevox', speakerOrVoice: 3, fetch: voicevoxFake([1.0, 1.0]), warn: () => {}, log: () => {} });
  const tlFile = path.join(dir, 'timeline.json');
  const tl0 = fs.readFileSync(tlFile, 'utf8');
  const wav0 = fs.readFileSync(path.join(dir, 'audio/narration/n01.wav'));
  const ok = voicevoxFake([2.0]);
  let synth = 0;
  const failing = async (url, init) => {
    if (String(url).includes('/synthesis') && ++synth === 2) throw new TypeError('fetch failed');
    return ok(url, init);
  };
  await assert.rejects(synthesizeNarration(dir, { engine: 'voicevox', speakerOrVoice: 3, force: true, fetch: failing, warn: () => {}, log: () => {} }), /VOICEVOX/);
  assert.equal(fs.readFileSync(tlFile, 'utf8'), tl0);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'audio/narration/n01.wav')), wav0);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'audio/narration')).filter((f) => f.endsWith('.wav')).sort(), ['n01.wav', 'n02.wav']);
});

test('Gemini: 途中の行で失敗したら合成済みの行を残し、次の実行は残りの行だけを作る（了承に見せる回数も残りの行数）', async () => {
  const dir = setup();
  const tlFile = path.join(dir, 'timeline.json');
  const tl = JSON.parse(fs.readFileSync(tlFile, 'utf8'));
  tl.narration.push({ id: 'n03', scene: 's02', text: '三つめ', start: 5, audio: null, duration: null });
  fs.writeFileSync(tlFile, JSON.stringify(tl));
  recordConsent(dir, { quote: 'はい' });
  const pcm = Buffer.alloc(24000 * 2);
  const ok = () => new Response(JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: pcm.toString('base64') }] }] }));
  let calls = 0;
  const failSecond = async () => (++calls === 2 ? new Response('busy', { status: 429 }) : ok());
  await assert.rejects(synthesizeNarration(dir, { engine: 'gemini', speakerOrVoice: 'Kore', approved: true, apiKey: 'k', fetch: failSecond, log: () => {} }), /HTTP 429[\s\S]*1 行は残しました/);
  // 了承なしの実行は、残りの 2 行だけを回数に出す
  await assert.rejects(synthesizeNarration(dir, { engine: 'gemini', speakerOrVoice: 'Kore', apiKey: 'k', fetch: ok, log: () => {} }), /有料の API を 2 回/);
  calls = 0;
  const lines = [];
  const after = await synthesizeNarration(dir, { engine: 'gemini', speakerOrVoice: 'Kore', approved: true, apiKey: 'k', fetch: async () => { calls++; return ok(); }, log: (m) => lines.push(m), warn: () => {} });
  assert.equal(calls, 2);
  assert.equal(after.narration.length, 3);
  assert.match(lines.join('\n'), /有料の API を 2 回/);
  assert.ok(!fs.existsSync(path.join(dir, 'audio', '.narration-partial')), 'そろったら途中の置き場は消す');
});

test('Gemini: 声か文が変わった行は使い回さない', async () => {
  const dir = setup();
  recordConsent(dir, { quote: 'はい' });
  const pcm = Buffer.alloc(24000 * 2);
  const ok = () => new Response(JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: pcm.toString('base64') }] }] }));
  let calls = 0;
  await assert.rejects(synthesizeNarration(dir, { engine: 'gemini', speakerOrVoice: 'Kore', approved: true, apiKey: 'k', fetch: async () => (++calls === 2 ? new Response('x', { status: 500 }) : ok()), log: () => {} }));
  await assert.rejects(synthesizeNarration(dir, { engine: 'gemini', speakerOrVoice: 'Puck', apiKey: 'k', fetch: ok, log: () => {} }), /有料の API を 2 回/);
});

test('Gemini: 作り終えた後に 1 行だけ直すと、その行だけを作り（了承の回数も 1 回）、ほかの行の声はそのまま。force なら全行を作る', async () => {
  const dir = setup();
  recordConsent(dir, { quote: 'はい' });
  const pcm = (s) => Buffer.alloc(Math.round(24000 * s) * 2);
  let seconds = 1;
  let calls = 0;
  const tts = async () => {
    calls++;
    return new Response(JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: pcm(seconds).toString('base64') }] }] }));
  };
  const opts = { engine: 'gemini', speakerOrVoice: 'Kore', apiKey: 'k', fetch: tts, log: () => {}, warn: () => {} };
  await synthesizeNarration(dir, { ...opts, approved: true });
  assert.equal(calls, 2);
  const wav1 = fs.readFileSync(path.join(dir, 'audio/narration/n01.wav'));

  // n02 の文だけを直す
  const tlFile = path.join(dir, 'timeline.json');
  const tl = JSON.parse(fs.readFileSync(tlFile, 'utf8'));
  tl.narration[1].text = '二つめを直した';
  fs.writeFileSync(tlFile, JSON.stringify(tl));
  await assert.rejects(synthesizeNarration(dir, opts), /有料の API を 1 回[\s\S]*1 行は使い回す/);
  calls = 0;
  seconds = 2;
  const after = await synthesizeNarration(dir, { ...opts, approved: true });
  assert.equal(calls, 1);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'audio/narration/n01.wav')), wav1, '直していない行の声は変えない');
  assert.equal(after.narration[0].duration, 1);
  assert.equal(after.narration[1].duration, 2);

  // 何も変えなければ何も作らない（了承も要らない）
  calls = 0;
  await synthesizeNarration(dir, opts);
  assert.equal(calls, 0);

  // force なら全行を作る
  await assert.rejects(synthesizeNarration(dir, { ...opts, force: true }), /有料の API を 2 回/);
  await synthesizeNarration(dir, { ...opts, force: true, approved: true });
  assert.equal(calls, 2);
});

test('VOICEVOX: 速さを変えると全行を作り直し、同じなら作らない', async () => {
  const dir = setup();
  let synth = 0;
  const fake = voicevoxFake([1, 1, 1, 1, 1, 1]);
  const counting = async (url, init) => {
    if (String(url).includes('/synthesis')) synth++;
    return fake(url, init);
  };
  const opts = { engine: 'voicevox', speakerOrVoice: 3, fetch: counting, log: () => {}, warn: () => {} };
  await synthesizeNarration(dir, opts);
  assert.equal(synth, 2);
  await synthesizeNarration(dir, opts);
  assert.equal(synth, 2, '同じなら作らない');
  await synthesizeNarration(dir, { ...opts, speed: 1.3 });
  assert.equal(synth, 4, '速さを変えれば全行');
});

test('声の入れ替えの途中で止まっても、次の実行は作り直さずに入れ替えをやり直し、入れかけの声を使い回したことにしない', async () => {
  const dir = setup();
  recordConsent(dir, { quote: 'はい' });
  const pcm = Buffer.alloc(24000 * 2);
  let calls = 0;
  const tts = async () => {
    calls++;
    return new Response(JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: pcm.toString('base64') }] }] }));
  };
  const opts = { engine: 'gemini', speakerOrVoice: 'Kore', apiKey: 'k', approved: true, fetch: tts, log: () => {}, warn: () => {} };
  await synthesizeNarration(dir, opts);
  const tlFile = path.join(dir, 'timeline.json');
  const tl = JSON.parse(fs.readFileSync(tlFile, 'utf8'));
  tl.narration[0].text = '一つめを直した';
  fs.writeFileSync(tlFile, JSON.stringify(tl));
  // n01.wav を書き込めないようにする（フォルダにして置き換えを失敗させる）
  const n01 = path.join(dir, 'audio/narration/n01.wav');
  removeFile(n01);
  fs.mkdirSync(n01);
  fs.writeFileSync(path.join(n01, 'x'), '');
  calls = 0;
  await assert.rejects(synthesizeNarration(dir, opts), /入れ替えの途中で止まりました/);
  assert.equal(calls, 1);
  const done = JSON.parse(fs.readFileSync(path.join(dir, 'audio/narration/.manifest.json'), 'utf8'));
  assert.equal(done.n01, undefined, '入れかけの行は作り終えた記録に残さない');
  assert.ok(done.n02);
  removeTree(n01);
  calls = 0;
  await synthesizeNarration(dir, opts);
  assert.equal(calls, 0, '置き場の声で入れ替えをやり直す');
  assert.ok(fs.statSync(n01).isFile());
});

test('時刻表の id が使えない形なら、何も作らず通信もせずに止まる（制作フォルダの外に書かない）', async () => {
  const dir = setup();
  const tlFile = path.join(dir, 'timeline.json');
  const tl = JSON.parse(fs.readFileSync(tlFile, 'utf8'));
  tl.narration[0].id = '../../evil';
  fs.writeFileSync(tlFile, JSON.stringify(tl));
  let calls = 0;
  await assert.rejects(synthesizeNarration(dir, { engine: 'voicevox', speakerOrVoice: 3, fetch: async () => { calls++; return new Response('{}'); }, warn: () => {}, log: () => {} }), /timeline\.json に誤り/);
  assert.equal(calls, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'evil.wav')) && !fs.existsSync(path.join(dir, 'audio', 'evil.wav')));
});
