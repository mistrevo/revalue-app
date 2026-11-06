// 声の長さが変わったとき（合成した、声や速さを変えた、原稿を直した）に、時刻表を新しい声に合わせ直す。
// narration.mjs が合成の後に自動で呼ぶ。伸ばすだけでなく縮めもする。
//
// 決まり（シーンごとに、前から順に）:
// - シーンの頭から最初の行までの間は元のまま。行の間も元のまま（ただし字幕を声 + 0.5 秒まで出せるよう 0.5 秒以上あける）。
// - シーンの終わり = 最後の声の終わり + 元の余白（最後の声の終わりからシーンの終わりまで。0.5 秒より短ければ 0.5 秒）。
//   ただし、合成済みの声が元からカットの後ろへはみ出していた（J カット）シーンは延ばさず、カットを声の中の同じ所に保つ。
//   そのときは、次のシーンの最初の行を、はみ出した声の終わり + 0.5 秒より前には始めない（頭の間の文字は比例で動く）。
//   ただし、シーンの終わりまで出る文字が読み切りの時間（minHold）を割るなら、その分だけ延ばす。
// - テキストと効果音とポスターの時刻は、シーンの頭・各行の始まりと終わりを基準に写す。
//   声の中は声に比例して動き（話している語に合わせた文字は語に付いて動く）、声の外は直前の基準からの秒を保つ。
//   シーンの絵は ms.time でテキストの時刻から動くので、絵も文字に付いて動く。
// - ナレーションと同じ文の字幕は、その声の始まりまでに出し、声の終わり + 0.5 秒まで出す。同じシーンの字幕どうしは重ねない。
// - 声の無いシーンは長さを変えず、前のシーンの変化の分だけずらす。
// - BGM の offset と repeat、拍への揃えは変えない（曲のどこをどこに合わせるかは人が決める）。変わったら知らせる。
import { minHold, speechSeconds } from './timeline.mjs';

/** 字幕を声の終わりから出しておく秒数（timeline.mjs の holdViolations と同じ）。行の間と、シーンの最後の余白の下限にも使う */
const SUBTITLE_TAIL = 0.5;
const EPS = 1e-6;
const round = (x) => Math.round(x * 1000) / 1000;
const sameText = (a, b) => a.replace(/\s/g, '') === b.replace(/\s/g, '');

/**
 * 基準点（元の時刻 → 新しい時刻）の間を直線で写す関数を作る。最初の点より前と最後の点より後ろは、その点からの秒を保つ。
 * 元の時刻が同じ点が並ぶとき（前の行の終わり = 次の行の始まり）は、そこで新しい時刻が跳ぶ。
 * ちょうどその時刻は後ろの点（次の行の始まり）へ写す（次の行に合わせた文字は次の声と一緒に出る）。
 * @param {Array<[number, number]>} points 元の時刻の順
 */
function piecewise(points) {
  const pts = [];
  for (const p of points) {
    const last = pts.at(-1);
    if (!last || (p[0] >= last[0] - EPS && p[1] >= last[1] - EPS)) pts.push(p);
  }
  return (x) => {
    if (x < pts[0][0] - EPS) return pts[0][1] + (x - pts[0][0]);
    let j = 0;
    while (j + 1 < pts.length && pts[j + 1][0] <= x + EPS) j++;
    const a = pts[j];
    const b = pts[j + 1];
    if (!b) return a[1] + (x - a[0]);
    return a[1] + ((x - a[0]) * (b[1] - a[1])) / (b[0] - a[0]);
  };
}

/**
 * 新しい声の長さに合わせて、時刻表を組み直す（入力は変えない）。
 * 元の声の長さは、合成済みなら duration、まだなら 1 秒 5 文字の見積もり（speechSeconds）。
 * @param {import('./timeline.mjs').Timeline} tl 合わせ直す前の時刻表
 * @param {Record<string, number>} durations ナレーションの id ごとの新しい声の長さ（秒）
 * @returns {{tl: import('./timeline.mjs').Timeline, rows: Array<{scene: string, before: number, after: number}>, warnings: string[]}}
 */
