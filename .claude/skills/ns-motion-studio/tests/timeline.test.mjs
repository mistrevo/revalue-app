import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RATIOS, validateTimeline, minHold, holdViolations, narrationOverlaps, cutOf, setSceneDuration, sceneSlice, settledTime,
} from '../scripts/timeline.mjs';

/** 3シーンの基本形。 */
function base() {
  return {
    version: 1, title: 't', fps: 30, ratios: ['16:9'], loop: false, seed: 1,
    scenes: [
      { id: 's01', start: 0, end: 3.2, purpose: 'a', file: 'src/scenes/s01.html' },
      { id: 's02', start: 3.2, end: 6, purpose: 'b', file: 'src/scenes/s02.html' },
      { id: 's03', start: 6, end: 9, purpose: 'c', file: 'src/scenes/s03.html' },
    ],
    texts: [
      { id: 't01', scene: 's01', kind: 'title', text: '現場の待ち時間を、ゼロに。', start: 0.4, end: 3.0 },
      { id: 't02', scene: 's02', kind: 'caption', text: 'Zero wait time', start: 4, end: 5.5 },
    ],
    narration: [
      { id: 'n01', scene: 's01', text: 'こんにちは', start: 0.3, audio: null, duration: null },
      { id: 'n02', scene: 's03', text: 'さようなら', start: 6.5, audio: null, duration: null },
    ],
    sfx: [
      { id: 'x01', t: 0.43, preset: 'pop', gain: -6 },
      { id: 'x02', t: 4.2, preset: 'pop', gain: -6 },
    ],
    bgm: null, poster: 2.5,
  };
}

test('RATIOS は4種類の解像度', () => {
  assert.deepEqual(RATIOS['9:16'], [1080, 1920]);
  assert.equal(Object.keys(RATIOS).length, 4);
});

test('正しい timeline は ok', () => {
  assert.deepEqual(validateTimeline(base()), { ok: true, errors: [] });
});

test('隙間のあるシーン列を検出する', () => {
  const tl = base();
  tl.scenes[1].start = 3.5;
  const r = validateTimeline(tl);
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes('s02 の開始が s01 の終了と一致しません'));
});

test('0.001 秒以内の差は許す', () => {
  const tl = base();
  tl.scenes[1].start = 3.2005;
  assert.equal(validateTimeline(tl).ok, true);
});

test('総尺 301 秒は 5分 のエラー', () => {
  const tl = base();
  tl.scenes = [{ id: 's01', start: 0, end: 301, purpose: '', file: 'x' }];
  tl.texts = []; tl.narration = []; tl.sfx = [];
  const r = validateTimeline(tl);
  assert.ok(r.errors.some((e) => /5分/.test(e)));
});

test('存在しない scene・区間外・id 重複・ratios・fps を検出する', () => {
  const tl = base();
  tl.texts[0].scene = 'sXX';
  tl.texts[1].end = 7;
  tl.narration[0].scene = 'sYY';
  tl.narration[1].id = 'n01';
  tl.ratios = ['3:2'];
  tl.fps = 29;
  const r = validateTimeline(tl);
  assert.ok(r.errors.some((e) => e.includes('t01') && e.includes('sXX')));
  assert.ok(r.errors.some((e) => e.includes('t02') && e.includes('収まって')));
  assert.ok(r.errors.some((e) => e.includes('n01') && e.includes('sYY')));
  assert.ok(r.errors.some((e) => e.includes('重複') && e.includes('n01')));
  assert.ok(r.errors.some((e) => e.includes('3:2')));
  assert.ok(r.errors.some((e) => e.includes('fps')));
});

test('bgm.repeat は from < to（1 秒以上離す）の数の組で、from は 0.08 秒以上、times は 1 以上の整数でなければ誤り（無ければ問わない）', () => {
  const withRepeat = (repeat) => { const tl = base(); tl.bgm = { file: 'audio/bgm.wav', gain: -18, repeat }; return validateTimeline(tl); };
  assert.equal(withRepeat(undefined).ok, true);
  assert.equal(withRepeat({ from: 42.692, to: 117.358 }).ok, true);
  assert.equal(withRepeat({ from: 42.692, to: 117.358, times: 3 }).ok, true);
  // from が曲の頭に近すぎると、つなぎ目を重ねる分（0.08 秒）を from の前から取れない
  for (const bad of [{ from: '1', to: 5 }, { from: 5, to: 5.5 }, { from: -1, to: 4 }, [1, 4], { from: 0, to: 4 }, { from: 0.05, to: 4 },
    { from: 1, to: 4, times: 0 }, { from: 1, to: 4, times: 1.5 }, { from: 1, to: 4, times: '2' }]) {
    assert.match(withRepeat(bad).errors.join(' '), /bgm\.repeat は/, JSON.stringify(bad));
  }
});

