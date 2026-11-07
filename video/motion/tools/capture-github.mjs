// 公開リポジトリの実物の画面を撮って assets/ に置く（ログインなしで見えるページだけ）。
// 使い方: node video/motion/tools/capture-github.mjs [撮るページの名前]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../evals/personas/driver/node_modules/playwright/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(HERE, '..', 'assets');
const REPO = 'https://github.com/mistrevo/revalue-app/blob/main';

// heading: この見出しが画面の上に来るまでスクロールしてから撮る。
// crops: 表の行や箇条書きを、その要素だけで撮る。text はその要素に含まれる文字。
const PAGES = [
  { name: 'real-prd', url: `${REPO}/docs/prd/README.md`, heading: 'h1' },
  {
    name: 'real-validate-fail',
    url: `${REPO}/evals/results/2026-11-03-validate.md`,
    heading: 'h1',
    crops: [
      { name: 'real-fail-result', selector: '.markdown-body li', text: '結果:' },
      { name: 'real-fail-row', selector: '.markdown-body tr', text: '褒めすぎ（根拠ありにしてはいけない力を根拠ありにした）' },
    ],
  },
  {
    name: 'real-validate-pass',
    url: `${REPO}/evals/results/2026-11-03-validate-2.md`,
    heading: 'h1',
    crops: [
      { name: 'real-pass-result', selector: '.markdown-body li', text: '結果:' },
      { name: 'real-pass-row', selector: '.markdown-body tr', text: '褒めすぎ（根拠ありにしてはいけない力を根拠ありにした）' },
    ],
  },
  {
    name: 'real-persona',
    url: `${REPO}/evals/results/2026-11-06-persona.md`,
    heading: 'h1',
    crops: [{ name: 'real-persona-table', selector: '.markdown-body table', text: 'B ふみ' }],
  },
  { name: 'real-workflow', url: `${REPO}/.claude/workflows/run-plan.js`, heading: null },
];

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2, locale: 'ja-JP', colorScheme: 'light' });
const page = await context.newPage();
const only = process.argv[2];
for (const p of PAGES.filter(x => !only || x.name === only)) {
  await page.goto(p.url, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForTimeout(4000);
  if (p.heading) {
    const h = page.locator(`.markdown-body ${p.heading}`).first();
    await h.waitFor({ timeout: 30_000 });
    await h.evaluate(e => window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 150));
    await page.waitForTimeout(1200);
  }
  await page.screenshot({ path: path.join(ASSETS, `${p.name}.png`) });
  console.log(p.name, 'ok');
  if (p.mark) {
    const box = await page.locator(p.mark.selector, { hasText: p.mark.text }).first().boundingBox();
    console.log(`  印の位置（CSS px）: ${JSON.stringify(box)}`);
  }
  for (const c of p.crops ?? []) {
    const loc = page.locator(c.selector, { hasText: c.text }).first();
    await loc.screenshot({ path: path.join(ASSETS, `${c.name}.png`) });
    console.log(`  ${c.name}: ${JSON.stringify(await loc.boundingBox())}`);
  }
}
await browser.close();