export function retimeToVoices(tl, durations) {
  const oldLen = (n) => speechSeconds(n);
  const newLen = (n) => durations[n.id] ?? speechSeconds(n);
  const maps = [];
  const newStarts = new Map();
  let cursor = tl.scenes[0]?.start ?? 0;
  /** 前のシーンからカットをまたいで続く声（J カット）の終わり + 0.5 秒。次に行のあるシーンの最初の行は、これより前に始めない */
  let notBefore = -Infinity;

  for (const s of tl.scenes) {
    const s0 = cursor;
    const lines = tl.narration.filter((n) => n.scene === s.id).sort((a, b) => a.start - b.start);
    const points = [[s.start, s0]];
    let prevOldEnd = s.start;
    let prevNewEnd = s0;
    let lastOldEnd = -Infinity;
    let lastNewEnd = -Infinity;
    lines.forEach((n, i) => {
      const lead = n.start - (i === 0 ? s.start : prevOldEnd);
      const start = round(i === 0 ? Math.max(prevNewEnd + lead, notBefore) : prevNewEnd + Math.max(lead, SUBTITLE_TAIL));
      const end = round(start + newLen(n));
      newStarts.set(n.id, start);
      // 元で次の行が前の声の終わりより前に始まっていたら（声が重なっていた）、前の行の基準は次の行の始まりで切る
      const next = lines[i + 1];
      const cut = next ? Math.max(n.start, Math.min(n.start + oldLen(n), next.start)) : n.start + oldLen(n);
      const ratio = oldLen(n) > 0 ? newLen(n) / oldLen(n) : 1;
      points.push([n.start, start], [cut, round(start + (cut - n.start) * ratio)]);
      prevOldEnd = n.start + oldLen(n);
      prevNewEnd = end;
      lastOldEnd = Math.max(lastOldEnd, prevOldEnd);
      lastNewEnd = Math.max(lastNewEnd, end);
    });
    const map = piecewise(points);

    // 合成済みの声が元からカットの後ろへはみ出していた（J カット）シーンは、カットを声の中の同じ所に保ち、延ばさない
    const jcut = lines.some((n) => typeof n.duration === 'number' && n.duration > 0 && n.start + n.duration > s.end + EPS);
    let end = !lines.length ? round(s0 + (s.end - s.start))
      : jcut ? round(map(s.end))
        : round(lastNewEnd + Math.max(s.end - lastOldEnd, SUBTITLE_TAIL));
    // シーンの終わりまで出る文字が、元は読み切れていたのに縮めて読み切れなくなるなら、終わりを延ばす
    for (const t of tl.texts) {
      if (t.scene !== s.id || Math.abs(t.end - s.end) > EPS || t.end - t.start < minHold(t.text) - EPS) continue;
      end = Math.max(end, round(map(t.start) + minHold(t.text)));
    }
    maps.push({ old: s, start: s0, end, lines, map });
    if (lines.length) notBefore = -Infinity;
    // 声がこのシーンの終わりを越えて続くなら、次のシーンの最初の行をその声の終わり + 0.5 秒より後ろへ
    if (lastNewEnd > end + EPS) notBefore = Math.max(notBefore, round(lastNewEnd + SUBTITLE_TAIL));
    cursor = end;
  }

  const sceneMap = (id) => maps.find((m) => m.old.id === id);
  /** シーンの中の時刻を写す（元のシーンの終わりはちょうど新しい終わりへ。シーンの外へは出さない） */
  const within = (m, x) => {
    if (Math.abs(x - m.old.end) < EPS) return m.end;
    return round(Math.min(m.end, Math.max(m.start, m.map(x))));
  };
  /** 動画の中の時刻を、その時刻を含む元のシーンの決まりで写す（最後のシーンより後ろはずれた分だけ） */
  const total = maps.length ? maps.at(-1).end - maps.at(-1).old.end : 0;
  const anywhere = (x) => {
    const m = maps.find((mm) => x >= mm.old.start - EPS && x < mm.old.end - EPS);
    return m ? within(m, x) : round(x + total);
  };

  /** 同じ文の字幕が出ていなければならない終わり（声の終わり + 0.5 秒）。字幕の id ごと */
  const mustShowUntil = new Map();
  const texts = tl.texts.map((t) => {
    const m = sceneMap(t.scene);
    if (!m) return { ...t };
    let start = within(m, t.start);
    let end = within(m, t.end);
    const same = t.kind === 'subtitle' ? m.lines.filter((n) => sameText(n.text, t.text)) : [];
    if (same.length) {
      const n = same.reduce((a, b) => (Math.abs(b.start - t.start) < Math.abs(a.start - t.start) ? b : a));
      const ns = newStarts.get(n.id);
      start = Math.min(start, ns);
      const until = round(Math.min(m.end, ns + newLen(n) + SUBTITLE_TAIL));
      mustShowUntil.set(t.id, until);
      end = Math.max(Math.min(end, m.end), until);
    }
    return { ...t, start, end };
  });
  // 同じシーンの字幕は重ねない。前の字幕は次の字幕の始まりで切る。ただし声 + 0.5 秒より前では切らず、
  // そのときは次の字幕の始まりを遅らせる（行の間は 0.5 秒以上あるので、次の声の始まりは越えない）
  for (const m of maps) {
    const subs = texts.filter((t) => t.scene === m.old.id && t.kind === 'subtitle').sort((a, b) => a.start - b.start);
    for (let i = 1; i < subs.length; i++) {
      const [a, b] = [subs[i - 1], subs[i]];
      if (a.end <= b.start + EPS) continue;
      a.end = Math.max(b.start, mustShowUntil.get(a.id) ?? -Infinity);
      if (a.end > b.start && a.end < b.end) b.start = a.end;
    }
  }

  const out = {
    ...tl,
    scenes: maps.map((m) => ({ ...m.old, start: m.start, end: m.end })),
    texts,
    narration: tl.narration.map((n) => {
      const start = newStarts.get(n.id) ?? anywhere(n.start);
      return n.id in durations ? { ...n, start, duration: durations[n.id] } : { ...n, start };
    }),
    sfx: (tl.sfx ?? []).map((x) => ({ ...x, t: anywhere(x.t) })),
    ...(tl.poster == null ? {} : { poster: anywhere(tl.poster) }),
  };
  const rows = maps.map((m) => ({ scene: m.old.id, before: round(m.old.end - m.old.start), after: round(m.end - m.start) }));
  return { tl: out, rows, warnings: musicWarnings(tl, out) };
}