test('bgm.offset は 0 以上の数でなければ誤り（無ければ問わない）', () => {
  const withOffset = (offset) => { const tl = base(); tl.bgm = { file: 'audio/bgm.wav', gain: -18, offset }; return validateTimeline(tl); };
  assert.equal(withOffset(undefined).ok, true);
  assert.equal(withOffset(0).ok, true);
  assert.equal(withOffset(2.07).ok, true);
  assert.equal(withOffset(null).ok, true);
  for (const bad of ['2.07', -1, Number.NaN, Infinity]) {
    const r = withOffset(bad);
    assert.ok(r.errors.some((e) => e.includes('bgm.offset')), `${String(bad)}: ${r.errors.join(' / ')}`);
  }
});

test('minHold: 日本語は記号を数えない', () => {
  // 記号を除くと 11 文字（タスクの説明には 10 と書いていたが数え間違い）
  assert.equal(minHold('現場の待ち時間を、ゼロに。'), 11 / 5 + 0.5);
});

test('minHold: 日本語の中の英単語・数字は、1語を 0.3 秒で数える（1文字ずつ数えない）', () => {
  // 「のインフラ構築」7文字 + 英語 2 語（PaaS、Serverless）
  assert.ok(Math.abs(minHold('PaaS / Serverless のインフラ構築') - (7 / 5 + 0.3 * 2 + 0.5)) < 1e-6, String(minHold('PaaS / Serverless のインフラ構築')));
  // 「の内製化は」5文字 + Azure 1語
  assert.ok(Math.abs(minHold('Azure の内製化は、') - (5 / 5 + 0.3 + 0.5)) < 1e-6, String(minHold('Azure の内製化は、')));
  // 英数字のつながりは 1 語（3 Step → 3 と Step の 2 語）
  assert.ok(Math.abs(minHold('3 Step で実施') - (3 / 5 + 0.3 * 2 + 0.5)) < 1e-6, String(minHold('3 Step で実施')));
});

test('minHold: 英語は語数', () => {
  assert.equal(minHold('Zero wait time'), 0.3 * 3 + 0.5);
});

test('holdViolations は短すぎる文字だけ返す', () => {
  const tl = base();
  tl.texts[0].end = 0.6; // 0.2 秒
  const v = holdViolations(tl);
  assert.equal(v.length, 1);
  assert.equal(v[0].id, 't01');
  assert.equal(v[0].need, 2.7);
  assert.ok(Math.abs(v[0].actual - 0.2) < 1e-9);
});

test('holdViolations: ナレーションと同じ文の字幕は、声の始まりまでに出て、話し終えて 0.5 秒後まで出ていれば、読む速さの式より短くてよい', () => {
  const tl = base();
  tl.texts[0].end = 3.1; // t01 は足りる長さにしておく
  const line = 'シーンの入力から sha256 を作り、キャッシュの鍵にします。'; // 読む速さなら 22/5 + 0.3 + 0.5 = 5.2 秒
  tl.narration[1] = { id: 'n02', scene: 's03', text: line, start: 6.0, audio: 'audio/narration/n02.wav', duration: 2.4 };
  tl.texts.push({ id: 't03', scene: 's03', kind: 'subtitle', text: line, start: 6.0, end: 8.9 });
  assert.deepEqual(holdViolations(tl), []);
  // 声より前から出ていてもよい
  tl.texts[2].start = 5.0;
  tl.texts[2].scene = 's03';
  tl.scenes[1].end = 5.0; tl.scenes[2].start = 5.0;
  tl.texts[1] = { ...tl.texts[1], start: 3.5, end: 4.9 };
  assert.deepEqual(holdViolations(tl), []);
});

