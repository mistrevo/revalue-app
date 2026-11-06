// 挿絵の素材集の目録 catalog.md と、利用者に素材の全体を絵で見せる一覧 gallery.html を作る。
// 名前の一覧と、名前から SVG を読む関数を受け取る（どのフォルダを見せるかは呼ぶ側が決める）。
// 描き方の決まりは同じフォルダの style-guide.md が持つ。目録はファイルから読み取れることだけを書く。
import { EXPRESSIONS, splitChar } from './names.mjs';

/** @type {Record<string, string>} */
const CATEGORY = {
  obj: '物（obj-）',
  icon: '概念アイコン（icon-）',
  ui: '画面UI（ui-）',
  fx: '演出パーツ（fx-）',
  bg: '背景（bg-）',
  bld: '建物（bld-）',
  animal: '動物（animal-）',
  space: '宇宙（space-）',
  wear: '装着小物（wear-）',
};
/** 生成物に書く、作り直すコマンド */
const SHARED_COMMAND = 'node plugins/ns-illustrations/scripts/register.mjs --shared';
const PERSONAL_COMMAND = 'node <ns-illustrations プラグイン>/scripts/register.mjs';
/** 個人の素材集には style-guide.md が無いので、リンクにせず置き場を書く */
const PERSONAL_GUIDE = 'プラグインの assets/illustrations/style-guide.md';

/** @typedef {{ personal?: boolean }} BuildOptions 個人の素材集の目録・一覧を作るなら personal: true */

/** @typedef {{ name: string, viewBox: string, groups: { id: string, pivot: boolean }[], texts: string[] }} Asset */

/** @param {string} name @param {string} svg @returns {Asset} */
function parse(name, svg) {
  const viewBox = (svg.match(/<svg[^>]*\sviewBox="([^"]+)"/) ?? [])[1] ?? '';
  // 部品の名前は data-part に書く。id は url(#…) で参照する clipPath・gradient だけで、ファイル名の接頭辞が付く（style-guide.md「命名規則」）
  const stray = [...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]).filter((id) => !id.startsWith(name + '-'));
  if (stray.length) throw new Error(`${name}.svg に接頭辞の無い id があります（部品の名前は data-part に書く）: ${stray.join(', ')}`);
  // 部品は <g> に限らない（口の <path>、ランプの <circle> など）。差し替える文字の <text> は別に数える
  const groups = [...svg.matchAll(/<(?!text\b)([a-z]+)\b([^>]*)>/g)].flatMap((m) => {
    const id = (m[2].match(/\sdata-part="([^"]+)"/) ?? [])[1];
    return id ? [{ id, pivot: /\sdata-pivot=/.test(m[2]) }] : [];
  });
  const texts = [...svg.matchAll(/<text\b[^>]*\sdata-part="([^"]+)"/g)].map((m) => m[1]);
  return { name, viewBox, groups, texts };
}

const size = (/** @type {string} */ vb) => vb.split(/\s+/).slice(2).join('×');
const parts = (/** @type {Asset} */ a) =>
  a.groups.filter((g) => g.id !== 'shadow').map((g) => (g.pivot ? `${g.id}*` : g.id)).join(' ') || 'なし';

/** 名前をファイル名の順（<名前>.svg の昇順）に並べて読み込む */
function load(names, read) {
  return names.map((n) => n + '.svg').sort().map((f) => f.slice(0, -4)).map((n) => parse(n, read(n)));
}

/**
 * 目録 catalog.md
 * @param {string[]} names SVG の名前（拡張子なし） @param {(name: string) => string} read 名前 → SVG の中身
 * @param {BuildOptions} [opts] @returns {string}
 */
