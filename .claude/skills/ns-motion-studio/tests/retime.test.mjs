// 声の長さが変わったときの時刻の合わせ直し（retime.mjs）を検証する
import assert from 'node:assert/strict';
import test from 'node:test';
import { retimeToVoices } from '../scripts/retime.mjs';
import { holdViolations, narrationOverlaps, validateTimeline } from '../scripts/timeline.mjs';

/**
 * 3シーン。s01 は声 1 行（0.5〜2.5 秒、後ろに 1.5 秒の余白）、s02 は声 2 行（4.5〜5.5、6.0〜7.0、余白 1.0 秒）、s03 は声なし。
 */
function base() {
  return {
    version: 1, title: 't', fps: 30, ratios: ['16:9'], loop: false, seed: 1,
    scenes: [
      { id: 's01', start: 0, end: 4, file: 'src/scenes/s01.html' },
      { id: 's02', start: 4, end: 8, file: 'src/scenes/s02.html' },
      { id: 's03', start: 8, end: 10, file: 'src/scenes/s03.html' },
    ],
    texts: [
      { id: 't01', scene: 's01', kind: 'title', text: '短い題', start: 0.2, end: 4 },
      { id: 't02', scene: 's01', kind: 'caption', text: '語', start: 1.5, end: 3.5 },
      { id: 'u01', scene: 's01', kind: 'subtitle', text: '一つめの 行です', start: 0.5, end: 3.0 },
      { id: 'u02', scene: 's02', kind: 'subtitle', text: '二つめ', start: 4.5, end: 6.0 },
      { id: 'u03', scene: 's02', kind: 'subtitle', text: '三つめ', start: 6.0, end: 7.5 },
      { id: 't03', scene: 's03', kind: 'label', text: '終', start: 8.5, end: 9.5 },
    ],
    narration: [
      { id: 'n01', scene: 's01', text: '一つめの行です', start: 0.5, audio: 'audio/narration/n01.wav', duration: 2.0 },
      { id: 'n02', scene: 's02', text: '二つめ', start: 4.5, audio: 'audio/narration/n02.wav', duration: 1.0 },
      { id: 'n03', scene: 's02', text: '三つめ', start: 6.0, audio: 'audio/narration/n03.wav', duration: 1.0 },
    ],
    sfx: [
      { id: 'x01', t: 1.5, preset: 'pop' },
      { id: 'x02', t: 8.6, preset: 'pop' },
    ],
    bgm: null,
    poster: 9,
  };
}

const byId = (list, id) => list.find((x) => x.id === id);

test('声が短くなると、シーンを縮め、後ろのシーン・テキスト・効果音を前へ寄せる', () => {
  const { tl, rows } = retimeToVoices(base(), { n01: 1.0, n02: 0.5, n03: 0.5 });
  assert.deepEqual(tl.scenes.map((s) => [s.start, s.end]), [[0, 3], [3, 6], [6, 8]]);
  // 行の開始: シーンの頭からの間と、行の間は元のまま
  assert.deepEqual(tl.narration.map((n) => [n.start, n.duration]), [[0.5, 1], [3.5, 0.5], [4.5, 0.5]]);
  // 頭の前のテキストはシーンの頭からの秒を保ち、シーンの終わりまでのものは新しい終わりまで
  assert.deepEqual([byId(tl.texts, 't01').start, byId(tl.texts, 't01').end], [0.2, 3]);
  // 声の中のテキストは声に比例して動き、声の後ろは声の終わりからの秒を保つ
  assert.deepEqual([byId(tl.texts, 't02').start, byId(tl.texts, 't02').end], [1, 2.5]);
  assert.deepEqual([byId(tl.texts, 't03').start, byId(tl.texts, 't03').end], [6.5, 7.5]);
  // 効果音: 声の中は比例、声の無いシーンはずれた分だけ
  assert.deepEqual(tl.sfx.map((x) => x.t), [1, 6.6]);
  assert.equal(tl.poster, 7);
  assert.deepEqual(rows, [
    { scene: 's01', before: 4, after: 3 },
    { scene: 's02', before: 4, after: 3 },
    { scene: 's03', before: 2, after: 2 },
  ]);
});