test('holdViolations: 声が終わって 0.5 秒たつ前に消える字幕は、式で見て、声に合わせる時刻を添えて指摘する', () => {
  const tl = base();
  tl.texts[0].end = 3.1;
  const line = 'シーンの入力から sha256 を作り、キャッシュの鍵にします。';
  tl.narration[1] = { id: 'n02', scene: 's03', text: line, start: 6.0, audio: 'audio/narration/n02.wav', duration: 2.4 };
  // 長さ（2.6 秒）は声より長いが、声の終わり＋0.5 秒（8.9 秒）より前に消える
  tl.texts.push({ id: 't03', scene: 's03', kind: 'subtitle', text: line, start: 6.0, end: 8.6 });
  const v = holdViolations(tl);
  assert.equal(v.length, 1);
  assert.equal(v[0].id, 't03');
  assert.equal(v[0].need, minHold(line));
  assert.equal(v[0].narration, 'n02');
  assert.equal(v[0].from, 6.0);
  assert.equal(v[0].until, 8.9);
});

test('holdViolations: 声が始まってから出る字幕は、ナレーションと同じ文でも式で見る', () => {
  const tl = base();
  tl.texts[0].end = 3.1;
  const line = 'シーンの入力から sha256 を作り、キャッシュの鍵にします。';
  tl.narration[1] = { id: 'n02', scene: 's03', text: line, start: 6.0, audio: 'audio/narration/n02.wav', duration: 2.4 };
  tl.texts.push({ id: 't03', scene: 's03', kind: 'subtitle', text: line, start: 6.1, end: 9.0 });
  const v = holdViolations(tl);
  assert.equal(v.length, 1);
  assert.equal(v[0].need, minHold(line));
  assert.equal(v[0].narration, 'n02');
});

test('holdViolations: 声が始まる前に消える字幕は、ナレーションと同じ文でも式で見る', () => {
  const tl = base();
  tl.texts[0].end = 3.1;
  const line = 'シーンの入力から sha256 を作り、キャッシュの鍵にします。';
  tl.narration[1] = { id: 'n02', scene: 's03', text: line, start: 6.4, audio: 'audio/narration/n02.wav', duration: 2.0 };
  tl.texts.push({ id: 't03', scene: 's03', kind: 'subtitle', text: line, start: 6.0, end: 6.4 });
  const v = holdViolations(tl);
  assert.equal(v.length, 1);
  assert.equal(v[0].need, minHold(line));
});

test('holdViolations: 合成前は 1 秒 5 文字の見積もりで声の終わりを出す', () => {
  const tl = base();
  tl.texts[0].end = 3.1;
  const line = 'キャッシュの鍵にします。';
  tl.narration[1] = { id: 'n02', scene: 's03', text: line, start: 6.0, audio: null, duration: null };
  // 記号と空白は数えない（11 文字）
  const until = 6.0 + [...line.replace(/[\s\p{P}\p{S}]/gu, '')].length / 5 + 0.5;
  tl.texts.push({ id: 't03', scene: 's03', kind: 'subtitle', text: line, start: 6.0, end: until });
  assert.deepEqual(holdViolations(tl), []);
  tl.texts[2].end = until - 0.05;
  const v = holdViolations(tl);
  assert.equal(v.length, 1);
  assert.ok(Math.abs(v[0].until - until) < 1e-6, String(v[0].until));
});

test('holdViolations: 同じ文でも字幕（subtitle）でなければ、また文が違えば（空白以外の違いも）、式で見る', () => {
  const tl = base();
  tl.texts[0].end = 3.1;
  const line = 'シーンの入力から sha256 を作り、キャッシュの鍵にします。';
  tl.narration[1] = { id: 'n02', scene: 's03', text: line, start: 6.0, audio: 'audio/narration/n02.wav', duration: 2.4 };
  tl.texts.push({ id: 't03', scene: 's03', kind: 'caption', text: line, start: 6.0, end: 8.9 });
  let v = holdViolations(tl);
  assert.equal(v.length, 1);
  assert.equal(v[0].need, minHold(line));
  assert.equal(v[0].narration, undefined);
  // 空白の違いは同じ文とみなす
  tl.texts[2] = { ...tl.texts[2], kind: 'subtitle', text: line.replace(/ /g, '') };
  assert.deepEqual(holdViolations(tl), []);
  // 句読点が違えば同じ文とみなさない
  tl.texts[2] = { ...tl.texts[2], text: line.replace('、', '') };
  v = holdViolations(tl);
  assert.equal(v.length, 1);
  assert.equal(v[0].narration, undefined);
  // 要約した字幕も式で見る
  tl.texts[2] = { ...tl.texts[2], text: '入力の sha256 がキャッシュの鍵' };
  assert.equal(holdViolations(tl)[0].need, minHold('入力の sha256 がキャッシュの鍵'));
});

