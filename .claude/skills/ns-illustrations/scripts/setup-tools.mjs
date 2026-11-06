// 検品の道具（puppeteer）を ~/.claude/ns-illustrations/tools/ へ入れる。入っていれば何もしない。
//   node <ns-illustrations プラグイン>/scripts/setup-tools.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isMain, toolsDir } from './paths.mjs';

if (isMain(import.meta.url)) {
  const tools = toolsDir();
  if (fs.existsSync(path.join(tools, 'node_modules/puppeteer/package.json'))) {
    console.log(`入っています: ${tools}`);
    process.exit(0);
  }
  fs.mkdirSync(tools, { recursive: true });
  const pkg = path.join(tools, 'package.json');
  if (!fs.existsSync(pkg)) fs.writeFileSync(pkg, JSON.stringify({ name: 'ns-illustrations-tools', private: true }, null, 2) + '\n');
  console.log(`puppeteer を入れます: ${tools}`);
  // 引数配列と shell: true を併用すると DEP0190 警告が出るので、コマンドを 1 本の文字列で渡す（Windows は npm が .cmd のため shell が要る）
  const r = spawnSync(`npm install --prefix "${tools}" puppeteer`, { stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    console.error('puppeteer を入れられませんでした。ネットワークと npm を確認してください。');
    process.exit(1);
  }
  console.log('入れました。');
}
