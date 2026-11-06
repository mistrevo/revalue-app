// 音のミックスと連結・ポスター・比率・ループの書き出しを、fixture（sample）で検証する。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assemble, loopVersion, poster } from '../scripts/assemble.mjs';
import { videoPath } from '../scripts/check.mjs';
import { encodedLoudness, mixAudio } from '../scripts/mix.mjs';
import { copyTree, removeFile, removeTree, toolsDir } from '../scripts/paths.mjs';
import { bundledBinary, defaultExec, hasPackage, measureLoudness } from '../scripts/tools.mjs';
import { readWav } from '../scripts/wav.mjs';

const SAMPLE = fileURLToPath(new URL('./fixtures/sample', import.meta.url));
const HAS_FFMPEG = (defaultExec('ffmpeg -version') !== null || bundledBinary(toolsDir(), 'ffmpeg-static') !== null)
  && (defaultExec('ffprobe -version') !== null || bundledBinary(toolsDir(), 'ffprobe-static') !== null);
const HAS_TOOLS = HAS_FFMPEG && hasPackage(toolsDir(), 'puppeteer');
const FFMPEG = defaultExec('ffmpeg -version') !== null ? 'ffmpeg' : bundledBinary(toolsDir(), 'ffmpeg-static');
const FFPROBE = defaultExec('ffprobe -version') !== null ? 'ffprobe' : bundledBinary(toolsDir(), 'ffprobe-static');

const dirs = [];
after(() => { for (const d of dirs) removeTree(d); });

/** fixture を日本語と空白を含む一時フォルダへ複製し、必要なら timeline を書き換える */
function copyFixture(edit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsms 組立-'));
  copyTree(SAMPLE, dir);
  dirs.push(dir);
  if (edit) {
    const f = path.join(dir, 'timeline.json');
    const tl = JSON.parse(fs.readFileSync(f, 'utf8'));
    edit(tl, dir);
    fs.writeFileSync(f, JSON.stringify(tl));
  }
  return dir;
}

function probe(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'json', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).streams;
}

/** 道具と同じ測り方（ebur128）の測定値。input_i・input_tp の名前で返す */
function measure(file) {
  const { i, tp } = measureLoudness(file);
  return { input_i: i, input_tp: tp };
}

function toolTest(name, fn) {
  test(name, async (t) => {
    if (!HAS_TOOLS) return t.skip('道具が未導入');
    await fn(t);
  });
}

toolTest('final で組み立てると、尺が総尺 ±1 フレームで映像と音声がそろう（効果音だけなので -14 LUFS にはそろえない）', async () => {
  const dir = copyFixture();
  const [out] = await assemble(dir, { ratios: ['16:9'], preset: 'final' });
  const tl = JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8'));
  assert.equal(out.file, videoPath(dir, tl, '16:9', 'final'));
  const streams = probe(out.file);
  const video = streams.find((s) => s.codec_type === 'video');
  assert.ok(streams.some((s) => s.codec_type === 'audio'));
  assert.ok(Math.abs(Number(video.duration) - 3) <= 1 / 30 + 1e-3, `尺 ${video.duration}`);
  const m = measure(out.file);
  assert.ok(Number(m.input_i) < -14, `統合 ${m.input_i} LUFS`);
  assert.ok(Number(m.input_tp) <= -1.0, `TP ${m.input_tp}`);
  const audio = streams.find((s) => s.codec_type === 'audio');
  assert.ok(Math.abs(Number(audio.duration) - Number(video.duration)) <= 0.1, `音 ${audio.duration} 映像 ${video.duration}`);
  const wav = readWav(path.join(dir, 'audio/master.wav'));
  assert.equal(wav.sampleRate, 48000);
  assert.equal(wav.channels, 2);
});

toolTest('音の要素が何も無いと、mixAudio は null で、MP4 に音声が無い', async () => {
  const dir = copyFixture((tl, d) => {
    tl.sfx = [];
    // 前の書き出しの master が残っていても消える
    fs.mkdirSync(path.join(d, 'audio'), { recursive: true });
    fs.writeFileSync(path.join(d, 'audio/master.wav'), 'stale');
  });
  assert.equal(await mixAudio(dir), null);
  assert.ok(!fs.existsSync(path.join(dir, 'audio/master.wav')));
  const [out] = await assemble(dir, { ratios: ['16:9'], preset: 'draft' });
  assert.ok(!probe(out.file).some((s) => s.codec_type === 'audio'));
});

