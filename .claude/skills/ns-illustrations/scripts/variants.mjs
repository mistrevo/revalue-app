// 挿絵の素材集（ns-illustrations）で、元の絵から派生（左向き・表情違い）を書き出す。
// 使い方: register.mjs が目録・一覧の前に呼ぶ（単独では実行しない）。
// どれが派生か・直す先・印（data-mirror="keep"）の決まりは同じフォルダの style-guide.md が持つ。
import { splitChar } from './names.mjs';

const KEEP = 'data-mirror="keep"';

/** id と url(#…) の接頭辞だけを付け替える（素材の id はファイル名を接頭辞に持つ。style-guide.md「命名規則」） */
const rename = (/** @type {string} */ svg, /** @type {string} */ from, /** @type {string} */ to) =>
  svg.split(`id="${from}-`).join(`id="${to}-`).split(`url(#${from}-`).join(`url(#${to}-`);

/**
 * 右向きから左向きを作る。光は左上のままにするため、影のずらしとグラデーションの向きは反対にする
 * @param {string} svg @param {string} from @param {string} to @returns {string}
 */
export function mirrorSvg(svg, from, to) {
  const width = (svg.match(/<svg[^>]*\sviewBox="[\d.-]+ [\d.-]+ ([\d.]+)/) ?? [])[1];
  if (!width || !svg.includes('</defs>')) throw new Error(`${from}.svg の viewBox か </defs> が読めません`);
  // 読めない書き方を黙って通すと、影やグラデーションが反転し損ねる
  const odd = [...svg.matchAll(/<path\b[^>]*\stransform="translate\([^)]*\)/g)].map((m) => m[0]).find((t) => !/translate\(-?[\d.]+,-?[\d.]+\)$/.test(t))
    ?? [...svg.matchAll(/<linearGradient\b[^>]*>/g)].map((m) => m[0]).find((t) => !/ x1="[01]" y1="[^"]*" x2="[01]"/.test(t));
  if (odd) throw new Error(`${from}.svg: 反転できない書き方です（translate(x,y) と x1→y1→x2 の順に揃える）: ${odd.slice(0, 80)}`);
  let s = rename(svg, from, to);
  s = s.replace(/(<linearGradient\b[^>]*?) x1="([01])"( y1="[^"]*") x2="([01])"/g, (_, head, x1, y1, x2) => `${head} x1="${x2}"${y1} x2="${x1}"`);
  // 影のずらしの x は文字のまま符号を変える（Number を通すと 9.0 が 9 になる）
  s = s.replace(/(<path\b[^>]*?\stransform="translate\()(-?)([\d.]+)(,)/g, (_, head, minus, x, comma) =>
    head + (/^0*\.?0*$/.test(x) ? x : minus ? x : '-' + x) + comma);
  // 反転の後に足す。先に足すと、足した translate まで符号が変わる
  s = s.replace(/<[a-z]+\b[^>]*\sdata-mirror="keep"[^>]*>/g, (tag) => {
    if (/\stransform="/.test(tag)) throw new Error(`${from}.svg: ${KEEP} の要素は transform を持てません: ${tag.slice(0, 80)}`);
    return tag.replace(KEEP, `${KEEP} transform="translate(${width},0) scale(-1,1)"`);
  });
  if (!/<\/svg>\s*$/.test(s)) throw new Error(`${from}.svg が </svg> で終わっていません`);
  return s.replace('</defs>', `</defs><g transform="translate(${width},0) scale(-1,1)">`).replace(/<\/svg>\s*$/, '</g></svg>');
}

/**
 * data-part="face" の <g> の範囲（入れ子の <g> を数えて閉じタグまで）
 * @param {string} svg @returns {[number, number] | null}
 */
function faceRange(svg) {
  const at = svg.search(/<g\b[^>]*\sdata-part="face"/);
  if (at < 0) return null;
  const re = /<g[\s>]|<\/g>/g;
  re.lastIndex = at;
  let depth = 0;
  for (let m; (m = re.exec(svg)); ) {
    depth += m[0] === '</g>' ? -1 : 1;
    if (depth === 0) return [at, re.lastIndex];
  }
  return null;
}

/**
 * body の顔を face の顔に差し替え、id を bodyName から to へ付け替える
 * @param {string} body @param {string} bodyName @param {string} face @param {string} to @returns {string}
 */
export function swapFace(body, bodyName, face, to) {
  const b = faceRange(body);
  const f = faceRange(face);
  if (!b || !f) throw new Error(`顔の部品（data-part="face"）が見つかりません: ${bodyName}.svg → ${to}.svg`);
  const part = face.slice(...f);
  if (/url\(#|\sid="/.test(part)) throw new Error(`${to}.svg の顔の元が id か url(#…) を持っています（顔は定義を参照できない）`);
  return rename(body.slice(0, b[0]) + part + body.slice(b[1]), bodyName, to);
}

/** @typedef {{ name: string, kind: 'mirror', from: string } | { name: string, kind: 'face', body: string, face: string }} VariantPlan */

/**
 * 派生の一覧。表情違いが先、左向きが後（左向きの表情違いは書き出した右向きから作る）
 * @param {string[]} names @returns {VariantPlan[]}
 */
export function planVariants(names) {
  const have = new Set(names);
  /** @type {VariantPlan[]} */
  const faces = [];
  for (const name of names) {
    if (!name.startsWith('char-') || name.includes('-side-left')) continue;
    const { role, pose, side, expr } = splitChar(name);
    if (expr === 'normal') continue;
    const dir = side ? `-side-${side}` : '';
    const body = `char-${role}-${pose}${dir}-normal`;
    if (!have.has(body)) continue;
    const face = `char-${role}-stand${dir}-${expr}`;
    if (!have.has(face)) throw new Error(`${name}.svg の顔の元（${face}.svg）がありません。先に立ちポーズの表情を作ってください`);
    faces.push({ name, kind: 'face', body, face });
  }
  const orphan = names.find((n) => n.includes('-side-left') && !have.has(n.replace('-side-left', '-side-right')));
  if (orphan) throw new Error(`${orphan}.svg の元の絵（${orphan.replace('-side-left', '-side-right')}.svg）がありません。左向きは右向きから書き出すので、右向きを描くか、左向きも消してください`);
  /** @type {VariantPlan[]} */
  const mirrors = names.filter((n) => n.includes('-side-right'))
    .map((from) => ({ name: from.replace('-side-right', '-side-left'), kind: /** @type {const} */ ('mirror'), from }));
  return [...faces, ...mirrors];
}

/**
 * 直すべき元の絵の名前
 * @param {VariantPlan} plan @returns {string}
 */
export function sourceOf(plan) {
  if (plan.kind === 'mirror') return `${plan.from}.svg`;
  return `${plan.body}.svg（体）・${plan.face}.svg（顔）`;
}

/**
 * 重ねた見え方で派生を計算する。書き出した結果を順に重ねる。
 * 個人由来に数えるのは、個人の素材集にある元の絵（派生の名前のファイルは、立ちポーズの表情を除いて元に数えない）と、
 * 元（from・body・face）のどれかが個人由来の派生。
 * 個人の素材集にある派生の名前のファイルは、元がすべて共有由来でも作り直して個人由来に数える（共有のポーズに足す表情の置き場など）。
 * ただし作り直した結果が共有の同じ名前のファイルとバイト一致するなら、個人に置く意味が無いので消す側（removed）へ回す
 * @param {import('./library.mjs').Library} lib
 * @returns {{ out: Map<string, string>, removed: string[] }}
 */
function derive(lib) {
  const names = lib.names();
  const files = new Map(names.map((n) => [n, /** @type {string} */ (lib.read(n))]));
  const all = lib.dirs.personal === null;
  const plans = planVariants(names);
  // 立ちポーズの表情（顔の元が自分自身）は描いた絵なので、派生の名前でも元に数える
  const derivedOnly = new Set(plans.filter((p) => !(p.kind === 'face' && p.face === p.name)).map((p) => p.name));
  const mine = new Set(lib.personalNames());
  const personal = new Set([...mine].filter((n) => !derivedOnly.has(n)));
  /** @type {Map<string, string>} */
  const out = new Map();
  /** @type {string[]} */
  const removed = [];
  for (const p of plans) {
    const svg = p.kind === 'mirror'
      ? mirrorSvg(files.get(p.from), p.from, p.name)
      : swapFace(files.get(p.body), p.body, files.get(p.face), p.name);
    files.set(p.name, svg);
    const sources = p.kind === 'mirror' ? [p.from] : [p.body, p.face];
    if (all || sources.some((s) => personal.has(s))) {
      personal.add(p.name);
      out.set(p.name, svg);
    } else if (mine.has(p.name)) {
      if (lib.readShared(p.name) === svg) {
        removed.push(p.name);
      } else {
        personal.add(p.name);
        out.set(p.name, svg);
      }
    }
  }
  return { out, removed };
}

/**
 * 派生の名前 → 書き出す SVG。個人の素材集を重ねているときは、個人由来の派生だけを返す（derive の説明）。
 * personal が null なら全派生を返す（共有の登録用）
 * @param {import('./library.mjs').Library} lib @returns {Map<string, string>}
 */
export function deriveVariants(lib) {
  return derive(lib).out;
}

/**
 * 個人の素材集にある派生のうち、元がすべて共有由来で、作り直すと共有の同じ名前のファイルと一致するもの（消してよい）。
 * personal が null なら空
 * @param {import('./library.mjs').Library} lib @returns {string[]}
 */
export function redundantVariants(lib) {
  return derive(lib).removed;
}
