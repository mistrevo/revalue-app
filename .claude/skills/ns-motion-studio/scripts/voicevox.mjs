// VOICEVOX（ローカルのエンジン）での読み上げ。
//   node voicevox.mjs speakers   使ってよい話者（VOICEVOX_CHARACTERS）の声の番号（narration.mjs の --speaker に渡す）の一覧を出す
//   node voicevox.mjs kana <制作フォルダ> [--speaker <番号か 名前/スタイル>]
//                                 各行を VOICEVOX がどう読むか（カタカナ）を出す。読みの辞書を当てた後の文で見る。合成はしない
//   --speaker には番号のほか「四国めたん/ノーマル」（名前/スタイル）も渡せる（resolveSpeaker で番号に引く）。省くと DEFAULT_VOICE
import fs from 'node:fs';
import path from 'node:path';
import { isMain } from './paths.mjs';
import { applyReadings, readReadings } from './readings.mjs';

const BASE = 'http://127.0.0.1:50021';

/** エンジンへ送る。つながらない（起動していない）ときは、起動を確かめるよう日本語で知らせる */
async function reach(f, url, init) {
  try {
    // 応答が無いまま止まらないよう、時間切れを付ける（長い文の合成でも 2 分あれば返る）
    return await f(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(120e3) });
  } catch (e) {
    throw new Error(`VOICEVOX に接続できません（${e instanceof Error ? e.message : String(e)}）。VOICEVOX を起動しているか確かめてください。`);
  }
}

async function check(res, what) {
  if (!res.ok) throw new Error(`VOICEVOX の ${what} が失敗しました（HTTP ${res.status}）。エンジンが起動しているか確かめてください。`);
  return res;
}

/** 既定の声と読み方。--speaker・--speed・--intonation を省くとこれを使う */
export const DEFAULT_VOICE = '四国めたん/ノーマル';
export const DEFAULT_SPEED = 1.1;
export const DEFAULT_INTONATION = 1.2;

/**
 * 使ってよいキャラクター。利用規約が、企業の動画（商用）でも申請・連絡なしに、クレジット「VOICEVOX:<名前>」だけで使えると
 * はっきり書いているものに絞る（制作のたびに規約を読み直さなくてよいように）。
 * 外したもの: 企業・法人の利用や商用に問い合わせ・申請が要るもの（青山龍星、後鬼、ぞん子、Voidoll、No.7、猫使アル、猫使ビィ、
 * ナースロボ＿タイプＴ、小夜/SAYO、もち子さん、ユーレイちゃん など）と、条件や本文がはっきりしないもの。
 * 規約は変わることがある。足すとき・見直すときは規約の本文を読み、checked の日付を直す。
 * @type {ReadonlyArray<{name: string, terms: string, checked: string, note: string}>}
 */
export const VOICEVOX_CHARACTERS = Object.freeze([
  { name: '四国めたん', terms: 'https://zunko.jp/con_ongen_kiyaku.html', checked: '2026-10-23', note: '商用・非商用とも可、申請不要。クレジット必須。政治・宗教、特定の個人・団体の批判や支持、虚偽情報、情報商材の宣伝などに使わない' },
  { name: 'ずんだもん', terms: 'https://zunko.jp/con_ongen_kiyaku.html', checked: '2026-10-23', note: '商用・非商用とも可、申請不要。クレジット必須。政治・宗教、特定の個人・団体の批判や支持、虚偽情報、情報商材の宣伝などに使わない' },
  { name: '九州そら', terms: 'https://zunko.jp/con_ongen_kiyaku.html', checked: '2026-10-23', note: '商用・非商用とも可、申請不要。クレジット必須。政治・宗教、特定の個人・団体の批判や支持、虚偽情報、情報商材の宣伝などに使わない' },
  { name: '中国うさぎ', terms: 'https://zunko.jp/con_ongen_kiyaku.html', checked: '2026-10-23', note: '商用・非商用とも可、申請不要。クレジット必須。政治・宗教、特定の個人・団体の批判や支持、虚偽情報、情報商材の宣伝などに使わない' },
  { name: '中部つるぎ', terms: 'https://zunko.jp/con_ongen_kiyaku.html', checked: '2026-10-23', note: '商用・非商用とも可、申請不要。クレジット必須。政治・宗教、特定の個人・団体の批判や支持、虚偽情報、情報商材の宣伝などに使わない' },
  { name: '冥鳴ひまり', terms: 'https://www.meimeihimari.com/terms-of-use', checked: '2026-10-23', note: '個人・法人を問わず商用可、申請・報告不要。クレジット必須。公序良俗に反する用途や特定の思想・団体のための利用はしない' },
  { name: '雨晴はう', terms: 'https://amehau.com/?page_id=225', checked: '2026-10-23', note: '個人・企業とも商用・非商用可、連絡不要（クレジットを出せないときだけ要連絡）。クレジット必須。R18 用途は不可' },
  { name: '満別花丸', terms: 'https://100hanamaru.wixsite.com/manbetsu-hanamaru/rule', checked: '2026-10-23', note: '個人・法人とも商用・非商用可、連絡不要（声の利用。公式の絵などで商品を作るときは事前に相談）。クレジット必須。公式を装う使い方はしない' },
]);