toolTest('比率を 2 つ指定すると、ファイルが 2 つできる', async () => {
  const dir = copyFixture();
  const outs = await assemble(dir, { ratios: ['16:9', '1:1'], preset: 'draft' });
  assert.equal(outs.length, 2);
  for (const o of outs) assert.ok(fs.existsSync(o.file));
  assert.notEqual(outs[0].file, outs[1].file);
});

toolTest('ナレーションと BGM があっても、総尺で音量がそろう', async () => {
  const dir = copyFixture((tl, d) => {
    fs.mkdirSync(path.join(d, 'audio'), { recursive: true });
    const sine = (f, hz, s, sr) => spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${s}:sample_rate=${sr}`, f]);
    sine(path.join(d, 'audio/n01.wav'), 300, 1, 24000);
    sine(path.join(d, 'audio/bgm.wav'), 200, 10, 44100);
    tl.narration = [{ id: 'n01', scene: 's01', text: 'ようこそ', start: 0.5, audio: 'audio/n01.wav', duration: 1 }];
    tl.bgm = { file: 'audio/bgm.wav', bpm: 100, gain: -18, source: '持ち込み', license: 'test' };
  });
  const master = await mixAudio(dir);
  const wav = readWav(master);
  assert.ok(Math.abs(wav.duration - 3) < 0.01, `尺 ${wav.duration}`);
  const m = measure(master);
  assert.ok(Math.abs(Number(m.input_i) + 14) <= 1, `統合 ${m.input_i} LUFS`);
});

toolTest('音の入力が前回と同じなら、mixAudio は混ぜ直さずに前回の master.wav を使う。BGM の音量やナレーションのファイルが変われば混ぜ直す', async () => {
  const dir = copyFixture((tl, d) => {
    fs.mkdirSync(path.join(d, 'audio'), { recursive: true });
    const sine = (f, hz, s) => spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${s}:sample_rate=48000`, f]);
    sine(path.join(d, 'audio/n01.wav'), 300, 1);
    sine(path.join(d, 'audio/bgm.wav'), 200, 10);
    tl.narration = [{ id: 'n01', scene: 's01', text: 'ようこそ', start: 0.5, audio: 'audio/n01.wav', duration: 1 }];
    tl.bgm = { file: 'audio/bgm.wav', bpm: 100, gain: -18, source: '持ち込み', license: 'test' };
  });
  let metered = 0;
  const encodedMeter = (wav) => { metered++; return encodedLoudness(wav); };
  const master = await mixAudio(dir, { encodedMeter });
  assert.equal(metered, 1);
  const mtime = fs.statSync(master).mtimeMs;
  assert.equal(await mixAudio(dir, { encodedMeter }), master);
  assert.equal(metered, 1, '同じ入力なのに測り直した');
  assert.equal(fs.statSync(master).mtimeMs, mtime);

  const tlFile = path.join(dir, 'timeline.json');
  const tl = JSON.parse(fs.readFileSync(tlFile, 'utf8'));
  tl.bgm.gain = -20;
  fs.writeFileSync(tlFile, JSON.stringify(tl));
  await mixAudio(dir, { encodedMeter });
  assert.equal(metered, 2, 'bgm.gain を変えたのに混ぜ直していない');

  spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=400:duration=1:sample_rate=48000', path.join(dir, 'audio/n01.wav')]);
  await mixAudio(dir, { encodedMeter });
  assert.equal(metered, 3, 'ナレーションのファイルを変えたのに混ぜ直していない');

  // master.wav が消えていれば、入力が同じでも混ぜ直す
  fs.unlinkSync(master);
  await mixAudio(dir, { encodedMeter });
  assert.equal(metered, 4);

  // 効果音の波形を決める seed と、置く位置を決める fps が変われば混ぜ直す
  for (const [k, v, n] of [['seed', 7, 5], ['fps', 60, 6]]) {
    const t = JSON.parse(fs.readFileSync(tlFile, 'utf8'));
    t[k] = v;
    fs.writeFileSync(tlFile, JSON.stringify(t));
    await mixAudio(dir, { encodedMeter });
    assert.equal(metered, n, `${k} を変えたのに混ぜ直していない`);
  }
});