test('声が長くなると、シーンを伸ばし、後ろをずらす', () => {
  const { tl } = retimeToVoices(base(), { n01: 3.0, n02: 2.0, n03: 1.0 });
  assert.deepEqual(tl.scenes.map((s) => [s.start, s.end]), [[0, 5], [5, 10], [10, 12]]);
  assert.deepEqual(tl.narration.map((n) => n.start), [0.5, 5.5, 8]);
  assert.deepEqual([byId(tl.texts, 't02').start, byId(tl.texts, 't02').end], [2, 4.5]);
  assert.deepEqual(tl.sfx.map((x) => x.t), [2, 10.6]);
  assert.equal(tl.scenes.at(-1).end, 12);
});

test('同じ文の字幕は、声の始まりまでに出て、声の終わり + 0.5 秒まで出る（短くても長くても）', () => {
  for (const d of [{ n01: 1.0, n02: 0.5, n03: 0.5 }, { n01: 3.0, n02: 2.0, n03: 1.4 }]) {
    const { tl } = retimeToVoices(base(), d);
    for (const [sub, line] of [['u01', 'n01'], ['u02', 'n02'], ['u03', 'n03']]) {
      const u = byId(tl.texts, sub);
      const n = byId(tl.narration, line);
      assert.ok(u.start <= n.start, `${sub} の開始 ${u.start} が声 ${n.start} より遅い`);
      assert.ok(u.end >= n.start + n.duration + 0.5 - 1e-9, `${sub} の終わり ${u.end} が足りない`);
      assert.ok(u.end <= byId(tl.scenes, n.scene).end + 1e-9);
    }
    assert.deepEqual(holdViolations(tl), []);
    assert.deepEqual(narrationOverlaps(tl), []);
    assert.deepEqual(validateTimeline(tl).errors, []);
  }
});

test('行の間が 0.5 秒より狭いときは 0.5 秒あける（字幕を声 + 0.5 秒まで出しても重ならない）', () => {
  const tl0 = base();
  tl0.narration[2].start = 5.6; // n02 の終わり 5.5 から 0.1 秒
  const { tl } = retimeToVoices(tl0, { n01: 2.0, n02: 1.0, n03: 1.0 });
  assert.equal(byId(tl.narration, 'n03').start, 6);
});

test('合成前（duration が null）は 1 秒 5 文字の見積もりを元の長さとみなす', () => {
  const tl0 = base();
  for (const n of tl0.narration) Object.assign(n, { audio: null, duration: null });
  // n01「一つめの行です」7 文字 → 1.4 秒（0.5〜1.9）、余白 2.1 秒。新しい声 3 秒なら 0.5〜3.5、終わり 5.6
  const { tl } = retimeToVoices(tl0, { n01: 3.0, n02: 0.6, n03: 0.6 });
  assert.equal(tl.scenes[0].end, 5.6);
});

test('同じ長さでもう一度合わせ直しても変わらない（作り直すたびに伸びたまま残らない）', () => {
  const once = retimeToVoices(base(), { n01: 1.0, n02: 0.5, n03: 0.5 }).tl;
  const twice = retimeToVoices(once, { n01: 1.0, n02: 0.5, n03: 0.5 }).tl;
  assert.deepEqual(twice, once);
  // 長くしてから元の長さに戻すと、元の時刻表に戻る
  const longer = retimeToVoices(base(), { n01: 3.0, n02: 2.0, n03: 1.0 }).tl;
  const back = retimeToVoices(longer, { n01: 2.0, n02: 1.0, n03: 1.0 }).tl;
  assert.deepEqual(back.scenes, base().scenes);
  assert.deepEqual(back.texts, base().texts);
  assert.deepEqual(back.sfx, base().sfx);
});

test('シーンの終わりまで出る文字は、縮めても読み切りの時間（minHold）を割らない', () => {
  const tl0 = base();
  // 1.5 秒から終わり 4 秒まで 2.5 秒出る、読み切りに 2.1 秒要る文字（8 文字 / 5 + 0.5）
  tl0.texts.push({ id: 't04', scene: 's01', kind: 'caption', text: 'あいうえおかきく', start: 1.5, end: 4 });
  const { tl } = retimeToVoices(tl0, { n01: 0.4, n02: 1.0, n03: 1.0 });
  // 声は 0.5〜0.9、余白 1.5 で 2.4 になるが、t04 は 0.5 + 0.2 = 0.7 秒から 2.1 秒要るので 2.8 まで伸ばす
  const t04 = byId(tl.texts, 't04');
  assert.equal(t04.start, 0.7);
  assert.equal(tl.scenes[0].end, 2.8);
  assert.equal(t04.end, 2.8);
});

