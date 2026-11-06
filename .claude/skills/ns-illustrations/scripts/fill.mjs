// スライド HTML に書いた挿絵の印 <svg data-illust="素材名" …></svg> の中身を、素材集の SVG で埋める。
// 使い方: node <ns-illustrations プラグイン>/scripts/fill.mjs <デッキのフォルダかファイル>…
//   フォルダなら直下の .html だけを見る（present/・assets/ などの下は見ない）。何度実行しても同じ結果になる。
//   素材は共有の素材集の上に個人の素材集（~/.claude/ns-illustrations/illustrations/）を重ねて読む。同じ名前は個人を使い、
//   個人から取った素材は「個人の素材集: <名前>」の行で出す。個人の素材集が無くても共有だけで動く。
//   素材を描き直したら実行し直せば追従する。
// SVG は正規表現と簡単な走査で扱う（素材は 1 行で、入れ子の <svg> を持たない）。
// data-scale を後から消しても、以前に書いた width・height は消さない（data-scale が無ければ width・height は作者の値として触れない）。
import fs from 'node:fs';
import path from 'node:path';
import { openLibrary } from './library.mjs';
import { SHARED_DIR, isMain, personalDir } from './paths.mjs';

/** 画面UIの素材に付ける検査の除外（飾りの文字だけが外してよい例外） */
const UI_CHECK_IGNORE = 'small-text contrast';

/**
 * @typedef {'personal' | 'shared'} Origin
 * @typedef {{
 *   html: string,
 *   count: number,
 *   errors: string[],
 *   used: { name: string, origin: Origin }[],
 * }} FillResult
 *   html: 埋めた後の HTML（エラーが 1 つでもあれば元のまま）。count: 埋めた印の数（エラーがあれば 0）。
 *   used: 埋めた素材の名前と取った先（名前ごとに 1 回、出てきた順。エラーがあれば空）
 * @typedef {(name: string) => { svg: string, origin: Origin } | undefined} AssetLoader
 *   素材名 → 素材の SVG の全文と取った先。無ければ undefined
 * @typedef {{ viewBox: string, inner: string }} Asset
 * @typedef {{ name: string, value: string, start: number, end: number }} Attr
 */

/** 開始タグの本体（属性の値の中の > を読み飛ばす）。`<名前` の後ろから `>` まで */
const TAG_BODY = `(?:[^>"']|"[^"]*"|'[^']*')*`;