toolTest('assemble.mjs --preset final は、書き出しのあとに完成版の点検と全品質のコンタクトシートまで通し、終了コードに点検の結果を返す', async () => {
  const dir = copyFixture();
  const cli = () => spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/assemble.mjs', import.meta.url)), dir, '--preset', 'final'], { encoding: 'utf8' });
  const ok = cli();
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /コンタクトシート: .*contact-16x9-01\.png/);
  assert.match(ok.stdout, /自動点検: 問題は見つかりませんでした/);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'reviews/checks-final-16x9.json'), 'utf8'));
  assert.equal(saved.ok, true);
  const runs = JSON.parse(fs.readFileSync(path.join(dir, 'reviews/check-runs.json'), 'utf8')).runs;
  assert.deepEqual(runs.map((r) => r.stage), ['final']);
  // 点検に引っかかれば、終了コード 1 で指摘を出す
  const tlFile = path.join(dir, 'timeline.json');
  const tl = JSON.parse(fs.readFileSync(tlFile, 'utf8'));
  tl.texts[0].end = 1.0;
  fs.writeFileSync(tlFile, JSON.stringify(tl));
  const ng = cli();
  assert.equal(ng.status, 1, ng.stdout + ng.stderr);
  assert.match(ng.stdout, /1\. カット1/);
});

/** 左チャンネルの [from, to) 秒の二乗平均平方根 */
function rms(wav, from, to) {
  const d = wav.data[0].subarray(Math.round(from * wav.sampleRate), Math.round(to * wav.sampleRate));
  return Math.sqrt(d.reduce((s, v) => s + v * v, 0) / d.length);
}

/** 左チャンネルの [from, to) 秒にある hz の正弦波の振幅（相関で測る） */
function toneAmp(wav, hz, from, to) {
  const a = Math.round(from * wav.sampleRate);
  const d = wav.data[0].subarray(a, Math.round(to * wav.sampleRate));
  let c = 0, s = 0;
  for (let i = 0; i < d.length; i++) {
    const w = (2 * Math.PI * hz * (a + i)) / wav.sampleRate;
    c += d[i] * Math.cos(w);
    s += d[i] * Math.sin(w);
  }
  return (2 * Math.hypot(c, s)) / d.length;
}

