// 指摘の受け取りと記録（spec 5章「指摘の受け取り方」）。
// 確認ページの「指摘をまとめてコピー」の文と、チャットの自由な文の両方から、カットと指摘を取り出す。
// 記録は reviews/feedback-log.json に置き、次の確認ページの冒頭に「前回の指摘と対応」として出す。
//   node feedback.mjs log <制作フォルダ> <指摘の文を書いたファイル> --gate <関門>   読んで記録し、番号と読めなかった行を JSON で出す
//   node feedback.mjs resolve <制作フォルダ> <番号> --how "直し方"
import fs from 'node:fs';
import path from 'node:path';
import { isMain, replaceFile } from './paths.mjs';
import { normalizeName } from './project.mjs';
import { cutOf, readTimeline } from './timeline.mjs';

/**
 * @typedef {{cut: number|null, start?: number, end?: number, text: string}} FeedbackItem
 * @typedef {FeedbackItem & {gate: string, loggedAt: string, resolved: {how: string, at: string}|null}} LoggedItem
 * @typedef {{version: number, items: LoggedItem[]}} FeedbackLog
 */

/** 確認ページのコピー文の 1 行目 */
const HEADER = /^\[ns-motion-studio 指摘\]/;
/** 「全体：」で始まる行 */
const OVERALL = /^全体\s*:\s*(.*)$/;
/** 「カット3」「cut 3」「#3」。#N は行頭だけで、16進の色（#333333、#1a1a1a）と取り違えないよう、数字のあとに 16進の文字が続くものは除く */
const CUT = /(?:カット|\bcut)\s*(\d+)|^#\s*(\d+)(?![0-9a-f])/i;
/** 「(0:05〜0:08)」の時刻の範囲 */
const RANGE = /^\s*\(\s*(\d+:\d{1,2}(?:\.\d+)?)\s*[〜~\-–]\s*(\d+:\d{1,2}(?:\.\d+)?)\s*\)/;
/** 「0:12」の時刻 */
const CLOCK = /(\d+):(\d{2}(?:\.\d+)?)/;

/** 「1:05.5」を秒にする */
function seconds(clock) {
  const [m, s] = clock.split(':');
  return Number(m) * 60 + Number(s);
}

/**
 * 1 行を読む。決められなければ null。
 * @param {string} line NFKC で正規化し、前後の空白を落とした行
 * @param {import('./timeline.mjs').Timeline} tl
 * @returns {FeedbackItem|null}
 */
function parseLine(line, tl) {
  const overall = line.match(OVERALL);
  if (overall) return overall[1].trim() ? { cut: null, text: overall[1].trim() } : null;

  const total = tl.scenes[tl.scenes.length - 1].end;
  const ref = line.match(CUT);
  if (ref) {
    const cut = Number(ref[1] ?? ref[2]);
    if (cut < 1 || cut > tl.scenes.length) return null;
    /** @type {FeedbackItem} */
    const item = { cut };
    let rest = line.slice(ref.index + ref[0].length);
    const range = rest.match(RANGE);
    if (range) {
      item.start = seconds(range[1]);
      item.end = seconds(range[2]);
      rest = rest.slice(range[0].length);
    }
    // 行頭の「カット3：」「#3 」なら残りが指摘。「カット3のテロップを〜」のような文は行のまま残す
    const tail = ref.index === 0 && /^[\s:]/.test(rest) ? rest.replace(/^[\s:]+/, '').trim() : line;
    if (!tail) return null;
    item.text = tail;
    return item;
  }

  const clock = line.match(CLOCK);
  if (clock) {
    const t = seconds(clock[0]);
    if (t >= total) return null;
    return { cut: cutOf(tl, t).cut, start: t, text: line };
  }
  return null;
}

/**
 * 指摘の文を、カットごとの指摘に分ける。見出しの行と空行は読まない。
 * 全角の数字・コロン・括弧は NFKC で半角にしてから読む（取り出した指摘の文も正規化後の文字になる）。
 * 決められない行は捨てずに、元の行のまま unresolved に入れる（スキルが聞き返す）。
 * @param {string} text
 * @param {import('./timeline.mjs').Timeline} tl
 * @returns {{items: FeedbackItem[], unresolved: string[]}}
 */
export function parseFeedback(text, tl) {
  /** @type {FeedbackItem[]} */
  const items = [];
  /** @type {string[]} */
  const unresolved = [];
  for (const raw of text.split(/\r?\n/)) {
    const original = raw.trim();
    const line = original.normalize('NFKC').trim();
    if (!line || HEADER.test(line)) continue;
    const item = parseLine(line, tl);
    if (item) items.push(item);
    else unresolved.push(original);
  }
  return { items, unresolved };
}

const logFile = (projectDir) => path.join(projectDir, 'reviews', 'feedback-log.json');

