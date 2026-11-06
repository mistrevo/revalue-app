import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REFS = join(ROOT, 'skills', 'make-video', 'references');
const RUNTIME = join(ROOT, 'scripts', 'runtime', 'ms-runtime.js');

/** 作例（似た依頼の組み方の例。製品紹介とサービス紹介は1本） */
const EXAMPLES = ['logo-reveal', 'product-launch', 'product-service-intro', 'tech-explainer', 'product-manual', 'company-intro'];
const EXAMPLE_HEADINGS = ['どんな依頼の例か', '組み合わせた構成の型', '尺と fps の目安', '場面の並びの例', '見せ場の作り方'];
/** 構成の型（spec 3.2 の表の順と名前） */
const STRUCTURES = ['課題 → 解決 → 証拠', '手順', '図で組み上げる解説', '告知', '印象づけ', '物語', '一覧・紹介'];
const STRUCTURE_HEADINGS = ['合う目的', '骨組み', '見せ方のこつ', 'よくある失敗'];
/** 中身ごとの注意（spec 3.4 の表の順と名前） */
const CONTENTS = ['数値、実績、事例', '製品画面', '人物の写真', 'ロゴ', '価格、期間、約束', '社名、製品名、用語', '他社の名前、ロゴ'];
/** 作法の references（作例を含む） */
const CRAFT = ['motion-rules.md', 'sense-to-number.md', 'banned.md', 'structures.md', 'content-rules.md', ...EXAMPLES.map((t) => join('examples', `${t}.md`))];

/** ランタイムのソースから ms.ease のキーを読む（`const ease = { name: ..., }` の中身） */
function runtimeEaseNames() {
  const src = readFileSync(RUNTIME, 'utf8');
  const m = src.match(/const ease = \{([\s\S]*?)\n\s*\};/);
  assert.ok(m, 'ms-runtime.js に ease の定義が見つかりません');
  return [...m[1].matchAll(/^\s*(\w+)\s*:/gm)].map((x) => x[1]);
}

/** 文中の `ms.ease.<name>` の名前 */
function mentionedEaseNames(md) {
  return [...new Set([...md.matchAll(/ms\.ease\.(\w+)/g)].map((x) => x[1]))];
}

/** 見出し（# の数を問わない）の文字列 */
function headings(md) {
  return [...md.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((x) => x[1]);
}

/** ## の節ごとの本文（見出し → 次の ## までの文） */
function sections(md) {
  const out = new Map();
  let cur = null;
  for (const line of md.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { cur = h[1]; out.set(cur, []); } else if (cur) out.get(cur).push(line);
  }
  return new Map([...out].map(([k, v]) => [k, v.join('\n')]));
}

test('作例が6本そろい、どれにも5つの見出しがある', () => {
  const dir = join(REFS, 'examples');
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.md')).sort(), EXAMPLES.map((t) => `${t}.md`).sort());
  for (const t of EXAMPLES) {
    const hs = headings(readFileSync(join(dir, `${t}.md`), 'utf8'));
    for (const h of EXAMPLE_HEADINGS) assert.ok(hs.includes(h), `${t}.md に見出し「${h}」がありません`);
  }
});

test('構成の型が7つそろい、どれにも4つの小見出しがある', () => {
  const secs = sections(readFileSync(join(REFS, 'structures.md'), 'utf8'));
  for (const s of STRUCTURES) {
    assert.ok(secs.has(s), `structures.md に「${s}」の節がありません`);
    const hs = headings(secs.get(s));
    for (const h of STRUCTURE_HEADINGS) assert.ok(hs.includes(h), `「${s}」に小見出し「${h}」がありません`);
  }
});

test('中身ごとの注意が7つそろう', () => {
  const hs = headings(readFileSync(join(REFS, 'content-rules.md'), 'utf8'));
  for (const c of CONTENTS) assert.ok(hs.includes(c), `content-rules.md に「${c}」がありません`);
});

test('types/ はもう無い（作例は examples/ に移した）', () => {
  assert.ok(!existsSync(join(REFS, 'types')));
});

test('banned.md は禁止ではなく、何も言われないときに避ける既定の癖として書く', () => {
  const md = readFileSync(join(REFS, 'banned.md'), 'utf8');
  assert.match(md, /何も言われないときに避ける癖/);
  assert.match(md, /意図して使うときのこつ/);
  assert.doesNotMatch(md, /どの動画でも使わない/);
});

test('motion-rules.md のイージング名が ms.ease のキーと一致する', () => {
  const keys = runtimeEaseNames();
  assert.ok(keys.length > 0);
  const md = readFileSync(join(REFS, 'motion-rules.md'), 'utf8');
  assert.deepEqual(mentionedEaseNames(md).sort(), [...keys].sort());
});

test('ほかの references が書く ms.ease の名前もランタイムにある', () => {
  const keys = new Set(runtimeEaseNames());
  for (const f of CRAFT.filter((x) => x !== 'motion-rules.md')) {
    for (const name of mentionedEaseNames(readFileSync(join(REFS, f), 'utf8'))) {
      assert.ok(keys.has(name), `${f} の ms.ease.${name} はランタイムにありません`);
    }
  }
});

test('作法の references がそろい、丸数字を使っていない', () => {
  for (const f of CRAFT) {
    const p = join(REFS, f);
    assert.ok(existsSync(p), `${f} がありません`);
    assert.doesNotMatch(readFileSync(p, 'utf8'), /[①-⓿❶-➓㉑-㉟㊱-㊿]/u, `${f} に丸数字があります`);
  }
});
