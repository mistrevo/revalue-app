// Google Fonts のフォントを制作フォルダへ取り込む（描画は常にローカルのファイルを読む）。
//   node fonts.mjs <制作フォルダ> "Noto Sans JP" 400,700
// assets/fonts/ にファイルを置き、assets/fonts/fonts.css に @font-face を足す（同じフォントを取り込み直すと、その定義を置き換える）。
import fs from 'node:fs';
import path from 'node:path';
import { isMain } from './paths.mjs';

/** 通信の時間切れ（社内のネットワークで応答が無いまま止まらないように） */
const TIMEOUT_MS = 60e3;
/** 書体のファイルを同時に取る数 */
const FETCH_PARALLEL = 6;

// css2 は User-Agent を見て形式を変える。新しいブラウザを名乗ると woff2 が返る。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/**
 * @param {string} projectDir 制作フォルダ
 * @param {string} family 例 'Noto Sans JP'
 * @param {number[]} weights 例 [400, 700]
 * @param {{fetch?: typeof fetch}} [opts] fetch は試験用に差し替えられる
 * @returns {Promise<{files: string[], license: string}>} files は制作フォルダからの相対パス
 */
export async function fetchFont(projectDir, family, weights, opts = {}) {
  const doFetch = opts.fetch ?? fetch;
  const fail = (why) => new Error(`フォント「${family}」を取得できません: ${why}`);
  const ws = [...weights].sort((a, b) => a - b).join(';');
  const url = `https://fonts.googleapis.com/css2?family=${family.trim().replace(/\s+/g, '+')}:wght@${ws}&display=swap`;

  let css;
  try {
    const res = await doFetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}（名前か太さが Google Fonts にない可能性があります）`);
    css = await res.text();
  } catch (e) {
    throw fail(e.message);
  }

  // 日本語フォントは unicode-range ごとに多数の @font-face に分かれる。全部残して、どの字でも出るようにする。
  const blocks = css.match(/@font-face\s*\{[^}]*\}/g) ?? [];
  if (!blocks.length) throw fail('応答に @font-face が見つかりません');

  const slug = family.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const outDir = path.join(projectDir, 'assets/fonts');
  fs.mkdirSync(outDir, { recursive: true });

  // 取得先を先に全部確かめてから取りに行く（途中まで取ってから止めない）
  const items = blocks.map((block, i) => {
    const m = block.match(/url\(([^)]+)\)/);
    if (!m) throw fail('@font-face に取得先がありません');
    const w = block.match(/font-weight:\s*(\d+)/)?.[1] ?? 'x';
    const name = `${slug}-${w}-${String(i).padStart(2, '0')}.woff2`;
    const src = m[1].replace(/^['"]|['"]$/g, '');
    // 書体のファイルは Google Fonts の配信元からだけ取る（応答の中の取得先をそのまま信じない）
    if (!src.startsWith('https://fonts.gstatic.com/')) throw fail(`書体のファイルの取得先が Google Fonts ではありません（${src}）`);
    return { name, src, rule: block.replace(/url\([^)]+\)/, `url(./${name})`) };
  });
  // 日本語フォントは 400・700 で 250 ファイルほどになるので、FETCH_PARALLEL 件ずつ同時に取る（1 件ずつだと 30 秒ほどかかる）。
  // どれかが失敗したら、新しく取り始めずに止める
  let next = 0;
  let failed = null;
  const worker = async () => {
    while (!failed && next < items.length) {
      const { name, src } = items[next++];
      try {
        const res = await doFetch(src, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        fs.writeFileSync(path.join(outDir, name), Buffer.from(await res.arrayBuffer()));
      } catch (e) {
        failed ??= fail(`ファイルの取得に失敗しました（${e.message}）`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_PARALLEL, items.length) }, worker));
  if (failed) throw failed;
  const files = items.map((it) => `assets/fonts/${it.name}`);
  const rules = items.map((it) => it.rule);

  const license = 'OFL';
  // 出どころとライセンスを残す（納品の権利一覧が読む。形は review-page.mjs の fontFamilies と合わせる）
  const record = `/* ns-motion-studio: family="${family.trim()}" source="Google Fonts" license="${license}" */`;
  // 同じ書体の前の定義（その書体の記録の行と、font-family がその書体の @font-face）だけを外してから足す。
  // 太さを足して取り込み直しても重ならず、手で書いたほかの書体の定義は残る
  const cssFile = path.join(outDir, 'fonts.css');
  const fam = family.trim();
  const esc = fam.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sameFamily = new RegExp(`font-family:\\s*['"]?${esc}['"]?\\s*;`);
  const before = fs.existsSync(cssFile) ? fs.readFileSync(cssFile, 'utf8') : '';
  let kept = before
    .split(/\r?\n/)
    .filter((l) => !l.includes(`/* ns-motion-studio: family="${fam}"`))
    .join('\n')
    .replace(/@font-face\s*\{[^}]*\}\s*/g, (b) => (sameFamily.test(b) ? '' : b));
  kept = kept.trim() ? `${kept.replace(/\s+$/, '')}\n` : '';
  fs.writeFileSync(cssFile, kept + [record, ...rules].join('\n') + '\n');
  return { files, license };
}

if (isMain(import.meta.url)) {
  const [dir, family, weights] = process.argv.slice(2);
  const ws = (weights ?? '').split(',').map((w) => w.trim());
  try {
    if (!dir || !family || !weights || !ws.every((w) => /^\d{3}$/.test(w))) {
      throw new Error('使い方: node fonts.mjs <制作フォルダ> "Noto Sans JP" 400,700（太さは 100〜900 をカンマで区切る）');
    }
    const r = await fetchFont(dir, family, ws.map(Number));
    console.log(`フォント「${family}」を ${r.files.length} ファイル取り込みました（ライセンス: ${r.license}）: ${path.join(dir, 'assets/fonts/fonts.css')}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