export function buildCatalog(names, read, { personal = false } = {}) {
  const assets = load(names, read);
  const command = personal ? PERSONAL_COMMAND : SHARED_COMMAND;
  const guide = personal ? `規格（描き方・色・部品の決まり）は${PERSONAL_GUIDE}。` : '描き方・色・部品の決まりは [style-guide.md](style-guide.md)。';
  /** @type {string[]} */
  const out = [
    '# 挿絵の素材カタログ',
    '',
    `> 自動生成（\`${command}\`）。手で書き換えない。${guide}`,
    '>',
    `> 素材 ${assets.length} 点。「動かせる部品」は \`data-part\` の名前で、\`*\` は \`data-pivot\`（回転の中心）付き。足元の影（shadow）は省く。`,
    '',
  ];

  // 人物：ロールごとに、ポーズ × 向きの表で表情を並べる。部品は骨格の種類ごとに 1 回だけ書く
  const chars = assets.filter((a) => a.name.startsWith('char-'));
  /** @type {Map<string, Asset[]>} */
  const roles = new Map();
  for (const a of chars) {
    const { role } = splitChar(a.name);
    roles.set(role, [...(roles.get(role) ?? []), a]);
  }
  out.push(`## 人物（char-） ${chars.length} 点`, '', 'キャンバスは全員 400×760（接地線 y=730）。ファイル名は `char-{ロール}-{ポーズ}[-side-{right|left}]-{表情}.svg`。', '');
  if (personal) {
    // 個人の素材集には正面の立ちが無いロールもあるので、基準にした絵の名前をロールごとに書く
    out.push('| ロール（基準にした絵） | 動かせる部品 |', '|---|---|');
    for (const [role, list] of roles) {
      const base = list.find((a) => a.name.endsWith('-stand-normal'))
        ?? list.find((a) => a.name.endsWith('-normal') && !a.name.includes('-side-left')) ?? list[0];
      out.push(`| ${role}（${base.name}） | ${parts(base)} |`);
    }
  } else {
    /** @type {Map<string, string[]>} */
    const rigs = new Map();
    for (const [role, list] of roles) {
      const base = list.find((a) => a.name.endsWith('-stand-normal')) ?? list[0];
      const key = parts(base);
      rigs.set(key, [...(rigs.get(key) ?? []), role]);
    }
    out.push('| ロール | 正面の立ち（stand-normal）の動かせる部品 |', '|---|---|');
    for (const [key, rs] of rigs) out.push(`| ${rs.join('・')} | ${key} |`);
  }
  out.push('', 'ポーズによって部品が増える（座りの shin-L/R、小物の prop-* など）。使うファイルの中身で確かめる。', '');
  for (const [role, list] of roles) {
    /** @type {Map<string, Map<string, string[]>>} */
    const rows = new Map();
    for (const a of list) {
      const { pose, side, expr } = splitChar(a.name);
      const cols = rows.get(pose) ?? new Map();
      const col = side ? `side-${side}` : 'front';
      cols.set(col, [...(cols.get(col) ?? []), expr].sort((x, y) => EXPRESSIONS.indexOf(x) - EXPRESSIONS.indexOf(y)));
      rows.set(pose, cols);
    }
    out.push(`### ${role}`, '', '| ポーズ | 正面 | 横・右向き | 横・左向き |', '|---|---|---|---|');
    for (const [pose, cols] of rows) {
      const cell = (/** @type {string} */ c) => (cols.get(c) ?? []).join(' ') || '—';
      out.push(`| ${pose} | ${cell('front')} | ${cell('side-right')} | ${cell('side-left')} |`);
    }
    out.push('');
  }

  // 人物以外：種類ごとに 1 ファイル 1 行
  for (const [prefix, title] of Object.entries(CATEGORY)) {
    const list = assets.filter((a) => a.name.startsWith(prefix + '-'));
    if (list.length === 0) continue;
    const hasText = list.some((a) => a.texts.length > 0);
    out.push(`## ${title} ${list.length} 点`, '');
    out.push(hasText ? '| 素材 | 大きさ | 動かせる部品 | 差し替える文字 |' : '| 素材 | 大きさ | 動かせる部品 |');
    out.push(hasText ? '|---|---|---|---|' : '|---|---|---|');
    for (const a of list) {
      const row = `| ${a.name} | ${size(a.viewBox)} | ${parts(a)} |`;
      out.push(hasText ? `${row} ${a.texts.join(' ') || '—'} |` : row);
    }
    out.push('');
  }

  const known = new Set(['char', ...Object.keys(CATEGORY)]);
  const unknown = assets.filter((a) => !known.has(a.name.split('-')[0]));
  if (unknown.length) throw new Error(`接頭辞が命名規則に無い素材があります: ${unknown.map((a) => a.name).join(', ')}`);
  return out.join('\n');
}