/** 開始タグの属性を順に読む。値の中の空白や名前に似た文字列を属性と取り違えないよう、頭から 1 つずつ消費する */
function attrsOf(/** @type {string} */ tag) {
  const head = tag.match(/^<[^\s/>]+/);
  const re = /\s*([^\s"'=<>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?|\s*\/?>$|\s*\//y;
  re.lastIndex = head ? head[0].length : 0;
  /** @type {Attr[]} */
  const out = [];
  for (let m; re.lastIndex < tag.length && (m = re.exec(tag)); ) {
    if (m[1]) out.push({ name: m[1], value: m[2] ?? m[3] ?? m[4] ?? '', start: m.index + m[0].indexOf(m[1]), end: re.lastIndex });
  }
  return out;
}

/** 開始タグの属性を読む（名前の大文字小文字は区別しない。値は "…"・'…'・引用符なし） */
function readAttr(/** @type {string} */ tag, /** @type {string} */ name) {
  return attrsOf(tag).find((a) => a.name.toLowerCase() === name.toLowerCase())?.value;
}

/** 開始タグの属性を書く。あれば（大文字小文字を問わず）正しい綴りの名前と値で差し替え、無ければ末尾に足す */
function writeAttr(/** @type {string} */ tag, /** @type {string} */ name, /** @type {string} */ value) {
  const a = attrsOf(tag).find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (a) return tag.slice(0, a.start) + `${name}="${value}"` + tag.slice(a.end);
  return tag.replace(/\s*(\/?)>$/, (_, slash) => ` ${name}="${value}"${slash}>`);
}

/** 素材ファイルから外側の <svg> の viewBox と中身を取り出す */
function parseAsset(/** @type {string} */ name, /** @type {string} */ svg) {
  const open = svg.match(new RegExp(`<svg\\b${TAG_BODY}>`));
  if (!open || open.index === undefined) return `素材 ${name}.svg に <svg> がありません`;
  const viewBox = readAttr(open[0], 'viewBox');
  if (!viewBox) return `素材 ${name}.svg の外側の <svg> に viewBox がありません`;
  const end = svg.lastIndexOf('</svg>');
  if (end < 0) return `素材 ${name}.svg が </svg> で閉じていません`;
  return /** @type {Asset} */ ({ viewBox, inner: svg.slice(open.index + open[0].length, end) });
}

/** from の位置にある開始タグ（長さ openLength）に対応する終了タグの [開始, 終了] を返す。入れ子の同名のタグを数える */
function matchClose(/** @type {string} */ src, /** @type {string} */ tag, /** @type {number} */ from, /** @type {number} */ openLength) {
  const re = new RegExp(`<${tag}\\b${TAG_BODY}?(/?)>|</${tag}\\s*>`, 'g');
  re.lastIndex = from + openLength;
  let depth = 1;
  for (let m; (m = re.exec(src)); ) {
    if (m[0].startsWith('</')) depth -= 1;
    else if (m[1] !== '/') depth += 1;
    if (depth === 0) return /** @type {[number, number]} */ ([m.index, re.lastIndex]);
  }
  return null;
}

/** data-part が part の要素を取り除く（<g …>…</g> は対応する終了タグまで、単独の要素はその要素だけ） */
function dropPart(/** @type {string} */ inner, /** @type {string} */ part) {
  const re = new RegExp(`<([a-zA-Z][\\w:-]*)\\b${TAG_BODY}>`, 'g');
  let out = inner;
  let found = false;
  const next = () => {
    re.lastIndex = 0;
    for (let m; (m = re.exec(out)); ) if (readAttr(m[0], 'data-part') === part) return m;
    return null;
  };
  for (let m; (m = next()); ) {
    found = true;
    const at = m.index;
    if (m[0].endsWith('/>')) {
      out = out.slice(0, at) + out.slice(at + m[0].length);
      continue;
    }
    const close = matchClose(out, m[1], at, m[0].length);
    // 閉じていない部品は素材の誤り。開始タグだけ消すと残りが壊れるので、ここで止める
    if (!close) return { inner: out, found: false };
    out = out.slice(0, at) + out.slice(close[1]);
  }
  return { inner: out, found };
}

/** %g 相当の簡潔な数値（440.00000000000006 → 440） */
const formatNumber = (/** @type {number} */ n) => String(Number(n.toPrecision(6)));

const lineOf = (/** @type {string} */ src, /** @type {number} */ index) => src.slice(0, index).split('\n').length;

/**
 * HTML の中の印 <svg data-illust="素材名" …>…</svg> を素材で埋める。純粋関数（読み込みは loadAsset に任せる）。
 * - 中身を素材の外側の <svg> を外した中身で置き換え、viewBox を素材の値（data-viewbox があればそちら）にする。
 * - data-scale があれば width・height を viewBox の大きさ × 倍率で書く。無ければ width・height に触れない。
 * - data-drop に空白区切りで書いた部品（data-part）を取り除く。
 * - ui-* の素材には data-check-ignore="small-text contrast" を付ける（既にあれば変えない）。
 * - 印の他の属性は保つ。エラーが 1 つでもあれば HTML を書き換えない。
 * @param {string} html @param {AssetLoader} loadAsset @returns {FillResult}
 */
export function fillIllustrations(html, loadAsset) {
  /** @type {string[]} */
  const errors = [];
  /** @type {Map<string, { asset: Asset | string, origin?: Origin }>} */
  const cache = new Map();
  /** @type {Map<string, Origin>} */
  const usedMap = new Map();
  const asset = (/** @type {string} */ name) => {
    if (!cache.has(name)) {
      const got = /^[a-z0-9][a-z0-9-]*$/.test(name) ? loadAsset(name) : undefined;
      cache.set(name, got === undefined ? { asset: `素材「${name}」がありません` } : { asset: parseAsset(name, got.svg), origin: got.origin });
    }
    return /** @type {{ asset: Asset | string, origin?: Origin }} */ (cache.get(name));
  };

  const markerRe = new RegExp(`<svg\\b${TAG_BODY}>`, 'g');
  /** @type {string[]} */
  const pieces = [];
  let last = 0;
  let count = 0;
  for (let m; (m = markerRe.exec(html)); ) {
    const open = m[0];
    const at = m.index;
    const name = readAttr(open, 'data-illust');
    if (name === undefined) continue;
    const where = `${lineOf(html, at)} 行目の印「${name}」`;
    const selfClosing = open.endsWith('/>');
    const close = selfClosing ? [at + open.length, at + open.length] : matchClose(html, 'svg', at, open.length);
    if (!close) {
      errors.push(`${where}: 対応する </svg> がありません`);
      break; // 終わりが分からないので、後ろの印も読めない
    }
    markerRe.lastIndex = close[1];

    const { asset: a, origin } = asset(name);
    if (typeof a === 'string') {
      errors.push(`${where}: ${a}`);
      continue;
    }
    const viewBox = readAttr(open, 'data-viewbox') ?? a.viewBox;
    const size = viewBox.trim().split(/[\s,]+/).map(Number);
    if (size.length !== 4 || size.some((n) => !Number.isFinite(n))) {
      errors.push(`${where}: viewBox「${viewBox}」が読めません`);
      continue;
    }

    let tag = writeAttr(open, 'viewBox', viewBox);
    const scaleText = readAttr(open, 'data-scale');
    if (scaleText !== undefined) {
      const scale = Number(scaleText);
      if (!scaleText.trim() || !Number.isFinite(scale) || scale <= 0) {
        errors.push(`${where}: data-scale「${scaleText}」は正の数で書いてください`);
        continue;
      }
      tag = writeAttr(tag, 'width', formatNumber(size[2] * scale));
      tag = writeAttr(tag, 'height', formatNumber(size[3] * scale));
    }
    if (name.startsWith('ui-') && readAttr(tag, 'data-check-ignore') === undefined) {
      tag = writeAttr(tag, 'data-check-ignore', UI_CHECK_IGNORE);
    }

    let inner = a.inner;
    const drops = (readAttr(open, 'data-drop') ?? '').split(/\s+/).filter(Boolean);
    const missing = drops.filter((part) => {
      const r = dropPart(inner, part);
      inner = r.inner;
      return !r.found;
    });
    if (missing.length) {
      errors.push(`${where}: data-drop の部品が素材にありません: ${missing.join(' ')}`);
      continue;
    }

    if (selfClosing) tag = tag.replace(/\s*\/>$/, '>');
    pieces.push(html.slice(last, at), tag, inner, '</svg>');
    last = close[1];
    count += 1;
    if (origin && !usedMap.has(name)) usedMap.set(name, origin);
  }
  if (errors.length) return { html, count: 0, errors, used: [] };
  pieces.push(html.slice(last));
  return { html: pieces.join(''), count, errors, used: [...usedMap].map(([name, origin]) => ({ name, origin })) };
}

/** 引数（フォルダかファイル）から対象の .html を並べる。フォルダは直下だけを見る */
export function listTargets(/** @type {string[]} */ args) {
  return args.flatMap((arg) => {
    if (!fs.existsSync(arg) || !fs.statSync(arg).isDirectory()) return [arg];
    return fs.readdirSync(arg, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.html'))
      .map((e) => path.join(arg, e.name))
      .sort();
  });
}

/**
 * 共有の素材集の上に個人の素材集を重ねて読む AssetLoader。同じ名前は個人を使う。personal が無い・フォルダが無ければ共有だけ
 * @param {string} shared @param {string | null} [personal] @returns {AssetLoader}
 */
export const assetLoaderFrom = (shared, personal = null) => {
  const lib = openLibrary({ shared, personal });
  return (name) => {
    const origin = lib.origin(name);
    const svg = origin ? lib.read(name) : undefined;
    return origin && svg !== undefined ? { svg, origin } : undefined;
  };
};

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const unknown = argv.filter((a) => a.startsWith('--'));
  if (unknown.length) {
    console.error(`知らない引数です: ${unknown.join(' ')}（素材の置き場は固定です。指定できるのはデッキのフォルダかファイルだけ）`);
    process.exit(1);
  }
  if (!argv.length) {
    console.error('使い方: node <ns-illustrations プラグイン>/scripts/fill.mjs <デッキのフォルダかファイル>…');
    process.exit(1);
  }
  const missing = argv.filter((p) => !fs.existsSync(p));
  if (missing.length) {
    console.error('見つかりません:', missing.join(', '));
    process.exit(1);
  }

  const load = assetLoaderFrom(SHARED_DIR, personalDir());
  let failed = 0;
  let total = 0;
  /** @type {Set<string>} */
  const personalUsed = new Set();
  for (const file of listTargets(argv)) {
    const src = fs.readFileSync(file, 'utf8');
    const r = fillIllustrations(src, load);
    if (r.errors.length) {
      failed += 1;
      console.error(`エラー（書き換えません）: ${file}`);
      for (const e of r.errors) console.error('  ' + e);
      continue;
    }
    if (!r.count) continue;
    total += r.count;
    for (const u of r.used) if (u.origin === 'personal') personalUsed.add(u.name);
    if (r.html === src) console.log(`変更なし: ${file}（印 ${r.count} 個）`);
    else {
      fs.writeFileSync(file, r.html);
      console.log(`書き換え: ${file}（印 ${r.count} 個）`);
    }
  }
  for (const name of [...personalUsed].sort()) console.log(`個人の素材集: ${name}`);
  console.log(`埋めた印: ${total} 個${failed ? `、エラーのファイル: ${failed} 件` : ''}`);
  if (failed) process.exitCode = 1;
}