test('BGM があれば、そのままにした offset と repeat を確かめ直すよう日本語で知らせる', () => {
  const tl0 = { ...base(), bgm: { file: 'audio/bgm.wav', bpm: 100, gain: -18 } };
  const { tl, warnings } = retimeToVoices(tl0, { n01: 1.0, n02: 0.5, n03: 0.5 });
  assert.deepEqual(tl.bgm, tl0.bgm);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /BGM.*offset.*repeat.*audio\.md/);
  // 長さが変わらなければ何も言わない
  assert.deepEqual(retimeToVoices(tl0, { n01: 2.0, n02: 1.0, n03: 1.0 }).warnings, []);
});

test('境目が拍に乗っていた時刻表は、拍に丸め直さずに、外れたことを知らせる', () => {
  // 90 bpm（1 拍 0.667 秒）: 境目 4・8・10 秒は 6・12・15 拍目
  const tl0 = { ...base(), bgm: { file: 'audio/bgm.wav', bpm: 90, gain: -18 } };
  const { tl, warnings } = retimeToVoices(tl0, { n01: 1.0, n02: 0.5, n03: 0.5 });
  assert.equal(tl.scenes[0].end, 3);
  assert.ok(warnings.some((w) => /拍.*乗って.*丸め/.test(w)), warnings.join('\n'));
});

/** 同じシーンの字幕（subtitle）が、前の字幕の終わる前に次の字幕が出ていないこと */
function assertNoSubtitleOverlap(tl) {
  for (const s of tl.scenes) {
    const subs = tl.texts.filter((t) => t.scene === s.id && t.kind === 'subtitle').sort((a, b) => a.start - b.start);
    for (let i = 1; i < subs.length; i++) {
      assert.ok(subs[i].start >= subs[i - 1].end - 1e-9, `${subs[i - 1].id}（〜${subs[i - 1].end}）と ${subs[i].id}（${subs[i].start}〜）が重なる`);
    }
  }
}

for (const [name, gapStart] of [['隙間なく続く（間 0 秒）', 5.5], ['前の声に重なっていた（間 -0.2 秒）', 5.3]]) {
  test(`行が${name}とき、字幕は重ならず、次の行に合わせた文字は次の声と一緒に出る`, () => {
    const tl0 = base();
    // n02 は 4.5〜5.5。n03 をその終わり（または手前）から始め、字幕の境目と、n03 に合わせたラベルを置く
    tl0.narration[2].start = gapStart;
    byId(tl0.texts, 'u02').end = gapStart;
    byId(tl0.texts, 'u03').start = gapStart;
    tl0.texts.push({ id: 't05', scene: 's02', kind: 'label', text: '印', start: gapStart, end: 7.5 });
    for (const d of [{ n01: 1.0, n02: 0.5, n03: 0.5 }, { n01: 3.0, n02: 2.0, n03: 1.0 }]) {
      const { tl } = retimeToVoices(tl0, d);
      const n03 = byId(tl.narration, 'n03');
      const n02 = byId(tl.narration, 'n02');
      assert.equal(n03.start, n02.start + n02.duration + 0.5);
      assert.equal(byId(tl.texts, 't05').start, n03.start);
      assert.equal(byId(tl.texts, 'u03').start, n03.start);
      assert.equal(byId(tl.texts, 'u02').end, n03.start);
      assertNoSubtitleOverlap(tl);
      assert.deepEqual(holdViolations(tl), []);
    }
  });
}

test('前の字幕が次の字幕の始まりより後まで出ていた時刻表でも、字幕を重ねない（声 + 0.5 秒は保つ）', () => {
  const tl0 = base();
  byId(tl0.texts, 'u02').end = 6.4; // 次の字幕 u03（6.0〜）と元から 0.4 秒重なっていた
  const { tl } = retimeToVoices(tl0, { n01: 2.0, n02: 1.0, n03: 1.0 });
  assertNoSubtitleOverlap(tl);
  assert.equal(byId(tl.texts, 'u02').end, 6);
});

