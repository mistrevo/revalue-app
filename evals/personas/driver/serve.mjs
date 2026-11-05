// ペルソナ評価のための手元のサーバーを用意して動かし続ける。止めるときはこのプロセスを止める。
// 使い方: node evals/personas/driver/serve.mjs [--skip-build]
//   1. .env に ANTHROPIC_API_KEY があるかを、値を表示せずに確かめる
//   2. http://localhost:5080 がすでに使われていたら止まる（古いサーバーに当てないため）
//   3. 画面をビルドし、裏側を evals/personas/.run/server に書き出す（--skip-build なら前の書き出しを使う）
//      書き出したものから動かすのは、Windows では dotnet run 中にビルドの結果がロックされ、ほかのビルドとテストが止まるため
//   4. 開発モード（Development）で起動し、1 往復だけ送って、本物の AI が返事をしているかを確かめる（約 $0.06）
//   5. 「準備ができました」と出したあとは、止められるまで動き続ける。裏側の出力は .run/server.log に書く
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BASE, ROOT, RUNS } from './paths.mjs';
import { login } from '../revalue-client.mjs';

const FAKE_PREFIX = '（開発用の決まった返事）';
const skipBuild = process.argv.includes('--skip-build');
const serverDir = path.join(RUNS, 'server');

function fail(message) {
  console.error(`【止めました】${message}`);
  process.exit(1);
}

/** .env の場所。git の作業ツリー（worktree）から動かしたときは、メインの作業ツリーの .env を使う。 */
function envFile() {
  const here = path.join(ROOT, '.env');
  if (fs.existsSync(here)) return here;
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' });
  const main = r.status === 0 ? path.join(path.dirname(r.stdout.trim()), '.env') : null;
  return main && fs.existsSync(main) ? main : here;
}

/** .env を読む。BOM と CRLF を取り除き、KEY=VALUE の行だけを拾う。値は表示しない。 */
function readEnv() {
  const file = envFile();
  if (!fs.existsSync(file)) fail('.env がありません。リポジトリの根に ANTHROPIC_API_KEY を書いた .env を置いてください（git は無視します）');
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  if (!env.ANTHROPIC_API_KEY) fail('.env に ANTHROPIC_API_KEY がありません。鍵がないと偽の AI に替わり、評価の意味がなくなります');
  return env;
}

async function isUp() {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

function run(cmd, args) {
  // Windows の npm は .cmd なのでシェルを通す。引数はこのファイルで決めた固定の文字だけなので、1 行にまとめて渡す
  const line = [cmd, ...args].join(' ');
  console.log(`> ${line}`);
  const r = spawnSync(line, { cwd: ROOT, stdio: 'inherit', shell: true });
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} が失敗しました（終了コード ${r.status}）`);
}

const env = readEnv();
if (await isUp()) fail(`${BASE} はすでに動いています。前の回のサーバーを止めてから始めてください`);

if (!skipBuild || !fs.existsSync(path.join(serverDir, 'Revalue.Server.dll'))) {
  if (!fs.existsSync(path.join(ROOT, 'src/web/node_modules'))) run('npm', ['--prefix', 'src/web', 'ci']);
  run('npm', ['--prefix', 'src/web', 'run', 'build']);
  run('dotnet', ['publish', 'src/Revalue.Server', '-c', 'Release', '-o', serverDir]);
}

fs.mkdirSync(RUNS, { recursive: true });
const log = fs.openSync(path.join(RUNS, 'server.log'), 'w');
const url = new URL(BASE);
const child = spawn('dotnet', ['Revalue.Server.dll'], {
  cwd: serverDir,
  env: { ...process.env, ...env, ASPNETCORE_ENVIRONMENT: 'Development', ASPNETCORE_URLS: `${url.protocol}//${url.host}` },
  stdio: ['ignore', log, log],
});
child.on('exit', code => {
  console.error(`裏側が止まりました（終了コード ${code}）。.run/server.log を見てください`);
  process.exit(code ?? 1);
});
const stop = () => { child.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

for (let i = 0; i < 60 && !(await isUp()); i++) await new Promise(r => setTimeout(r, 1000));
if (!(await isUp())) { child.kill(); fail('60 秒待っても裏側が起動しませんでした。.run/server.log を見てください'); }

// 本物の AI かを、1 往復で確かめる
const c = await login('serve-check');
await c.consent();
const ep = await c.startEpisode();
const r = await c.send(ep.id, '昨日は夕方に、子どもを習い事に送ったあと、スーパーで夕飯の買い物をしました。', 'free');
if (r.error || !r.reply) { child.kill(); fail(`確かめの返事が返りませんでした（${r.error ?? '空の返事'}）`); }
if (r.reply.startsWith(FAKE_PREFIX)) { child.kill(); fail('返事が偽の AI の決まった返事でした。鍵が読めていません'); }
console.log(`準備ができました: ${BASE}（本物の AI。確かめの返事 ${r.ms} ms）`);
