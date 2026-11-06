// timeline.json の読み書き、検証、時間の計算。言葉と時間の正本である timeline.json を扱う。
//   node timeline.mjs validate <制作フォルダ>          形の誤り、文字の表示時間の不足、ナレーションの声の重なりを出す（あれば終了コード 1）
//   node timeline.mjs slice <制作フォルダ> <シーンid>   シーンの文字と時刻を、シーン内の時刻にして JSON で出す
import fs from 'node:fs';
import path from 'node:path';
import { isMain, replaceFile } from './paths.mjs';

/**
 * @typedef {{id: string, start: number, end: number, purpose?: string, file?: string}} Scene
 * @typedef {{id: string, scene: string, kind?: string, text: string, start: number, end: number}} Text
 * @typedef {{id: string, scene: string, text: string, start: number, audio?: string|null, duration?: number|null}} Narration
 * @typedef {{id: string, t: number, preset: string, gain?: number}} Sfx
 * @typedef {{version: number, title?: string, fps: number, ratios: string[], loop?: boolean, seed?: number,
 *   scenes: Scene[], texts: Text[], narration: Narration[], sfx: Sfx[], bgm: object|null, poster?: number}} Timeline
 */

/** 比率ごとの出力解像度 [幅, 高さ]。 */
export const RATIOS = {
  '16:9': [1920, 1080],
  '9:16': [1080, 1920],
  '1:1': [1080, 1080],
  '4:5': [1080, 1350],
};

const FPS_LIST = [24, 25, 30, 60];
const MAX_SECONDS = 300;
/** シーンのつなぎ目で許す誤差（秒）。 */
const GAP_TOLERANCE = 0.001;
/** 浮動小数の誤差を落とす桁（マイクロ秒）。 */
const round = (x) => Math.round(x * 1e6) / 1e6;

/**
 * timeline を検査する。
 * @param {Timeline} tl
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateTimeline(tl) {
  const errors = [];
  const scenes = tl.scenes ?? [];
  const texts = tl.texts ?? [];
  const narration = tl.narration ?? [];
  const sceneById = new Map(scenes.map((s) => [s.id, s]));

  if (!FPS_LIST.includes(tl.fps)) errors.push(`fps は ${FPS_LIST.join('、')} のどれかにしてください（現在 ${tl.fps}）`);
  for (const r of tl.ratios ?? []) {
    if (!(r in RATIOS)) errors.push(`ratios の ${r} は使えません（${Object.keys(RATIOS).join('、')} のどれか）`);
  }

  if (!scenes.length) errors.push('scenes が空です（シーンを1つ以上書いてください）');
  for (let i = 1; i < scenes.length; i++) {
    if (Math.abs(scenes[i].start - scenes[i - 1].end) > GAP_TOLERANCE) {
      errors.push(`${scenes[i].id} の開始が ${scenes[i - 1].id} の終了と一致しません`);
    }
  }
  if (scenes.length > 0) {
    const total = scenes[scenes.length - 1].end - scenes[0].start;
    if (total > MAX_SECONDS) errors.push(`総尺が ${round(total)} 秒で、5分（${MAX_SECONDS}秒）を超えています。章ごとの連作にしてください`);
  }

  for (const t of texts) {
    const sc = sceneById.get(t.scene);
    if (!sc) {
      errors.push(`テキスト ${t.id} のシーン ${t.scene} が見つかりません`);
    } else if (t.start < sc.start - GAP_TOLERANCE || t.end > sc.end + GAP_TOLERANCE || t.end <= t.start) {
      errors.push(`テキスト ${t.id} の区間がシーン ${sc.id} の中に収まっていません`);
    }
  }
  for (const n of narration) {
    if (!sceneById.has(n.scene)) errors.push(`ナレーション ${n.id} のシーン ${n.scene} が見つかりません`);
  }
  // 曲の長さはファイルを読まないと分からないので、ここでは形だけ確かめる（長さは mix.mjs が確かめる）
  const offsetError = bgmOffsetError(tl.bgm);
  if (offsetError) errors.push(offsetError);
  const repeatError = bgmRepeatError(tl.bgm);
  if (repeatError) errors.push(repeatError);

  const seen = new Set();
  const dup = new Set();
  for (const id of [...scenes, ...texts, ...narration, ...(tl.sfx ?? [])].map((x) => x.id)) {
    if (seen.has(id) && !dup.has(id)) {
      dup.add(id);
      errors.push(`id ${id} が重複しています`);
    }
    seen.add(id);
  }

  // id はファイル名にも使うので、英数字と _ - だけ（../ などで制作フォルダの外に書かせない）
  const ID = /^[A-Za-z0-9_-]+$/;
  for (const [what, list] of [['scenes', scenes], ['texts', texts], ['narration', narration], ['sfx', tl.sfx ?? []]]) {
    for (const x of list) {
      if (typeof x.id !== 'string' || !ID.test(x.id)) errors.push(`${what} の id「${x.id}」は、英数字と _ - だけにしてください（ファイル名に使うため）`);
    }
  }
  // ファイルの指定は、制作フォルダの中の相対パスだけ（絶対パスや .. で外を読み書きさせない）
  const inside = (p) => typeof p === 'string' && p.length > 0 && !path.isAbsolute(p) && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]+/).includes('..');
  const outside = (what, p) => `${what}「${p}」は、制作フォルダの中の相対パスにしてください（例: src/scenes/s01.html）`;
  for (const s of scenes) if (s.file != null && !inside(s.file)) errors.push(outside(`シーン ${s.id} の file`, s.file));
  for (const n of narration) if (n.audio != null && !inside(n.audio)) errors.push(outside(`ナレーション ${n.id} の audio`, n.audio));
  if (tl.bgm?.file != null && !inside(tl.bgm.file)) errors.push(outside('bgm の file', tl.bgm.file));
  return { ok: errors.length === 0, errors };
}

/** bgm.repeat のつなぎ目で、前後を重ねる秒数（from の手前のこの長さを、to の手前と重ねる） */
export const BGM_REPEAT_XFADE = 0.08;