test('声が次のカットへはみ出す行（J カット）は、シーンを延ばさず、カットの位置を声の中の同じ所に保つ', () => {
  const tl0 = {
    version: 1, fps: 30, ratios: ['16:9'],
    scenes: [{ id: 's01', start: 0, end: 2, file: 'a' }, { id: 's02', start: 2, end: 6, file: 'b' }],
    texts: [{ id: 't01', scene: 's02', kind: 'title', text: '題', start: 2, end: 6 }],
    // n01 は 0.5〜2.5 で、カット（2 秒）の後ろへ 0.5 秒はみ出す
    narration: [
      { id: 'n01', scene: 's01', text: '一つめの行です', start: 0.5, duration: 2.0 },
      { id: 'n02', scene: 's02', text: '二つめ', start: 3.5, duration: 1.0 },
    ],
    sfx: [{ id: 'x01', t: 2, preset: 'whoosh' }],
    bgm: null,
  };
  const same = retimeToVoices(tl0, { n01: 2.0, n02: 1.0 }).tl;
  assert.deepEqual(same.scenes, tl0.scenes);
  assert.deepEqual(same.sfx, tl0.sfx);
  // 声が 1.5 倍になれば、カットも声の中の同じ所（0.5 + 1.5 × 1.5 = 2.75 秒）へ
  const longer = retimeToVoices(tl0, { n01: 3.0, n02: 1.0 }).tl;
  assert.equal(longer.scenes[0].end, 2.75);
  assert.equal(longer.sfx[0].t, 2.75);
  assert.equal(byId(longer.narration, 'n02').start, 4.25);
});

test('シーンが2つ（境目1つ）でも、拍に乗っていた境目が外れたら知らせる', () => {
  // 120 bpm（1 拍 0.5 秒）、offset 0。境目 4 秒は 8 拍目
  const tl0 = {
    version: 1, fps: 30, ratios: ['16:9'],
    scenes: [{ id: 's01', start: 0, end: 4, file: 'a' }, { id: 's02', start: 4, end: 6, file: 'b' }],
    texts: [],
    narration: [{ id: 'n01', scene: 's01', text: '一つめ', start: 0.5, duration: 2.0 }],
    sfx: [],
    bgm: { file: 'audio/bgm.wav', bpm: 120, gain: -18 },
  };
  const { tl, warnings } = retimeToVoices(tl0, { n01: 1.3 });
  assert.equal(tl.scenes[0].end, 3.3);
  assert.ok(warnings.some((w) => /拍.*乗って.*丸め/.test(w)), warnings.join('\n'));
  // 拍の上へ動いたなら（2.0 → 1.5 で 3.5 秒 = 7 拍目）言わない
  assert.ok(!retimeToVoices(tl0, { n01: 1.5 }).warnings.some((w) => /拍.*乗って/.test(w)));
});

test('J カットの声が長くなっても、次のシーンの最初の行は、はみ出した声の終わり + 0.5 秒より前に始めない', () => {
  // s1 は 0〜5。n1 は 1〜6 でカットをまたぐ。s2 の最初の行 n2 は 6.5 から
  const tl0 = {
    version: 1, fps: 30, ratios: ['16:9'],
    scenes: [{ id: 's1', start: 0, end: 5, file: 'a' }, { id: 's2', start: 5, end: 9, file: 'b' }, { id: 's3', start: 9, end: 11, file: 'c' }],
    texts: [
      { id: 't1', scene: 's2', kind: 'label', text: '印', start: 6.5, end: 8 },
      { id: 't2', scene: 's3', kind: 'label', text: '終', start: 9.5, end: 10.5 },
    ],
    narration: [
      { id: 'n1', scene: 's1', text: '長い一つめの行', start: 1, duration: 5 },
      { id: 'n2', scene: 's2', text: '二つめ', start: 6.5, duration: 1 },
    ],
    sfx: [{ id: 'x1', t: 6.5, preset: 'pop' }],
    bgm: null,
  };
  const { tl } = retimeToVoices(tl0, { n1: 8, n2: 1 });
  const n1 = byId(tl.narration, 'n1');
  const n2 = byId(tl.narration, 'n2');
  // カットは声の中の同じ所（1 + 4 × 8/5 = 7.4）
  assert.equal(tl.scenes[0].end, 7.4);
  assert.equal(n2.start, n1.start + n1.duration + 0.5);
  assert.deepEqual(narrationOverlaps(tl), []);
  assert.deepEqual(validateTimeline(tl).errors, []);
  // n2 に合わせた文字と効果音も n2 と一緒に動き、後ろのシーンもずれる
  assert.equal(byId(tl.texts, 't1').start, n2.start);
  assert.equal(tl.sfx[0].t, n2.start);
  assert.ok(tl.scenes[1].end >= n2.start + 1 + 0.5);
  assert.equal(tl.scenes[2].end - tl.scenes[2].start, 2);
  // 声が元の長さなら何も変えない
  assert.deepEqual(retimeToVoices(tl0, { n1: 5, n2: 1 }).tl.scenes, tl0.scenes);
});