/** 使ってよいキャラクターの記録。外したキャラクターなら undefined */
export function characterTerms(name) {
  return VOICEVOX_CHARACTERS.find((c) => c.name === name);
}

/** 話す速さ（speedScale）と抑揚（intonationScale）の受け付ける範囲 */
export const SPEED_RANGE = [0.5, 2.0];
export const INTONATION_RANGE = [0, 2.0];

/**
 * 速さと抑揚が範囲の中の数かを確かめる。省いた値は確かめない（エンジンの値のまま使う）。
 * @param {{speed?: number, intonation?: number}} scales
 */
export function checkScales({ speed, intonation }) {
  const bad = (v, [lo, hi]) => v !== undefined && !(typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi);
  if (bad(speed, SPEED_RANGE)) {
    throw new Error(`--speed（話す速さ）は 0.5〜2.0 の数で指定してください（受け取った値: ${speed}）。1 が標準です。`);
  }
  if (bad(intonation, INTONATION_RANGE)) {
    throw new Error(`--intonation（抑揚）は 0〜2.0 の数で指定してください（受け取った値: ${intonation}）。1 が標準、0 で平板な読み方になります。`);
  }
}

/**
 * VOICEVOX に渡す文に整える。日本語の文字（ASCII の外の文字）と隣り合う空白を詰める。
 * 原稿の「その PNG を ffmpeg へ」の空白を、VOICEVOX は句切れとして読み、1か所 0.3〜0.9 秒の間を空けるため。
 * 英字どうしの空白（Claude Code）は残す。字幕と原稿（timeline.json）は空白ありのまま変えない。
 * @param {string} text
 */
export function voicevoxText(text) {
  return text.replace(/\s+(?=[^\x00-\x7F])|(?<=[^\x00-\x7F])\s+/g, '').trim();
}

async function audioQuery(text, { speaker, base, fetch: f }) {
  return check(await reach(f, `${base}/audio_query?text=${encodeURIComponent(voicevoxText(text))}&speaker=${speaker}`, { method: 'POST' }), '/audio_query');
}

/**
 * VOICEVOX がその文をどう読むか（カタカナ）。句切れ（アクセント句）を「/」で区切り、息継ぎの間は「、」で示す。
 * 英字・略語・珍しい漢字の読み違いを、合成の前に見つけるために使う（audio.md）。
 * @param {string} text
 * @param {{speaker: number, base?: string, fetch?: typeof fetch}} opts
 */
export async function voicevoxKana(text, { speaker, base = BASE, fetch: f = fetch }) {
  const q = await (await audioQuery(text, { speaker, base, fetch: f })).json();
  return (q.accent_phrases ?? []).map((ap) => ap.moras.map((m) => m.text).join('') + (ap.pause_mora?.text ?? '')).join('/');
}

/**
 * 文を読み上げた WAV を返す。/audio_query の結果に速さと抑揚を書き込んで /synthesis に渡す。
 * 文は voicevoxText で空白を詰めてから渡す。
 * @param {string} text
 * @param {{speaker: number, speed?: number, intonation?: number, base?: string, fetch?: typeof fetch}} opts
 *   speed と intonation は省くとエンジンの値（標準は 1）のまま
 * @returns {Promise<Buffer>}
 */