const esc = (/** @type {string} */ s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/** @type {Record<string, string>} */
const EXPRESSION_LABEL = { normal: '普通', smile: '笑顔', confused: '困り', surprised: '驚き' };

/**
 * 一覧のカードのまとめ方。左右と人物の表情違いを 1 カードにし、先頭（右向き・普通の顔）を最初に表示する
 * @param {string[]} names @returns {{ key: string, names: string[] }[]}
 */
export function galleryGroups(names) {
  /** @type {Map<string, string[]>} */
  const groups = new Map();
  for (const n of [...names].sort()) {
    let key = n.replace('-side-left', '-side-right');
    if (key.startsWith('char-')) key = key.replace(new RegExp(`-(${EXPRESSIONS.join('|')})$`), '');
    groups.set(key, [...(groups.get(key) ?? []), n]);
  }
  const rank = (/** @type {string} */ n) => (n.includes('-side-left') ? 10 : 0) + Math.max(0, EXPRESSIONS.findIndex((e) => n.startsWith('char-') && n.endsWith('-' + e)));
  return [...groups].map(([key, list]) => ({ key, names: list.sort((x, y) => rank(x) - rank(y) || x.localeCompare(y)) }));
}

/**
 * 利用者に素材の全体を見せる一覧 gallery.html。素材は同じフォルダの SVG を相対パスで読む（素材を直せば一覧も変わる）
 * @param {string[]} names SVG の名前（拡張子なし） @param {(name: string) => string} read 名前 → SVG の中身
 * @param {BuildOptions} [opts] @returns {string}
 */
export function buildGallery(names, read, { personal = false } = {}) {
  const command = personal ? PERSONAL_COMMAND : SHARED_COMMAND;
  const guide = personal ? `規格は${PERSONAL_GUIDE}` : '描き方は style-guide.md';
  const assets = load(names, read);
  const byName = new Map(assets.map((a) => [a.name, a]));
  const card = (/** @type {{ names: string[] }} */ g) => {
    const a = /** @type {Asset} */ (byName.get(g.names[0]));
    const sides = g.names.some((n) => n.includes('-side-left')) ? `<span class="seg">${[['right', '右'], ['left', '左']].map(([k, t], i) => `<button type="button" data-side="${k}" aria-pressed="${i === 0}">${t}</button>`).join('')}</span>` : '';
    const exprs = EXPRESSIONS.filter((e) => g.names.some((n) => n.startsWith('char-') && n.endsWith('-' + e)));
    const faces = exprs.length > 1 ? `<span class="seg">${exprs.map((e) => `<button type="button" data-expr="${e}" aria-pressed="${a.name.endsWith('-' + e)}">${EXPRESSION_LABEL[e]}</button>`).join('')}</span>` : '';
    return `<div class="card" data-names="${esc(g.names.join(' '))}" data-current="${esc(a.name)}"><button class="pick" type="button" title="クリックでファイル名をコピー"><span class="thumb"><img src="${esc(a.name)}.svg" alt="" loading="lazy"></span><span class="name">${esc(a.name)}</span><span class="meta">${esc(size(a.viewBox))}</span></button>${sides || faces ? `<div class="opts">${sides}${faces}</div>` : ''}</div>`;
  };
  const cards = (/** @type {Asset[]} */ list) => galleryGroups(list.map((a) => a.name)).map(card).join('');
  /** @type {string[]} */
  const sections = [];
  const chars = assets.filter((a) => a.name.startsWith('char-'));
  /** @type {Map<string, Asset[]>} */
  const roles = new Map();
  for (const a of chars) {
    const { role } = splitChar(a.name);
    roles.set(role, [...(roles.get(role) ?? []), a]);
  }
  sections.push(`<section data-cat="char"><h2>人物（char-）<small>${chars.length} 点</small></h2>` +
    [...roles].map(([role, list]) => `<h3>${esc(role)}<small>${list.length} 点</small></h3><div class="grid tall">${cards(list)}</div>`).join('') + '</section>');
  for (const [prefix, title] of Object.entries(CATEGORY)) {
    const list = assets.filter((a) => a.name.startsWith(prefix + '-'));
    if (list.length === 0) continue;
    sections.push(`<section data-cat="${prefix}"><h2>${esc(title)}<small>${list.length} 点</small></h2><div class="grid${prefix === 'bg' ? ' wide' : ''}">${cards(list)}</div></section>`);
  }
  const nav = [['char', '人物'], ...Object.entries(CATEGORY).map(([k, t]) => [k, t.replace(/（.*$/, '')])]
    .filter(([k]) => assets.some((a) => a.name.startsWith(k + '-')))
    .map(([k, t]) => `<a href="#cat-${k}">${esc(t)}</a>`).join('');
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>挿絵の素材一覧</title>
<!-- 自動生成（${esc(command)}）。手で書き換えない。部品の名前は catalog.md、${esc(guide)} -->
<style>
:root { --bg: #F6F7FB; --fg: #1B1730; --muted: #5A5F78; --line: #DADFEA; --card: #FFFFFF; --accent: #2BB3AA; --stage: #EEF2F6; color-scheme: light; }
:root.dark-stage { --stage: #1B1F4A; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font-family: 'Zen Kaku Gothic New', 'Hiragino Sans', 'Yu Gothic UI', 'Yu Gothic', sans-serif; line-height: 1.6; }
header { position: sticky; top: 0; z-index: 2; background: var(--bg); border-bottom: 1px solid var(--line); padding: 12px max(16px, 3vw); display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
h1 { font-size: 1.2rem; margin: 0; }
header .count { color: var(--muted); font-size: .85rem; }
nav { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: .9rem; }
nav a { color: var(--fg); }
.tools { display: flex; gap: 8px; align-items: center; margin-left: auto; }
input[type=search] { font: inherit; padding: 4px 10px; border: 1px solid var(--line); border-radius: 6px; min-width: 14em; }
.tools button { font: inherit; font-size: .85rem; padding: 4px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--fg); cursor: pointer; }
main { padding: 8px max(16px, 3vw) 48px; }
h2 { font-size: 1.1rem; margin: 28px 0 8px; scroll-margin-top: 80px; }
h3 { font-size: .95rem; margin: 16px 0 6px; color: var(--muted); }
small { font-weight: 400; color: var(--muted); margin-left: 8px; font-size: .8rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.grid.wide { grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
.card { display: grid; align-content: start; border: 1px solid var(--line); border-radius: 8px; background: var(--card); overflow: hidden; }
.card:hover, .card:focus-within { border-color: var(--accent); }
.pick { display: grid; gap: 2px; padding: 0 0 6px; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.pick:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.opts { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 6px 6px; }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
.seg button { font: inherit; font-size: .7rem; padding: 1px 6px; border: 0; background: var(--card); color: var(--muted); cursor: pointer; }
.seg button + button { border-left: 1px solid var(--line); }
.seg button[aria-pressed="true"] { background: var(--accent); color: #fff; }
.thumb { display: block; background: var(--stage); aspect-ratio: 1; padding: 8px; }
.grid.tall .thumb { aspect-ratio: 4 / 5; }
.grid.wide .thumb { aspect-ratio: 16 / 9; padding: 0; }
.thumb img { display: block; width: 100%; height: 100%; object-fit: contain; }
.name { padding: 0 8px; font-size: .75rem; overflow-wrap: anywhere; }
.meta { padding: 0 8px; font-size: .7rem; color: var(--muted); }
.card.copied .name::after { content: ' ✓ コピーしました'; color: var(--accent); }
[hidden] { display: none !important; }
</style>
</head>
<body>
<header>
<h1>挿絵の素材一覧</h1><span class="count">${assets.length} 点</span>
<nav>${nav}</nav>
<div class="tools"><input type="search" id="q" placeholder="名前で絞り込む（例: dog, side-right）" aria-label="名前で絞り込む"><button type="button" id="stage">暗い地で見る</button></div>
</header>
<main>
${sections.join('\n').replace(/<section data-cat="([a-z]+)">/g, '<section data-cat="$1" id="cat-$1">')}
</main>
<script>
// カードの表示を名前 1 つに揃える（絵・名前・コピーする名前・押下状態）
function show(c, name) {
  c.dataset.current = name;
  c.querySelector('img').src = name + '.svg';
  c.querySelector('.name').textContent = name;
  for (const b of c.querySelectorAll('[data-side]')) b.setAttribute('aria-pressed', String(name.includes('-side-' + b.dataset.side)));
  for (const b of c.querySelectorAll('[data-expr]')) b.setAttribute('aria-pressed', String(name.endsWith('-' + b.dataset.expr)));
}
const q = document.getElementById('q');
q.addEventListener('input', () => {
  const words = q.value.trim().toLowerCase().split(/\\s+/).filter(Boolean);
  for (const c of document.querySelectorAll('.card')) {
    const hits = c.dataset.names.split(' ').filter((n) => words.every((w) => n.includes(w)));
    c.hidden = hits.length === 0;
    if (hits.length && !hits.includes(c.dataset.current)) show(c, hits[0]);
  }
  for (const g of document.querySelectorAll('.grid')) { const empty = !g.querySelector('.card:not([hidden])'); g.hidden = empty; if (g.previousElementSibling && g.previousElementSibling.tagName === 'H3') g.previousElementSibling.hidden = empty; }
  for (const s of document.querySelectorAll('section')) s.hidden = !s.querySelector('.card:not([hidden])');
});
const stage = document.getElementById('stage');
stage.addEventListener('click', () => { const dark = document.documentElement.classList.toggle('dark-stage'); stage.textContent = dark ? '明るい地で見る' : '暗い地で見る'; });
document.addEventListener('click', async (e) => {
  const c = e.target.closest('.card'); if (!c) return;
  const opt = e.target.closest('[data-side], [data-expr]');
  if (opt) {
    const cur = c.dataset.current;
    const next = opt.dataset.side ? cur.replace(/-side-(left|right)/, '-side-' + opt.dataset.side) : cur.replace(/-[a-z]+$/, '-' + opt.dataset.expr);
    if (c.dataset.names.split(' ').includes(next)) show(c, next);
    return;
  }
  if (!e.target.closest('.pick')) return;
  try { await navigator.clipboard.writeText(c.dataset.current + '.svg'); c.classList.add('copied'); setTimeout(() => c.classList.remove('copied'), 1200); } catch {}
});
</script>
</body>
</html>
`;
}