toolTest('ナレーション 2 行と BGM: 開始位置に音が現れ、BGM が下がり、終わりで絞られる', async () => {
  const dir = copyFixture((tl, d) => {
    fs.mkdirSync(path.join(d, 'audio'), { recursive: true });
    const sine = (f, hz, s, sr) => spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${s}:sample_rate=${sr}`, f]);
    sine(path.join(d, 'audio/n01.wav'), 1000, 1, 24000);
    sine(path.join(d, 'audio/n02.wav'), 1000, 1, 24000);
    sine(path.join(d, 'audio/bgm.wav'), 200, 12, 44100);
    tl.scenes[1].end = 8;
    tl.sfx = [];
    tl.narration = [
      { id: 'n01', scene: 's01', text: 'ようこそ', start: 1, audio: 'audio/n01.wav', duration: 1 },
      { id: 'n02', scene: 's02', text: '始めよう', start: 4, audio: 'audio/n02.wav', duration: 1 },
    ];
    tl.bgm = { file: 'audio/bgm.wav', bpm: 100, gain: -18, source: '持ち込み', license: 'test' };
  });
  const wav = readWav(await mixAudio(dir));
  // 位置: 各行の開始から音が増える（その前は BGM だけ）
  for (const at of [1, 4]) {
    assert.ok(rms(wav, at + 0.2, at + 0.9) > 1.5 * rms(wav, at - 0.8, at - 0.1), `${at} 秒で音が増えない`);
  }
  // ダッキング: ナレーション中の BGM（200Hz）は、無いときより 3 dB 以上低い
  const during = toneAmp(wav, 200, 1.3, 1.9);
  const without = toneAmp(wav, 200, 2.6, 3.6);
  assert.ok(20 * Math.log10(without / during) >= 3, `BGM が下がっていない（${during} / ${without}）`);
  // 終わりの 1.5 秒で絞られる
  assert.ok(rms(wav, 7.5, 7.9) < 0.5 * rms(wav, 5.5, 5.9), '終わりで BGM が絞られていない');
});

/**
 * 小さい 200Hz の音（toneDb dBFS）に、0.5 秒ごとの短いクリック（3 ms の 3kHz、clickDb dBFS）を重ねた BGM を作る。
 * 頂点と音量の差が大きいので、そのまま -14 LUFS まで持ち上げると頂点が目標を超える。
 * クリックが多いので、頂点を急に削る補正や、頂点を抑えただけの処理では音量が -14 LUFS から 2 dB 以上外れる
 */
function clickyBgm(file, { toneDb = -30, clickDb = 0, seconds = 12 } = {}) {
  const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=200:duration=${seconds}:sample_rate=48000`,
    '-f', 'lavfi', '-i', `aevalsrc='sin(2*PI*3000*t)*lt(mod(t,0.5),0.003)':d=${seconds}:s=48000`,
    // sine は振幅 1/8（-18 dBFS）で出るので、その分を足し引きする
    '-filter_complex', `[0]volume=${toneDb + 18}dB[a];[1]volume=${clickDb}dB[b];[a][b]amix=inputs=2:normalize=0`,
    '-c:a', 'pcm_f32le', file]);
  assert.equal(r.status, 0, String(r.stderr));
}

/** クリックの BGM だけの制作フォルダ。gain で BGM の音量を変える（premix は浮動小数なので 0 dBFS を超えてもよい） */
function clickyProject(opts = {}, gain = 0) {
  return copyFixture((tl, d) => {
    fs.mkdirSync(path.join(d, 'audio'), { recursive: true });
    clickyBgm(path.join(d, 'audio/bgm.wav'), opts);
    tl.scenes[1].end = 10;
    tl.sfx = [];
    tl.bgm = { file: 'audio/bgm.wav', bpm: 100, gain, source: '持ち込み', license: 'test' };
  });
}

/** 書き出しと同じ AAC にしてから測る */
function measureEncoded(wav) {
  const m4a = `${wav}.test.m4a`;
  try {
    const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', wav, '-c:a', 'aac', '-b:a', '192k', '-f', 'mp4', m4a]);
    assert.equal(r.status, 0, String(r.stderr));
    return measure(m4a);
  } finally {
    removeFile(m4a);
  }
}

toolTest('小さい音に大きいクリックが混ざっていても、AAC にした後で -1 dBTP 以下・-14 LUFS ±1 にそろう（実際に測る）', async () => {
  const m = measureEncoded(await mixAudio(clickyProject()));
  assert.ok(Number(m.input_tp) <= -1, `TP ${m.input_tp}`);
  assert.ok(Math.abs(Number(m.input_i) + 14) <= 1, `統合 ${m.input_i} LUFS`);
});

toolTest('とても小さい音・0 dBFS を大きく超える音でも、頂点を抑える処理が止まらずにそろう', async () => {
  // とても小さい: 持ち上げる量が 40 dB を超える。とても大きい: 頂点が +20 dBFS（浮動小数の premix）
  for (const [opts, gain] of [[{ toneDb: -60, clickDb: -30 }, 0], [{ toneDb: -10, clickDb: 0 }, 20]]) {
    const m = measureEncoded(await mixAudio(clickyProject(opts, gain)));
    assert.ok(Number(m.input_tp) <= -1, `${JSON.stringify(opts)} gain ${gain}: TP ${m.input_tp}`);
    assert.ok(Math.abs(Number(m.input_i) + 14) <= 1, `${JSON.stringify(opts)} gain ${gain}: 統合 ${m.input_i} LUFS`);
  }
});

toolTest('AAC にすると頂点が -1 dBTP を超えるなら、頂点の目標を下げて合わせ直す（音量はそろったまま）', async () => {
  const dir = clickyProject();
  // 1 回目は AAC で -0.1 dBTP まで上がったことにする。2 回目からは実際に測った値を使う
  const seen = [];
  const master = await mixAudio(dir, {
    encodedMeter: (wav) => {
      const m = measureEncoded(wav);
      seen.push(m);
      return { i: Number(m.input_i), tp: seen.length === 1 ? -0.1 : Number(m.input_tp) };
    },
  });
  assert.equal(seen.length, 2);
  // 2 回目の音は、1 回目より頂点が下がっている（0.95 dB 超えた分 + 余裕 0.3 dB ぶん目標を下げた）
  const tps = seen.map((m) => Number(m.input_tp));
  assert.ok(tps[1] < tps[0] - 0.5, `頂点が下がっていない: ${tps.join(' → ')}`);
  const mi = Number(measure(master).input_i);
  assert.ok(Math.abs(mi + 14) <= 1, `統合 ${mi} LUFS（${tps.join(' → ')}）`);
});

toolTest('何度やり直しても頂点か音量が収まらなければ、測った値を添えて止まる', async () => {
  const dir = clickyProject();
  await assert.rejects(() => mixAudio(dir, { encodedMeter: () => ({ i: -14, tp: -0.2 }) }),
    (e) => /-0\.2 dBTP/.test(e.message) && /-14\.0 LUFS/.test(e.message) && /そろえられません/.test(e.message));
  assert.ok(!fs.existsSync(path.join(dir, 'audio/master.wav')), '収まらない音を master に残さない');
  await assert.rejects(() => mixAudio(dir, { encodedMeter: () => ({ i: -16.2, tp: -3 }) }), /-16\.2 LUFS/);
});

toolTest('BGM の offset があれば、曲のその位置から使う', async () => {
  const dir = copyFixture((tl, d) => {
    fs.mkdirSync(path.join(d, 'audio'), { recursive: true });
    // 0〜5 秒は 200Hz、5 秒から 400Hz
    spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=200:duration=5:sample_rate=44100',
      '-f', 'lavfi', '-i', 'sine=frequency=400:duration=10:sample_rate=44100',
      '-filter_complex', '[0][1]concat=n=2:v=0:a=1', path.join(d, 'audio/bgm.wav')]);
    tl.sfx = [];
    tl.bgm = { file: 'audio/bgm.wav', bpm: 100, gain: -18, offset: 5, source: '持ち込み', license: 'test' };
  });
  const wav = readWav(await mixAudio(dir));
  assert.ok(toneAmp(wav, 400, 0.2, 1.2) > 4 * toneAmp(wav, 200, 0.2, 1.2), '5 秒より後の音から始まっていない');
});