/**
 * BGM の合わせ（拍とカットの境目、締めの和音とロゴ）が崩れたかもしれないことの知らせ。
 * @param {import('./timeline.mjs').Timeline} before
 * @param {import('./timeline.mjs').Timeline} after
 */
function musicWarnings(before, after) {
  const moved = before.scenes.some((s, i) => Math.abs(s.end - after.scenes[i].end) > EPS);
  if (!before.bgm || !moved) return [];
  const total = (tl) => round(tl.scenes.at(-1).end - tl.scenes[0].start);
  const out = [`注意: 声に合わせてカットの長さが変わりました（総尺 ${total(before)} → ${total(after)} 秒）。BGM の offset と repeat はそのままです。拍とカットの境目、締めの和音とロゴの時刻が合っているかを確かめ直してください（audio.md の「声の長さが変わったとき」）。`];
  const bpm = before.bgm.bpm;
  const ends = (tl) => tl.scenes.slice(0, -1).map((s) => s.end);
  if (typeof bpm === 'number' && bpm > 0 && ends(before).length >= 1) {
    const beat = 60 / bpm;
    // 境目が2つ以上なら、最初の境目を拍の位置の基準にする。1つだけなら、曲の頭（offset の分だけ前）を拍の頭とみなす
    const phase = ends(before).length >= 2 ? ends(before)[0] : -(before.bgm.offset ?? 0);
    const onGrid = (t) => { const k = (t - phase) / beat; return Math.abs(k - Math.round(k)) * beat < 0.02; };
    if (ends(before).every(onGrid) && !ends(after).every(onGrid)) {
      out.push(`注意: カットの境目は元は BGM の拍（${bpm} bpm）に乗っていましたが、合わせ直しで外れました。拍へは自動で丸めません。境目を拍の頭へ動かすなら、シーンの終わりを延ばしてから timeline.mjs validate を通してください。`);
    }
  }
  return out;
}

/**
 * 合わせ直した結果を、利用者に見せる短い表にする。
 * @param {Array<{scene: string, before: number, after: number}>} rows
 */
export function retimeTable(rows) {
  const sum = (k) => round(rows.reduce((a, r) => a + r[k], 0));
  const lines = rows.map((r) => {
    const d = round(r.after - r.before);
    return `  ${r.scene}: ${r.before} → ${r.after} 秒${d === 0 ? '' : `（${d > 0 ? '+' : ''}${d}）`}`;
  });
  return [`声に合わせて時刻を合わせ直しました（総尺 ${sum('before')} → ${sum('after')} 秒）`, ...lines].join('\n');
}