export async function voicevoxSpeak(text, { speaker, speed, intonation, base = BASE, fetch: f = fetch }) {
  checkScales({ speed, intonation });
  const q = await audioQuery(text, { speaker, base, fetch: f });
  let query = await q.text();
  if (speed !== undefined || intonation !== undefined) {
    const json = JSON.parse(query);
    if (speed !== undefined) json.speedScale = speed;
    if (intonation !== undefined) json.intonationScale = intonation;
    query = JSON.stringify(json);
  }
  const s = await check(
    await reach(f, `${base}/synthesis?speaker=${speaker}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: query }),
    '/synthesis',
  );
  return Buffer.from(await s.arrayBuffer());
}

/**
 * 話者の一覧。
 * @param {{base?: string, fetch?: typeof fetch}} [opts]
 * @returns {Promise<Array<{name: string, styles: Array<{id: number, name: string}>}>>}
 */
export async function voicevoxSpeakers({ base = BASE, fetch: f = fetch } = {}) {
  const res = await check(await reach(f, `${base}/speakers`), '/speakers');
  const list = await res.json();
  return list.map((s) => ({ name: s.name, styles: s.styles.map((st) => ({ id: st.id, name: st.name })) }));
}

/**
 * --speaker の値（番号か「名前/スタイル」）から、声の番号と名前とスタイルを引く。使ってよいキャラクター（VOICEVOX_CHARACTERS）でなければ止める。
 * @param {number|string} spec 例: 3、"3"、"四国めたん/ノーマル"（全角の ／ も可）
 * @param {{base?: string, fetch?: typeof fetch}} [opts]
 * @returns {Promise<{id: number, name: string, style: string}>}
 */
export async function resolveSpeaker(spec, opts = {}) {
  const voice = await findSpeaker(spec, opts);
  if (!characterTerms(voice.name)) {
    throw new Error(`${voice.name} は使えません。利用規約が企業の動画でも申請なしに使えるとはっきりしているキャラクター（${VOICEVOX_CHARACTERS.map((c) => c.name).join('、')}）から選んでください。`);
  }
  return voice;
}

async function findSpeaker(spec, opts) {
  const speakers = await voicevoxSpeakers(opts);
  const text = String(spec).trim();
  if (/^\d+$/.test(text)) {
    const id = Number(text);
    for (const s of speakers) {
      const st = s.styles.find((x) => x.id === id);
      if (st) return { id, name: s.name, style: st.name };
    }
    throw new Error(`VOICEVOX に話者 ${id} がありません。node voicevox.mjs speakers で番号を確かめてください。`);
  }
  // 名前に「/」を含む話者（例: 小夜/SAYO）がいるので、区切りの位置を全部試して、話者とスタイルの両方が合うものを採る
  const cuts = [...text.matchAll(/[/／]/g)].map((x) => x.index).filter((i) => i > 0 && i < text.length - 1);
  if (!cuts.length) throw new Error(`--speaker は番号か「名前/スタイル」（例: 四国めたん/ノーマル）で指定してください（受け取った値: ${text}）。`);
  const splits = cuts.map((i) => ({ name: text.slice(0, i).trim(), style: text.slice(i + 1).trim() }));
  for (const { name, style } of splits) {
    const hit = speakers.find((s) => s.name === name);
    const st = hit?.styles.find((x) => x.name === style);
    if (hit && st) return { id: st.id, name: hit.name, style: st.name };
  }
  // 合うものが無いときは、話者の名前が合う区切りでスタイルの違いを、無ければ最初の区切りで話者の違いを伝える
  const named = splits.find((sp) => speakers.some((s) => s.name === sp.name));
  if (!named) throw new Error(`VOICEVOX に「${splits[0].name}」という話者がありません。node voicevox.mjs speakers で名前を確かめてください。`);
  const hit = speakers.find((s) => s.name === named.name);
  throw new Error(`${named.name} に「${named.style}」というスタイルがありません（あるのは ${hit.styles.map((x) => x.name).join('、')}）。`);
}

/**
 * 制作の各ナレーションを、読みの辞書（audio/readings.json）を当てた後の文で VOICEVOX がどう読むか。合成も書き込みもしない。
 * @param {string} projectDir
 * @param {{speaker?: number|string, base?: string, fetch?: typeof fetch}} opts speaker は番号か「名前/スタイル」（省くと DEFAULT_VOICE）
 * @returns {Promise<Array<{id: string, text: string, kana: string}>>} text はエンジンに渡す文（空白を詰めた後）
 */
export async function narrationKana(projectDir, { speaker = DEFAULT_VOICE, base = BASE, fetch: f = fetch }) {
  const readings = readReadings(projectDir);
  const tl = JSON.parse(fs.readFileSync(path.join(projectDir, 'timeline.json'), 'utf8'));
  const voice = await resolveSpeaker(speaker, { base, fetch: f });
  const rows = [];
  for (const n of tl.narration ?? []) {
    const text = voicevoxText(applyReadings(n.text, readings));
    rows.push({ id: n.id, text, kana: await voicevoxKana(text, { speaker: voice.id, base, fetch: f }) });
  }
  return rows;
}

if (isMain(import.meta.url)) {
  const [cmd, dir, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'speakers') {
      // 使ってよいキャラクターだけを出す（ほかは規約の確かめが要るので選ばせない）
      const all = await voicevoxSpeakers();
      for (const s of all.filter((x) => characterTerms(x.name))) {
        console.log(`${s.name}: ${s.styles.map((st) => `${st.name}=${st.id}`).join('、')}${DEFAULT_VOICE.startsWith(`${s.name}/`) ? '（既定）' : ''}`);
      }
      const missing = VOICEVOX_CHARACTERS.filter((c) => !all.some((s) => s.name === c.name));
      if (missing.length) console.log(`（このエンジンに無い: ${missing.map((c) => c.name).join('、')}）`);
    } else if (cmd === 'kana' && dir && (rest.length === 0 || (rest[0] === '--speaker' && rest[1]))) {
      for (const r of await narrationKana(dir, { speaker: rest[1] ?? DEFAULT_VOICE })) console.log(`${r.id}: ${r.text}
     → ${r.kana}`);
    } else {
      throw new Error('使い方: node voicevox.mjs speakers / kana <制作フォルダ> [--speaker <番号か 名前/スタイル>]');
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