toolTest('BGM の repeat があれば、to まで鳴らして from へ戻り、続きを鳴らす。曲が動画より短ければ知らせる', async (t) => {
  const make = (repeat) => copyFixture((tl, d) => {
    fs.mkdirSync(path.join(d, 'audio'), { recursive: true });
    // 0〜1 秒は 200Hz、1〜5 秒は 400Hz
    spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=200:duration=1:sample_rate=44100',
      '-f', 'lavfi', '-i', 'sine=frequency=400:duration=4:sample_rate=44100',
      '-filter_complex', '[0][1]concat=n=2:v=0:a=1', path.join(d, 'audio/bgm.wav')]);
    tl.sfx = [];
    tl.bgm = { file: 'audio/bgm.wav', bpm: 100, gain: -18, source: '持ち込み', license: 'test', ...(repeat ? { repeat } : {}) };
  });
  const warn = t.mock.method(console, 'warn', () => {});
  const wav = readWav(await mixAudio(make({ from: 0.1, to: 1.1 })));
  // 1.1 秒まで鳴らして 0.1 秒へ戻るので、1.1〜2.0 秒にも 200Hz が鳴り、2.0 秒より後は 400Hz
  assert.ok(toneAmp(wav, 200, 1.2, 1.8) > 4 * toneAmp(wav, 400, 1.2, 1.8), '1.1〜2.0 秒に、くり返した区間が鳴っていない');
  assert.ok(toneAmp(wav, 400, 2.2, 2.8) > 4 * toneAmp(wav, 200, 2.2, 2.8));
  // times: 2 なら 2 回目のくり返しで、2.1〜3.0 秒にも 200Hz が鳴る
  const twice = readWav(await mixAudio(make({ from: 0.1, to: 1.1, times: 2 })));
  assert.ok(toneAmp(twice, 200, 2.2, 2.8) > 4 * toneAmp(twice, 400, 2.2, 2.8), '2回目のくり返しが鳴っていない');
  assert.equal(warn.mock.callCount(), 0);
  await assert.rejects(() => mixAudio(make({ from: 1, to: 6 })), /bgm\.repeat の to（6 秒）が曲の長さ（5\.0 秒）以上/);
  // to が曲の終わりちょうどでも止める（くり返す区間の後ろが無い）
  await assert.rejects(() => mixAudio(make({ from: 1, to: 5 })), /bgm\.repeat の to（5 秒）が曲の長さ（5\.0 秒）以上/);
  await assert.rejects(() => mixAudio(make({ from: 2, to: 2.5 })), /bgm\.repeat は/);
  await assert.rejects(() => mixAudio(make({ from: 0.02, to: 2 })), /bgm\.repeat は/);
  // 1 秒の曲は、3 秒の動画の 1 秒で終わる
  const short = copyFixture((tl, d) => {
    fs.mkdirSync(path.join(d, 'audio'), { recursive: true });
    spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=200:duration=1:sample_rate=44100', path.join(d, 'audio/bgm.wav')]);
    tl.sfx = [];
    tl.bgm = { file: 'audio/bgm.wav', bpm: 100, gain: -18, source: '持ち込み', license: 'test' };
  });
  await mixAudio(short);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /BGM は動画の 1\.0 秒で終わり.*bgm\.repeat/);
  // くり返しても足りなければ、動画の終わりまで届く回数を times として知らせる（1.5 秒の曲の 0.2〜1.2 秒を1回で 2.5 秒。6 秒の動画に足りない 3.5 秒に、1 秒の区間を 4 回足す）
  const shortRepeat = copyFixture((tl, d) => {
    fs.mkdirSync(path.join(d, 'audio'), { recursive: true });
    spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=200:duration=1.5:sample_rate=44100', path.join(d, 'audio/bgm.wav')]);
    tl.sfx = [];
    tl.scenes[tl.scenes.length - 1].end = 6;
    tl.bgm = { file: 'audio/bgm.wav', bpm: 100, gain: -18, source: '持ち込み', license: 'test', repeat: { from: 0.2, to: 1.2 } };
  });
  await mixAudio(shortRepeat);
  assert.equal(warn.mock.callCount(), 2);
  assert.match(warn.mock.calls[1].arguments[0], /BGM は動画の 2\.5 秒で終わり.*bgm\.repeat の times を 5/);
});