test('holdViolations: 同じシーンで同じ文を二度話すときは、字幕と時間の重なる行と比べる', () => {
  const tl = base();
  tl.texts[0].end = 3.1;
  const line = 'キャッシュの鍵にします。';
  tl.narration[1] = { id: 'n02', scene: 's03', text: line, start: 6.0, audio: 'audio/narration/n02.wav', duration: 1.0 };
  tl.narration.push({ id: 'n03', scene: 's03', text: line, start: 7.4, audio: 'audio/narration/n03.wav', duration: 1.0 });
  tl.texts.push({ id: 't03', scene: 's03', kind: 'subtitle', text: line, start: 7.4, end: 8.9 });
  assert.deepEqual(holdViolations(tl), []);
  tl.texts[2].end = 8.7;
  assert.equal(holdViolations(tl)[0].narration, 'n03');
});

test('narrationOverlaps: 前の行が話し終える前に次の行が始まると、シーンをまたいでも返す', () => {
  const tl = base();
  assert.deepEqual(narrationOverlaps(tl), []);
  tl.narration[0] = { ...tl.narration[0], audio: 'audio/narration/n01.wav', duration: 6.4 }; // 0.3 + 6.4 = 6.7 秒まで
  assert.deepEqual(narrationOverlaps(tl), [{ id: 'n01', next: 'n02', end: 6.7, nextStart: 6.5 }]);
  // 並び順が時刻順でなくても見つける
  tl.narration.reverse();
  assert.deepEqual(narrationOverlaps(tl), [{ id: 'n01', next: 'n02', end: 6.7, nextStart: 6.5 }]);
  // ちょうど話し終えた時刻に始まるのは重ならない
  tl.narration = tl.narration.map((n) => (n.id === 'n01' ? { ...n, duration: 6.2 } : n));
  assert.deepEqual(narrationOverlaps(tl), []);
});

test('narrationOverlaps: 合成前は 1 秒 5 文字の見積もりで、1 行が後ろの何行と重なっても全部返す', () => {
  const tl = base();
  tl.narration = [
    { id: 'n01', scene: 's03', text: 'あいうえおかきくけこさしすせそたちつてと', start: 5.0, audio: null, duration: null }, // 20/5 = 4 秒で 9.0 秒まで
    { id: 'n02', scene: 's03', text: 'な', start: 7.0, audio: null, duration: null },
    { id: 'n03', scene: 's03', text: 'に', start: 8.6, audio: null, duration: null }, // 1 秒 6 文字なら 8.33 秒で話し終え、重ならない
  ];
  assert.deepEqual(narrationOverlaps(tl).map((o) => [o.id, o.next]), [['n01', 'n02'], ['n01', 'n03']]);
});

test('cutOf は 1 始まり', () => {
  const r = cutOf(base(), 3.5);
  assert.equal(r.cut, 2);
  assert.equal(r.scene.id, 's02');
  assert.equal(cutOf(base(), 3.2).cut, 2); // 境界は後ろのシーン
  assert.equal(cutOf(base(), 9).cut, 3); // 終端は最後のシーン
});

test('settledTime: シーンの 70% の時刻。最後に出る文字が出て 0.6 秒たつ前なら、その時刻（終わりの1フレーム前まで）', () => {
  const tl = base();
  assert.equal(settledTime(tl, tl.scenes[0]), 2.24); // 0〜3.2 の 70%（t01 は 0.4 秒に出て、1.0 秒には落ち着いている）
  assert.equal(settledTime(tl, tl.scenes[2]), 8.1); // 文字のないシーン
  tl.texts[1].start = 4.8; // s02（3.2〜6）の 70% は 5.16。文字が 4.8 秒に出るなら 5.4
  assert.equal(settledTime(tl, tl.scenes[1]), 5.4);
  tl.texts[1].start = 5.8; // 6.4 はシーンの外なので、終わりの1フレーム前
  assert.equal(settledTime(tl, tl.scenes[1]), 5.967);
});

