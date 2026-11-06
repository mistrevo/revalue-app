// fetchFont を偽の fetch で検証する（ネットワークは使わない）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fetchFont } from '../scripts/fonts.mjs';

function tmpDir() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nsms-font-')), '動画 テスト', '新製品 紹介');
}

test('404 のときは日本語の理由付きで例外', async () => {
  const f = async () => ({ ok: false, status: 404 });
  await assert.rejects(fetchFont(tmpDir(), 'Noto Sans JP', [400], { fetch: f }), /フォント.*取得できません/);
});

test('css の全サブセットを保存し、ローカル参照の @font-face を追記する', async () => {
  const css = `/* japanese */
@font-face {
  font-family: 'Noto Sans JP';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/a.woff2) format('woff2');
  unicode-range: U+3000-30FF;
}
/* latin */
@font-face {
  font-family: 'Noto Sans JP';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/b.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}`;
  const urls = [];
  const f = async (url) => {
    urls.push(String(url));
    if (String(url).includes('fonts.googleapis.com')) return { ok: true, status: 200, text: async () => css };
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('W2').buffer };
  };
  const dir = tmpDir();
  const r = await fetchFont(dir, 'Noto Sans JP', [400, 700], { fetch: f });
  assert.match(urls[0], /family=Noto\+Sans\+JP:wght@400;700&display=swap/);
  assert.equal(r.license, 'OFL');
  assert.equal(r.files.length, 2);
  for (const file of r.files) assert.ok(fs.existsSync(path.join(dir, file)), file);
  const out = fs.readFileSync(path.join(dir, 'assets/fonts/fonts.css'), 'utf8');
  assert.match(out, /url\(\.\/[^)]+\.woff2\)/);
  assert.match(out, /unicode-range: U\+3000-30FF/);
  assert.ok(!out.includes('gstatic'));
  // 出どころとライセンスを残す（納品の権利一覧が読む）
  assert.match(out, /\/\* ns-motion-studio: family="Noto Sans JP" source="Google Fonts" license="OFL" \*\//);
});

test('書体のファイルは同時に取り、順番どおりに名前と定義を並べる。1 つでも失敗したら止める', async () => {
  const n = 20;
  const css = Array.from({ length: n }, (_, i) => `@font-face {
  font-family: 'Noto Sans JP';
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/${i}.woff2) format('woff2');
  unicode-range: U+${i};
}`).join('\n');
  let active = 0;
  let peak = 0;
  const make = (bad) => async (url) => {
    if (String(url).includes('fonts.googleapis.com')) return { ok: true, status: 200, text: async () => css };
    active++;
    peak = Math.max(peak, active);
    // 後ろのほうを先に返して、終わる順が並びと違っても名前と定義の順が保たれることを見る
    const i = Number(/\/(\d+)\.woff2/.exec(String(url))[1]);
    await new Promise((r) => setTimeout(r, (n - i) * 2));
    active--;
    if (i === bad) return { ok: false, status: 500 };
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(String(i)).buffer };
  };
  const dir = tmpDir();
  const r = await fetchFont(dir, 'Noto Sans JP', [400], { fetch: make(-1) });
  assert.ok(peak > 1 && peak <= 6, `同時に取った数 ${peak}`);
  assert.deepEqual(r.files, Array.from({ length: n }, (_, i) => `assets/fonts/noto-sans-jp-400-${String(i).padStart(2, '0')}.woff2`));
  r.files.forEach((f, i) => assert.equal(fs.readFileSync(path.join(dir, f), 'utf8'), String(i)));
  const out = fs.readFileSync(path.join(dir, 'assets/fonts/fonts.css'), 'utf8');
  const order = [...out.matchAll(/unicode-range: U\+(\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(order, Array.from({ length: n }, (_, i) => i));

  await assert.rejects(fetchFont(tmpDir(), 'Noto Sans JP', [400], { fetch: make(3) }), /取得に失敗しました（HTTP 500）/);
});
