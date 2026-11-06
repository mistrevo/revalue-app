// 制作ごとの読みの辞書（audio/readings.json）。読み上げに渡す文だけを置き換え、字幕と原稿（timeline.json）は変えない。
//   形: [{"surface": "ffmpeg", "reading": "エフエフエムペグ"}, ...]
// エンジンの辞書（VOICEVOX のユーザー辞書）には書かないので、利用者のエンジンに何も残らず、制作フォルダだけで作り直せる。
import fs from 'node:fs';
import path from 'node:path';

/** @typedef {{surface: string, reading: string}} Reading */

/** 制作フォルダの中の辞書の場所 */
export const READINGS_FILE = path.join('audio', 'readings.json');

/**
 * 辞書を読む。無ければ空。形が違えば、どこが違うかを日本語で伝えて止める。
 * @param {string} projectDir
 * @returns {Reading[]}
 */
export function readReadings(projectDir) {
  const file = path.join(projectDir, READINGS_FILE);
  if (!fs.existsSync(file)) return [];
  let list;
  try {
    list = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`読みの辞書 ${READINGS_FILE} を JSON として読めません: ${e.message}`);
  }
  const ok = (x) => x && typeof x.surface === 'string' && x.surface.trim() !== '' && typeof x.reading === 'string' && x.reading.trim() !== '';
  if (!Array.isArray(list) || !list.every(ok)) {
    throw new Error(`読みの辞書 ${READINGS_FILE} は [{"surface": "ffmpeg", "reading": "エフエフエムペグ"}, ...] の形にしてください（surface と reading は空でない文字）。`);
  }
  const seen = new Set();
  for (const { surface } of list) {
    if (seen.has(surface)) throw new Error(`読みの辞書 ${READINGS_FILE} に「${surface}」が 2 回あります。どちらの読みを使うか決めて、1つにしてください。`);
    seen.add(surface);
  }
  return list.map((x) => ({ surface: x.surface, reading: x.reading }));
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ALNUM = '[A-Za-z0-9]';
/** 英字・数字をつなぐ記号（v2.1、ASP.NET、ns-skills、C++ の一続きを1語とみなす） */
const JOIN = "[-._+#/@&:']";
/** 前後の境目を確かめる、見出しの端の文字（空白以外の ASCII） */
const ASCII_EDGE = /[!-~]/;

/**
 * 文の中の語を読みに置き換える。長い語から先に当て、置き換えた後の文はもう一度は見ない。
 * 端が英字・数字・記号の見出しは、英字・数字と、それらをつなぐ記号（- . _ + # / @ & : '）の一続きの語と
 * ちょうど同じときだけ当てる（ns は dns や ns-skills の中に、v2 は v2.1 の中に、.NET は ASP.NET の中に当てない）。
 * 語の後ろの文末の「.」や「,」は語に含めない。大文字と小文字は区別する。
 * @param {string} text
 * @param {Reading[]} entries
 */
export function applyReadings(text, entries) {
  if (!entries.length) return text;
  const sorted = [...entries].sort((a, b) => b.surface.length - a.surface.length);
  const pattern = sorted.map(({ surface }) => {
    const head = ASCII_EDGE.test(surface[0]) ? `(?<!${ALNUM})(?<!${ALNUM}${JOIN})` : '';
    const tail = ASCII_EDGE.test(surface.at(-1)) ? `(?!${ALNUM})(?!${JOIN}${ALNUM})` : '';
    return `${head}${escape(surface)}${tail}`;
  }).join('|');
  const bySurface = new Map(sorted.map((e) => [e.surface, e.reading]));
  return text.replace(new RegExp(pattern, 'g'), (m) => bySurface.get(m) ?? m);
}