/**
 * reviews/feedback-log.json を読む。無ければ空の記録を返す。
 * @param {string} projectDir
 * @returns {FeedbackLog}
 */
export function readFeedbackLog(projectDir) {
  const file = logFile(projectDir);
  if (!fs.existsSync(file)) return { version: 1, items: [] };
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`指摘の記録を読めません（${file}）: ${e.message}`);
  }
}

/** 一時の名前に書いてから名前を変える */
function writeLog(projectDir, log) {
  const file = logFile(projectDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.partial`, JSON.stringify(log, null, 2) + '\n');
  replaceFile(`${file}.partial`, file);
}

/**
 * 同じ関門・カット・文（前後の空白は見ない）の未対応の指摘が記録にあれば、その番号を返す（無ければ -1）。
 * 確認ページの欄に残った指摘を貼り直したときに、二重に記録しないため。
 * @param {FeedbackLog} log
 * @param {{cut: number|null, text: string}} item
 * @param {string} gate
 */
export function duplicateOf(log, item, gate) {
  // 初版の記録（gate: brief）も、今の名前（briefing）と同じ関門として比べる
  return log.items.findIndex((x) => !x.resolved && normalizeName(x.gate) === normalizeName(gate) && (x.cut ?? null) === (item.cut ?? null) && x.text.trim() === item.text.trim());
}

/**
 * 受け取った指摘を記録に足す。未対応の同じ指摘（duplicateOf）は足さず、前の番号を返す（記録の時刻も変えないので、止め時を数え直さない）。
 * @param {string} projectDir
 * @param {FeedbackItem[]} items
 * @param {string} gate 指摘を受けた関門
 * @returns {number[]} 指摘ごとの番号（markResolved に渡す）
 */
export function logFeedback(projectDir, items, gate) {
  gate = normalizeName(gate); // 初版の名前（brief）も受け付ける
  const log = readFeedbackLog(projectDir);
  const loggedAt = new Date().toISOString();
  const added = [];
  for (const it of items) {
    const dup = duplicateOf(log, it, gate);
    if (dup >= 0) {
      added.push(dup);
      continue;
    }
    added.push(log.items.length);
    log.items.push({
      gate,
      cut: it.cut,
      ...(it.start !== undefined ? { start: it.start } : {}),
      ...(it.end !== undefined ? { end: it.end } : {}),
      text: it.text,
      loggedAt,
      resolved: null,
    });
  }
  writeLog(projectDir, log);
  return added;
}

/**
 * 指摘をどう直したかを書き込む。
 * @param {string} projectDir
 * @param {number} index logFeedback が返した番号
 * @param {string} how 直し方（利用者に見せる文）
 */
export function markResolved(projectDir, index, how) {
  const log = readFeedbackLog(projectDir);
  if (!log.items[index]) throw new Error(`指摘の番号 ${index} は記録にありません（0〜${log.items.length - 1}）`);
  log.items[index].resolved = { how, at: new Date().toISOString() };
  writeLog(projectDir, log);
}

if (isMain(import.meta.url)) {
  const [cmd, dir, arg, ...rest] = process.argv.slice(2);
  const opt = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const usage = '使い方: node feedback.mjs log <制作フォルダ> <指摘の文を書いたファイル> --gate <関門> / resolve <制作フォルダ> <番号> --how "直し方"';
  try {
    if (cmd === 'log' && dir && arg) {
      const gate = opt('gate') && normalizeName(opt('gate'));
      if (!gate) throw new Error(`--gate が必要です\n${usage}`);
      const { items, unresolved } = parseFeedback(fs.readFileSync(arg, 'utf8'), readTimeline(dir));
      const before = readFeedbackLog(dir);
      const dups = items.map((it) => duplicateOf(before, it, gate));
      const indexes = logFeedback(dir, items, gate);
      const logged = items.map((it, i) => ({ index: indexes[i], cut: it.cut, text: it.text })).filter((_, i) => dups[i] < 0);
      const duplicates = items.map((it, i) => ({ index: dups[i], cut: it.cut, text: it.text, note: `記録済みでまだ対応していない指摘 ${dups[i]} と同じなので、記録しませんでした（直すのは1回だけ）` }))
        .filter((d) => d.index >= 0);
      console.log(JSON.stringify({ logged, unresolved, duplicates }, null, 2));
    } else if (cmd === 'resolve' && dir && arg) {
      const how = opt('how');
      if (!how) throw new Error(`--how が必要です\n${usage}`);
      if (!/^\d+$/.test(arg)) throw new Error(`番号は 0 以上の整数で書いてください（${arg}）`);
      markResolved(dir, Number(arg), how);
      console.log(`指摘 ${arg} を対応済みにしました`);
    } else {
      throw new Error(usage);
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