/**
 * bgm.repeat（曲の from 秒から to 秒までを times 回くり返す。to まで鳴らしたら from へ戻って続ける）の形の誤り。無ければ問わない。
 * 生成した曲が動画より短いときに、拍の頭（小節の頭）で区間をくり返して伸ばすために使う。
 * from は、つなぎ目を重ねる分（BGM_REPEAT_XFADE）を手前から取れるよう、その秒数以上にする。
 * @param {any} bgm
 * @returns {string|null}
 */
export function bgmRepeatError(bgm) {
  const r = bgm?.repeat;
  if (r == null) return null;
  const num = (x) => typeof x === 'number' && Number.isFinite(x);
  if (typeof r !== 'object' || Array.isArray(r) || !num(r.from) || !num(r.to) || r.from < BGM_REPEAT_XFADE || r.to - r.from < 1
    || (r.times !== undefined && !(Number.isInteger(r.times) && r.times >= 1))) {
    return `bgm.repeat は {"from": <秒>, "to": <秒>, "times": <回数>} の形で、${BGM_REPEAT_XFADE} ≦ from（曲の頭から少し離す）、to は from より 1 秒以上あと、times は 1 以上の整数（省くと 1）にしてください（現在 ${JSON.stringify(r)}）`;
  }
  return null;
}

/**
 * bgm.offset（曲のどの位置から使うか、秒）の形の誤り。無い（undefined か null）なら問わない
 * @param {any} bgm
 * @returns {string|null}
 */
export function bgmOffsetError(bgm) {
  const offset = bgm?.offset;
  if (offset == null || (typeof offset === 'number' && Number.isFinite(offset) && offset >= 0)) return null;
  return `bgm.offset は、曲のどの位置から使うかを 0 以上の秒（数）で書いてください（現在 ${typeof offset === 'string' ? `"${offset}"（文字）` : String(offset)}）`;
}

/**
 * 文字を読み切るのに必要な最短の表示秒数。
 * 日本語（ひらがな・カタカナ・漢字を含む）は 和文の文字数/5 + 0.3 * 英数字の語数 + 0.5、それ以外は 0.3 * 語数 + 0.5。
 * 文字数には空白と記号を数えない。日本語の中の英単語や数字（Azure、Serverless、2026）は、
 * 1文字ずつではなく、ひとつながりを1語として英語と同じ 0.3 秒で数える。
 * @param {string} text
 * @returns {number}
 */
export function minHold(text) {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(text)) {
    const latinWords = (text.match(/[\p{Script=Latin}\p{Nd}]+/gu) ?? []).length;
    const rest = text.replace(/[\p{Script=Latin}\p{Nd}]+/gu, '');
    const chars = [...rest.replace(/[\s\p{P}\p{S}]/gu, '')].length;
    return round(chars / 5 + 0.3 * latinWords + 0.5);
  }
  const words = text.split(/\s+/).filter(Boolean).length;
  return round(0.3 * words + 0.5);
}