toolTest('BGM の offset が数でない・負・曲の長さ以上なら、ffmpeg を走らせる前に分かる言葉で止まる', async () => {
  const project = (offset) => copyFixture((tl, d) => {
    fs.mkdirSync(path.join(d, 'audio'), { recursive: true });
    spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=200:duration=4:sample_rate=44100', path.join(d, 'audio/bgm.wav')]);
    tl.sfx = [];
    tl.bgm = { file: 'audio/bgm.wav', bpm: 100, gain: -18, offset, source: '持ち込み', license: 'test' };
  });
  await assert.rejects(() => mixAudio(project('2')), /bgm\.offset.*0 以上の秒/);
  await assert.rejects(() => mixAudio(project(-1)), /bgm\.offset.*0 以上の秒/);
  await assert.rejects(() => mixAudio(project(4)), /bgm\.offset（4 秒）が曲の長さ（4\.0 秒）/);
});

toolTest('ポスターは全品質の PNG、ループ版は loop が true のときだけ音なしで作る', async () => {
  const dir = copyFixture();
  const png = await poster(dir, '16:9');
  assert.match(path.basename(png), /_16x9_poster\.png$/);
  assert.ok(fs.statSync(png).size > 0);
  await assert.rejects(() => loopVersion(dir, '16:9'), /loop/);
  const dir2 = copyFixture((tl) => { tl.loop = true; });
  const file = await loopVersion(dir2, '16:9');
  assert.match(path.basename(file), /_16x9_loop\.mp4$/);
  assert.ok(!probe(file).some((s) => s.codec_type === 'audio'));
});

/** 標本の頂点（dBFS。volumedetect の max_volume） */
function samplePeak(file) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  return Number(/max_volume:\s*(-?[\d.]+)\s*dB/.exec(String(r.stderr))[1]);
}

