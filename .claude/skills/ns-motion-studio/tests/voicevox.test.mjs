// VOICEVOX 呼び出しを偽の fetch で検証する
import assert from 'node:assert/strict';
import test from 'node:test';
import { characterTerms, checkScales, DEFAULT_VOICE, narrationKana, resolveSpeaker, VOICEVOX_CHARACTERS, voicevoxKana, voicevoxSpeak, voicevoxSpeakers, voicevoxText } from '../scripts/voicevox.mjs';

test('voicevoxSpeak は audio_query の結果を synthesis の本文に渡す', async () => {
  const calls = [];
  const fakeFetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/audio_query')) return new Response('{"accent_phrases":[],"speedScale":1}');
    return new Response(Buffer.from('RIFFwav'));
  };
  const out = await voicevoxSpeak('こんにちは', { speaker: 3, fetch: fakeFetch });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].url, `http://127.0.0.1:50021/audio_query?text=${encodeURIComponent('こんにちは')}&speaker=3`);
  assert.equal(calls[1].url, 'http://127.0.0.1:50021/synthesis?speaker=3');
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(calls[1].init.body, '{"accent_phrases":[],"speedScale":1}');
  assert.equal(out.toString(), 'RIFFwav');
});

test('エンジンが答えないときは日本語で失敗する', async () => {
  await assert.rejects(voicevoxSpeak('あ', { speaker: 1, fetch: async () => new Response('', { status: 500 }) }), /VOICEVOX.*失敗/);
});

test('voicevoxSpeakers は名前とスタイルだけを返す', async () => {
  const fakeFetch = async () => new Response(JSON.stringify([{ name: 'ずんだもん', speaker_uuid: 'x', styles: [{ name: 'ノーマル', id: 3, type: 'talk' }] }]));
  const s = await voicevoxSpeakers({ fetch: fakeFetch });
  assert.deepEqual(s, [{ name: 'ずんだもん', styles: [{ id: 3, name: 'ノーマル' }] }]);
});

test('voicevoxSpeak は速さと抑揚を audio_query の結果に書き込んでから synthesis に渡す', async () => {
  let body;
  const fakeFetch = async (url, init = {}) => {
    if (String(url).includes('/audio_query')) return new Response('{"accent_phrases":[],"speedScale":1,"intonationScale":1,"pitchScale":0}');
    body = JSON.parse(init.body);
    return new Response(Buffer.from('RIFFwav'));
  };
  await voicevoxSpeak('あ', { speaker: 3, speed: 1.1, intonation: 1.2, fetch: fakeFetch });
  assert.equal(body.speedScale, 1.1);
  assert.equal(body.intonationScale, 1.2);
  assert.equal(body.pitchScale, 0); // ほかの値はそのまま
  // 指定しなければエンジンの値のまま
  await voicevoxSpeak('あ', { speaker: 3, fetch: fakeFetch });
  assert.equal(body.speedScale, 1);
  assert.equal(body.intonationScale, 1);
});

test('checkScales は範囲の外と数でない値を日本語で断る', () => {
  assert.doesNotThrow(() => checkScales({ speed: 0.5, intonation: 0 }));
  assert.doesNotThrow(() => checkScales({ speed: 2.0, intonation: 2.0 }));
  assert.doesNotThrow(() => checkScales({}));
  assert.throws(() => checkScales({ speed: 0.4 }), /--speed.*0\.5〜2\.0/);
  assert.throws(() => checkScales({ speed: 2.1 }), /--speed.*0\.5〜2\.0/);
  assert.throws(() => checkScales({ speed: Number('速い') }), /--speed/);
  assert.throws(() => checkScales({ intonation: -0.1 }), /--intonation.*0〜2\.0/);
  assert.throws(() => checkScales({ intonation: 2.5 }), /--intonation.*0〜2\.0/);
});

test('voicevoxSpeak は範囲の外の速さでは通信せずに断る', async () => {
  let called = false;
  await assert.rejects(voicevoxSpeak('あ', { speaker: 3, speed: 3, fetch: async () => { called = true; return new Response('{}'); } }), /--speed/);
  assert.equal(called, false);
});

test('resolveSpeaker は番号でも「名前/スタイル」でも話者を引く', async () => {
  const fakeFetch = async () => new Response(JSON.stringify([
    { name: '四国めたん', styles: [{ name: 'ノーマル', id: 2 }, { name: 'あまあま', id: 0 }] },
    { name: 'ずんだもん', styles: [{ name: 'ノーマル', id: 3 }] },
  ]));
  assert.deepEqual(await resolveSpeaker('四国めたん/ノーマル', { fetch: fakeFetch }), { id: 2, name: '四国めたん', style: 'ノーマル' });
  assert.deepEqual(await resolveSpeaker('四国めたん／あまあま', { fetch: fakeFetch }), { id: 0, name: '四国めたん', style: 'あまあま' });
  assert.deepEqual(await resolveSpeaker(3, { fetch: fakeFetch }), { id: 3, name: 'ずんだもん', style: 'ノーマル' });
  assert.deepEqual(await resolveSpeaker('0', { fetch: fakeFetch }), { id: 0, name: '四国めたん', style: 'あまあま' });
  await assert.rejects(resolveSpeaker('四国めたん/ささやき', { fetch: fakeFetch }), /四国めたん.*ささやき.*ありません.*ノーマル/);
  await assert.rejects(resolveSpeaker('春日部つむぎ/ノーマル', { fetch: fakeFetch }), /春日部つむぎ.*ありません/);
  await assert.rejects(resolveSpeaker(99, { fetch: fakeFetch }), /99.*ありません/);
  await assert.rejects(resolveSpeaker('ずんだもん', { fetch: fakeFetch }), /名前\/スタイル/);
});