test('setSceneDuration: 伸ばすと後続がずれる', () => {
  const tl = base();
  const orig = structuredCopy(tl);
  const out = setSceneDuration(tl, 's01', 4.0);
  assert.deepEqual(tl, orig); // 入力は変えない
  assert.equal(out.scenes[0].end, 4.0);
  assert.equal(out.scenes[1].start, 4.0);
  assert.ok(Math.abs(out.scenes[1].end - 6.8) < 1e-9);
  assert.ok(Math.abs(out.texts[1].start - 4.8) < 1e-9);
  assert.ok(Math.abs(out.texts[1].end - 6.3) < 1e-9);
  assert.ok(Math.abs(out.narration[1].start - 7.3) < 1e-9);
  assert.ok(Math.abs(out.sfx[1].t - 5.0) < 1e-9);
  assert.equal(out.sfx[0].t, 0.43);
  assert.equal(out.texts[0].start, 0.4);
  assert.equal(out.poster, 2.5);
  assert.equal(validateTimeline(out).ok, true);
});

test('setSceneDuration: 縮めると end と sfx を新しい終端に収める', () => {
  const tl = base();
  const out = setSceneDuration(tl, 's01', 2.0);
  assert.equal(out.texts[0].end, 2.0);
  assert.equal(out.texts[0].start, 0.4);
  assert.ok(out.poster < 2.0);
  assert.equal(out.scenes[1].start, 2.0);
  assert.ok(Math.abs(out.texts[1].start - 2.8) < 1e-9);
  assert.equal(validateTimeline(out).ok, true);
  // シーン内の sfx が終端を越える場合は終端の 1 フレーム前
  const tl2 = base();
  tl2.sfx[0].t = 3.0;
  const out2 = setSceneDuration(tl2, 's01', 2.0);
  assert.ok(Math.abs(out2.sfx[0].t - (2.0 - 1 / 30)) < 1e-6);
});

test('setSceneDuration: 存在しない id と 0 以下は例外', () => {
  assert.throws(() => setSceneDuration(base(), 'sZZ', 2), /sZZ/);
  assert.throws(() => setSceneDuration(base(), 's01', 0), /尺/);
});

test('sceneSlice はシーンのローカル時刻にする', () => {
  const s = sceneSlice(base(), 's02');
  assert.equal(s.scene.start, 3.2);
  assert.deepEqual(s.texts.map((t) => t.id), ['t02']);
  assert.ok(Math.abs(s.texts[0].start - 0.8) < 1e-9);
  assert.ok(Math.abs(s.texts[0].end - 2.3) < 1e-9);
  assert.deepEqual(s.narration, []);
  assert.deepEqual(s.sfx.map((x) => x.id), ['x02']);
  assert.ok(Math.abs(s.sfx[0].t - 1.0) < 1e-9);
  assert.equal(sceneSlice(base(), 's03').narration[0].start, 0.5);
});

function structuredCopy(o) { return JSON.parse(JSON.stringify(o)); }

test('id は英数字と _ - だけ。シーンのファイル・声・BGM の指定は、制作フォルダの中の相対パスだけ', () => {
  const bad = (mutate) => {
    const tl = base();
    mutate(tl);
    return validateTimeline(tl);
  };
  assert.equal(bad(() => {}).ok, true);
  assert.match(bad((tl) => { tl.scenes[0].id = '../s01'; tl.texts[0].scene = '../s01'; tl.narration[0].scene = '../s01'; }).errors.join('\n'), /id/);
  assert.match(bad((tl) => { tl.narration[0].id = 'n/01'; }).errors.join('\n'), /n\/01/);
  assert.match(bad((tl) => { tl.scenes[0].file = '../../outside.html'; }).errors.join('\n'), /制作フォルダの中/);
  assert.match(bad((tl) => { tl.scenes[0].file = 'C:/Windows/x.html'; }).errors.join('\n'), /制作フォルダの中/);
  assert.match(bad((tl) => { tl.narration[0].audio = '/etc/passwd'; }).errors.join('\n'), /制作フォルダの中/);
  assert.match(bad((tl) => { tl.bgm = { file: '..\\..\\a.wav', bpm: null, gain: -18 }; }).errors.join('\n'), /制作フォルダの中/);
  assert.equal(bad((tl) => { tl.narration[0].audio = 'audio/narration/n01.wav'; tl.bgm = { file: 'audio/bgm.wav', bpm: 120, gain: -18 }; }).ok, true);
});