toolTest('効果音だけのときは -14 LUFS にはそろえず、効果音どうしの釣り合いのまま、いちばん大きい頂点を -3 dBFS まで上げ下げする', async () => {
  // 目安の gain（-12、-14）の効果音だけでは頂点が -10 dBFS 前後で小さく聞こえるので、全体を持ち上げる
  const quiet = copyFixture((tl) => {
    tl.narration = [];
    tl.bgm = null;
    tl.sfx = [{ id: 'x01', t: 0.5, preset: 'pop', gain: -12 }, { id: 'x02', t: 1.5, preset: 'click', gain: -14 }];
  });
  const master = await mixAudio(quiet);
  const peak = samplePeak(master);
  assert.ok(peak >= -3.6 && peak <= -2.4, `頂点 ${peak} dBFS`);
  const m = measure(master);
  assert.ok(Number(m.input_i) <= -15.7, `統合 ${m.input_i} LUFS`);
  assert.ok(Number(m.input_tp) <= -1.5, `TP ${m.input_tp}`);
  // 釣り合い: 2つ目の効果音の gain だけを下げても、いちばん大きい頂点（1つ目）の高さは変わらない
  const quieter = copyFixture((tl) => {
    tl.narration = [];
    tl.bgm = null;
    tl.sfx = [{ id: 'x01', t: 0.5, preset: 'pop', gain: -12 }, { id: 'x02', t: 1.5, preset: 'click', gain: -20 }];
  });
  assert.ok(Math.abs(samplePeak(await mixAudio(quieter)) - peak) <= 0.3);
});

toolTest('効果音だけでも、書き出しの形式（AAC）にして頂点が -1 dBTP を超えるなら、超えた分だけ全体を下げて混ぜ直す', async () => {
  const sfxOnly = (tl) => {
    tl.narration = [];
    tl.bgm = null;
    tl.sfx = [{ id: 'x01', t: 0.5, preset: 'pop', gain: -12 }];
  };
  // AAC にすると頂点が -0.35 dBTP まで上がる（角ばった持ち込みの音など）と測られたら、-1.35 dBTP を目指して 1 dB 下げる
  const calls = [];
  const loud = copyFixture(sfxOnly);
  const lowered = samplePeak(await mixAudio(loud, {
    encodedMeter: (wav) => {
      calls.push(wav);
      return calls.length === 1 ? { i: -20, tp: -0.35 } : encodedLoudness(wav);
    },
  }));
  assert.equal(calls.length, 2);
  // ふつうは1回測るだけで、頂点は -3 dBFS
  const plain = [];
  const normal = samplePeak(await mixAudio(copyFixture(sfxOnly), { encodedMeter: (wav) => { plain.push(wav); return encodedLoudness(wav); } }));
  assert.equal(plain.length, 1);
  assert.ok(Math.abs(lowered - (normal - 1)) <= 0.3, `下げた頂点 ${lowered}、ふつう ${normal}`);
});

toolTest('効果音だけでも、詰めて鳴らして統合の音量が大きくなるときは、-16 LUFS を超えないように下げる', async () => {
  const dense = copyFixture((tl) => {
    tl.narration = [];
    tl.bgm = null;
    tl.sfx = Array.from({ length: 18 }, (_, i) => ({ id: `x${i}`, t: Math.round(i * 0.16 * 100) / 100, preset: i % 2 ? 'hit' : 'whoosh', gain: -2 }));
  });
  const m = measure(await mixAudio(dense));
  assert.ok(Number(m.input_i) <= -15.7, `統合 ${m.input_i} LUFS`);
  assert.ok(Number(m.input_tp) <= -1.5, `TP ${m.input_tp}`);
});

toolTest('音声ファイルの無いナレーション行だけなら効果音だけ扱い（点検と同じ判定）で、全部無音なら止まる', async () => {
  const { hasVoiceOrMusic } = await import('../scripts/timeline.mjs');
  assert.equal(hasVoiceOrMusic({ narration: [{ id: 'n01', audio: null }], bgm: null }), false);
  assert.equal(hasVoiceOrMusic({ narration: [{ id: 'n01', audio: 'audio/n01.wav' }], bgm: null }), true);
  assert.equal(hasVoiceOrMusic({ narration: [], bgm: { file: 'audio/bgm.wav' } }), true);
  const dir = copyFixture((tl) => {
    tl.narration = [{ id: 'n01', scene: 's01', text: 'ようこそ', start: 0.5, audio: null, duration: null }];
    tl.bgm = null;
    tl.sfx = [{ id: 'x01', t: 1, preset: 'pop', gain: -6 }];
  });
  const m = measure(await mixAudio(dir));
  // -14 LUFS にはそろえず、効果音だけの上限（-16 LUFS）より下
  assert.ok(Number(m.input_i) <= -15.7, `統合 ${m.input_i} LUFS`);
  const silent = copyFixture((tl) => { tl.sfx = [{ id: 'x01', t: 1, preset: 'pop', gain: -120 }]; });
  await assert.rejects(() => mixAudio(silent), /ほとんど無音/);
});