/**
 * ナレーションが話される長さ。合成済みなら duration、まだなら 1 秒 5 文字の見積もり（storyboard.md の見積もりと同じ。
 * 空白と記号は数えない。試作で測った声は 1 秒 4.8〜5.6 文字で、6 文字で見積もると短く出て、表示時間と声の重なりの点検が甘くなった）。
 * @param {{text: string, duration?: number|null}} n
 */
export function speechSeconds(n) {
  if (typeof n.duration === 'number' && n.duration > 0) return round(n.duration);
  return round([...n.text.replace(/[\s\p{P}\p{S}]/gu, '')].length / 5);
}

/** ナレーションと同じ文の字幕を、声が終わってからも出しておく秒数（読む速さの式の基本の 0.5 秒と同じ） */
const SUBTITLE_TAIL = 0.5;

/** 空白だけを除いて比べる（句読点や全角・半角の違いは同じ文とみなさない） */
const sameText = (a, b) => a.replace(/\s/g, '') === b.replace(/\s/g, '');

/**
 * 表示時間が最短に満たないテキストを返す。
 * 最短は読む速さの式（minHold）。ただし、ナレーションと同じ文の字幕（subtitle）が、その声の始まりまでに出て、
 * 話し終えて SUBTITLE_TAIL 秒たつまで出ているなら、声と一緒に読めるので、式より短くてもよい
 * （音を出さずに見る人にも、声の間ずっと字幕が出ている）。同じ文かどうかは空白だけを除いて比べる。
 * 指摘に narration・from・until があれば、そのナレーションに合わせて from 秒までに出し until 秒まで出せば、式より短くてよい。
 * @param {Timeline} tl
 * @returns {Array<{id: string, need: number, actual: number, narration?: string, from?: number, until?: number}>}
 */
export function holdViolations(tl) {
  const out = [];
  for (const t of tl.texts ?? []) {
    const actual = t.end - t.start;
    const lines = t.kind === 'subtitle'
      ? (tl.narration ?? []).filter((n) => n.scene === t.scene && sameText(n.text, t.text))
          .map((n) => ({ n, from: n.start, until: round(n.start + speechSeconds(n) + SUBTITLE_TAIL) }))
      : [];
    if (lines.some((l) => t.start <= l.from + 1e-6 && t.end >= l.until - 1e-6)) continue;
    const need = minHold(t.text);
    if (actual >= need - 1e-9) continue;
    // 同じ文を二度話すシーンでは、字幕といちばん長く時間の重なる行に合わせる時刻を添える
    const overlap = (l) => Math.min(t.end, l.until) - Math.max(t.start, l.from);
    const hint = lines.reduce((best, l) => (best && overlap(best) >= overlap(l) ? best : l), undefined);
    out.push(hint ? { id: t.id, need, actual, narration: hint.n.id, from: hint.from, until: hint.until } : { id: t.id, need, actual });
  }
  return out;
}

/**
 * 表示時間の不足を、利用者に見せる文の後ろに添える言葉（ナレーションに合わせれば短くてよいとき）。
 * @param {{narration?: string, from?: number, until?: number}} h
 */
export function holdHint(h) {
  if (!h.narration) return '';
  return `ナレーション ${h.narration} と同じ文の字幕なので、声の始まる ${h.from} 秒までに出し、話し終えて ${SUBTITLE_TAIL} 秒後の ${h.until} 秒まで出しておけば、それより短くてもかまいません。`;
}

/**
 * 声が重なるナレーションの組を返す。動画全体を開始の順に見る（前のシーンからはみ出した声も数える）。
 * 話す長さは speechSeconds（合成済みなら実際の長さ、まだなら見積もり）。
 * @param {Timeline} tl
 * @returns {Array<{id: string, next: string, end: number, nextStart: number}>}
 */
export function narrationOverlaps(tl) {
  const lines = [...(tl.narration ?? [])].sort((a, b) => a.start - b.start);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const end = round(lines[i].start + speechSeconds(lines[i]));
    for (let j = i + 1; j < lines.length && lines[j].start < end - 1e-9; j++) {
      out.push({ id: lines[i].id, next: lines[j].id, end, nextStart: lines[j].start });
    }
  }
  return out;
}

