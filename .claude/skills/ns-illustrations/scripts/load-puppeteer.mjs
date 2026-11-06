// 検品の道具（puppeteer）を ~/.claude/ns-illustrations/tools/ から読む。無ければ案内を出して終了コード 1。
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolsDir } from './paths.mjs';

/** @returns {any} puppeteer */
export function loadPuppeteer() {
  const tools = toolsDir();
  const setup = fileURLToPath(new URL('./setup-tools.mjs', import.meta.url));
  if (!fs.existsSync(path.join(tools, 'node_modules/puppeteer/package.json'))) {
    console.error(`検品の道具（puppeteer）が入っていません。次を実行してください:\n  node ${setup}`);
    process.exit(1);
  }
  try {
    return createRequire(path.join(tools, 'package.json'))('puppeteer');
  } catch (e) {
    // 入っているのに読めない（壊れた導入など）。元のエラーを添える
    console.error(`検品の道具（puppeteer）を読めませんでした: ${e instanceof Error ? e.message : String(e)}\n入れ直すときは次を実行してください:\n  node ${setup}`);
    process.exit(1);
  }
}