test('resolveSpeaker は名前に「/」を含む話者も、区切りを全部試して引き、使ってよい一覧に無ければ名前を挙げて止める', async () => {
  const fakeFetch = async () => new Response(JSON.stringify([
    { name: '小夜/SAYO', styles: [{ name: 'ノーマル', id: 46 }] },
    { name: '四国めたん', styles: [{ name: 'ノーマル', id: 2 }] },
  ]));
  // 小夜/SAYO は企業の利用に連絡が要るので外してある。名前は区切りを試して正しく引けている
  await assert.rejects(resolveSpeaker('小夜/SAYO/ノーマル', { fetch: fakeFetch }), /小夜\/SAYO は使えません.*四国めたん/);
  await assert.rejects(resolveSpeaker('46', { fetch: fakeFetch }), /小夜\/SAYO は使えません/);
  await assert.rejects(resolveSpeaker('小夜/SAYO/ささやき', { fetch: fakeFetch }), /小夜\/SAYO.*ささやき.*ありません.*ノーマル/);
  await assert.rejects(resolveSpeaker('小夜/ノーマル', { fetch: fakeFetch }), /小夜.*ありません/);
});

test('使ってよいキャラクターは、企業の利用に問い合わせの要るものを含まず、既定の声は四国めたん', () => {
  assert.equal(DEFAULT_VOICE, '四国めたん/ノーマル');
  assert.ok(characterTerms('四国めたん'));
  for (const name of ['青山龍星', '後鬼', 'ぞん子', 'Voidoll', 'No.7', '猫使アル', '猫使ビィ', 'ナースロボ＿タイプＴ', '小夜/SAYO']) {
    assert.equal(characterTerms(name), undefined, name);
  }
  for (const c of VOICEVOX_CHARACTERS) {
    assert.match(c.terms, /^https:\/\//);
    assert.match(c.checked, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('voicevoxText は日本語と隣り合う空白だけを詰める（英字どうしの空白は残す）', () => {
  assert.equal(voicevoxText('その PNG を ffmpeg へ渡す'), 'そのPNGをffmpegへ渡す');
  assert.equal(voicevoxText('Claude Code で 2026 年に'), 'Claude Codeで2026年に');
  assert.equal(voicevoxText('ns-motion-studio は、 動画を作る'), 'ns-motion-studioは、動画を作る');
  assert.equal(voicevoxText('  前後の空白  '), '前後の空白');
  assert.equal(voicevoxText('Hello world'), 'Hello world');
});

test('voicevoxSpeak は空白を詰めた文を audio_query に渡す', async () => {
  let url;
  const fakeFetch = async (u) => {
    if (String(u).includes('/audio_query')) { url = String(u); return new Response('{}'); }
    return new Response(Buffer.from('RIFFwav'));
  };
  await voicevoxSpeak('その PNG を ffmpeg へ', { speaker: 3, fetch: fakeFetch });
  assert.equal(new URL(url).searchParams.get('text'), 'そのPNGをffmpegへ');
});

test('voicevoxKana は audio_query の読みを、句切れを「/」で区切ったカタカナで返す', async () => {
  let url;
  const fakeFetch = async (u) => {
    url = String(u);
    return new Response(JSON.stringify({ accent_phrases: [
      { moras: [{ text: 'ファ' }, { text: 'ン' }, { text: 'ペ' }, { text: 'グ' }], pause_mora: null },
      { moras: [{ text: 'デ' }], pause_mora: { text: '、' } },
    ] }));
  };
  assert.equal(await voicevoxKana('ffmpeg で', { speaker: 3, fetch: fakeFetch }), 'ファンペグ/デ、');
  assert.equal(new URL(url).searchParams.get('text'), 'ffmpegで');
});

test('narrationKana は辞書を当てた各行の読みを返す（合成も書き込みもしない）', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsms-kana-'));
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify({ narration: [
    { id: 'n01', scene: 's01', text: 'ffmpeg で書き出す', start: 0 },
    { id: 'n02', scene: 's01', text: '章ごとに', start: 2 },
  ] }));
  fs.mkdirSync(path.join(dir, 'audio'));
  fs.writeFileSync(path.join(dir, 'audio', 'readings.json'), JSON.stringify([{ surface: 'ffmpeg', reading: 'エフエフエムペグ' }]));
  const urls = [];
  const fakeFetch = async (u) => {
    const url = String(u);
    urls.push(url);
    if (url.endsWith('/speakers')) return new Response(JSON.stringify([{ name: '四国めたん', styles: [{ name: 'ノーマル', id: 2 }] }]));
    const text = new URL(url).searchParams.get('text');
    return new Response(JSON.stringify({ accent_phrases: [{ moras: [{ text }], pause_mora: null }] }));
  };
  const rows = await narrationKana(dir, { fetch: fakeFetch }); // 省くと既定の四国めたん/ノーマル
  assert.deepEqual(rows, [
    { id: 'n01', text: 'エフエフエムペグで書き出す', kana: 'エフエフエムペグで書き出す' },
    { id: 'n02', text: '章ごとに', kana: '章ごとに' },
  ]);
  assert.ok(urls.every((u) => !u.includes('/synthesis')));
  assert.ok(urls.slice(1).every((u) => u.includes('speaker=2')));
});

test('エンジンにつながらない（起動していない）ときは、起動を確かめるよう日本語で失敗する', async () => {
  const down = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(voicevoxSpeakers({ fetch: down }), /VOICEVOX に接続できません.*起動/);
  await assert.rejects(voicevoxSpeak('あ', { speaker: 3, fetch: down }), /VOICEVOX に接続できません/);
});