/**
 * 声の重なりを、利用者に見せる文にする。
 * @param {{id: string, next: string, end: number, nextStart: number}} o
 */
export function overlapMessage(o) {
  return `ナレーション ${o.id} が ${o.end} 秒まで話していて、${o.next} の始まる ${o.nextStart} 秒と声が重なります。${o.next} の開始を遅らせるか、${o.id} を短くしてください`;
}

/**
 * 時刻 t が属するカットを返す。カット番号は 1 始まり。
 * 境目は後ろのシーンに属する。範囲外は端のシーンに寄せる。
 * @param {Timeline} tl
 * @param {number} t
 * @returns {{cut: number, scene: Scene}}
 */
export function cutOf(tl, t) {
  const scenes = tl.scenes;
  let i = scenes.findIndex((s) => t >= s.start && t < s.end);
  if (i < 0) i = t < scenes[0].start ? 0 : scenes.length - 1;
  return { cut: i + 1, scene: scenes[i] };
}

/** 落ち着いた時刻の、シーンの中の位置（0〜1） */
const SETTLED_FRACTION = 0.7;
/** 文字が出てから、入場の動きが終わって落ち着くまでの目安（秒） */
const SETTLE_AFTER_TEXT = 0.6;

/**
 * シーンの代表スチルを撮る、入場が終わって落ち着いた時刻（動画の先頭からの秒）。
 * シーンの 70% の時刻。ただし、そのシーンで最後に出る文字が出てから 0.6 秒たっていなければ、その時刻まで後ろへずらす
 * （シーンの終わりの1フレーム前まで）。中央の時刻だと、ロゴの拭き取りなどの入場の途中を撮ってしまうため。
 * @param {Timeline} tl
 * @param {Scene} scene
 * @returns {number}
 */
export function settledTime(tl, scene) {
  const lastText = Math.max(-Infinity, ...tl.texts.filter((x) => x.scene === scene.id).map((x) => x.start));
  const t = Math.max(scene.start + (scene.end - scene.start) * SETTLED_FRACTION, lastText + SETTLE_AFTER_TEXT);
  return Math.round(Math.min(t, scene.end - 1 / tl.fps) * 1000) / 1000;
}

/**
 * シーンの尺を変え、後ろの時刻を同じ量だけずらした新しい timeline を返す（入力は変えない）。
 * - 後続シーンと、その中のテキスト・ナレーション、シーン終端以降の効果音は delta だけずらす。
 * - 対象シーン内の開始位置は保つ（比例では伸縮しない）。縮めたときだけ、
 *   テキストの end と start を新しい終端に収め、ナレーションの start は終端より前に収める。
 * - 対象シーン内の効果音は、新しい終端を越えるなら終端の 1 フレーム前に置く。
 * - poster は、対象シーンより後ろならずらし、対象シーン内で終端を越えるなら終端の 1 フレーム前に収める。
 * @param {Timeline} tl
 * @param {string} sceneId
 * @param {number} newDuration 秒
 * @returns {Timeline}
 */
export function setSceneDuration(tl, sceneId, newDuration) {
  const idx = tl.scenes.findIndex((s) => s.id === sceneId);
  if (idx < 0) throw new Error(`シーン ${sceneId} が見つかりません`);
  if (!(newDuration > 0)) throw new Error('シーンの尺は 0 より大きくしてください');
  const target = tl.scenes[idx];
  const delta = round(newDuration - (target.end - target.start));
  const oldEnd = target.end;
  const newEnd = round(target.start + newDuration);
  const frame = 1 / tl.fps;
  const later = new Set(tl.scenes.slice(idx + 1).map((s) => s.id));
  const shift = (x) => round(x + delta);
  const inside = (x) => Math.min(x, round(newEnd - frame));

  return {
    ...tl,
    scenes: tl.scenes.map((s, i) => {
      if (i === idx) return { ...s, end: newEnd };
      return i > idx ? { ...s, start: shift(s.start), end: shift(s.end) } : { ...s };
    }),
    texts: tl.texts.map((t) => {
      if (later.has(t.scene)) return { ...t, start: shift(t.start), end: shift(t.end) };
      if (t.scene === sceneId) return { ...t, start: inside(t.start), end: Math.min(t.end, newEnd) };
      return { ...t };
    }),
    narration: tl.narration.map((n) => {
      if (later.has(n.scene)) return { ...n, start: shift(n.start) };
      if (n.scene === sceneId) return { ...n, start: inside(n.start) };
      return { ...n };
    }),
    sfx: tl.sfx.map((x) => {
      if (x.t >= oldEnd) return { ...x, t: shift(x.t) };
      if (x.t >= target.start && x.t >= newEnd) return { ...x, t: round(newEnd - frame) };
      return { ...x };
    }),
    poster: tl.poster == null ? tl.poster
      : tl.poster >= oldEnd ? shift(tl.poster)
        : tl.poster >= target.start && tl.poster >= newEnd ? round(newEnd - frame)
          : tl.poster,
  };
}

/**
 * シーンとその中のテキスト・ナレーション・効果音を、シーンのローカル時刻（シーン先頭が 0）にして返す。
 * scene は絶対時刻のまま残す。
 * @param {Timeline} tl
 * @param {string} sceneId
 * @returns {{scene: Scene, texts: Text[], narration: Narration[], sfx: Sfx[]}}
 */
export function sceneSlice(tl, sceneId) {
  const scene = tl.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`シーン ${sceneId} が見つかりません`);
  const o = scene.start;
  return {
    scene: { ...scene },
    texts: tl.texts.filter((t) => t.scene === sceneId).map((t) => ({ ...t, start: round(t.start - o), end: round(t.end - o) })),
    narration: tl.narration.filter((n) => n.scene === sceneId).map((n) => ({ ...n, start: round(n.start - o) })),
    sfx: tl.sfx.filter((x) => x.t >= scene.start && x.t < scene.end).map((x) => ({ ...x, t: round(x.t - o) })),
  };
}

/**
 * ナレーションの音声か BGM のファイルがあるか。無ければ効果音だけ（または無音）の動画で、
 * 音量を持ち上げない（mix.mjs）。点検（check.mjs）も同じ判定を使い、食い違わないようにする。
 * @param {Timeline} tl
 */
export function hasVoiceOrMusic(tl) {
  return (tl.narration ?? []).some((n) => n.audio) || Boolean(tl.bgm?.file);
}

/**
 * 制作フォルダの timeline.json を読む。
 * @param {string} projectDir
 * @returns {Timeline}
 */
export function readTimeline(projectDir) {
  const file = path.join(projectDir, 'timeline.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`timeline.json を読めません（${file}）: ${e.message}`);
  }
}

/**
 * 制作フォルダの timeline.json を書く（一時の名前に書いてから名前を変える）。
 * @param {string} projectDir
 * @param {Timeline} tl
 */
export function writeTimeline(projectDir, tl) {
  const file = path.join(projectDir, 'timeline.json');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(`${file}.partial`, JSON.stringify(tl, null, 2) + '\n');
  replaceFile(`${file}.partial`, file);
}

/**
 * timeline.json を読み、誤りがあれば書き出しの前に止める（長い書き出しの後で初めて誤りに気づかないため）。
 * @param {string} projectDir
 */
export function assertValidTimeline(projectDir) {
  const tl = readTimeline(projectDir);
  const v = validateTimeline(tl);
  if (!v.ok) throw new Error(`timeline.json に誤りがあります。直してから実行してください（node timeline.mjs validate でも確かめられます）:\n${v.errors.map((e) => `- ${e}`).join('\n')}`);
  return tl;
}

if (isMain(import.meta.url)) {
  const [cmd, dir, sceneId] = process.argv.slice(2);
  try {
    if (cmd === 'validate' && dir) {
      const tl = readTimeline(dir);
      const { errors } = validateTimeline(tl);
      const holds = holdViolations(tl).map((h) => `テキスト ${h.id} の表示が ${round(h.actual)} 秒しかありません（読み切るには ${h.need} 秒以上）${holdHint(h)}`);
      const all = [...errors, ...holds, ...narrationOverlaps(tl).map(overlapMessage)];
      if (all.length === 0) {
        console.log('timeline.json: 問題は見つかりませんでした。');
      } else {
        console.log(`timeline.json: ${all.length} 件の問題があります。`);
        for (const m of all) console.log(`- ${m}`);
        process.exitCode = 1;
      }
    } else if (cmd === 'slice' && dir && sceneId) {
      console.log(JSON.stringify(sceneSlice(readTimeline(dir), sceneId), null, 2));
    } else {
      throw new Error('使い方: node timeline.mjs validate <制作フォルダ> / slice <制作フォルダ> <シーンid>');
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
