// 画面を動かす道具（daemon.mjs）に操作を一つ送り、そのあとの画面を受け取る。
// 使い方: node evals/personas/driver/pw.mjs <人> <操作> [引数...]
//   start            ログイン前の最初の画面を開く
//   see              いまの画面を見る（記録には残すが、写真は撮らない）
//   click <番号>     番号のものを押す（番号は画面の「操作できるもの」）
//   type <番号> <文> 入力欄に書く（送るのは、送るボタンを click したとき）
//   select <番号> <選ぶもの>
//   back / close / reopen
//   note <文>        その場で感じたことを書き留める
//   answers          使い終えたあとの答えを残す。中身は標準入力で渡す（例: node pw.mjs a answers <<'EOF' … EOF）
// 引数を付けずに note を呼んだときも、中身は標準入力から読む
import { DRIVER_PORT } from './paths.mjs';

const [persona, cmd, ...rest] = process.argv.slice(2);
if (!persona || !cmd) {
  console.error('使い方: node evals/personas/driver/pw.mjs <人> <操作> [引数...]');
  process.exit(2);
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').trim();
}

const args = (cmd === 'answers' || (cmd === 'note' && rest.length === 0)) ? [await readStdin()] : rest;
try {
  const res = await fetch(`http://127.0.0.1:${DRIVER_PORT}/`, {
    method: 'POST',
    body: JSON.stringify({ persona, cmd, args }),
    signal: AbortSignal.timeout(300_000),
  });
  console.log(await res.text());
} catch (e) {
  console.log(`【操作できませんでした】画面を動かす道具に届きません（${e.message}）。道具が動いているかを、回しているセッションに確かめてもらってください`);
  process.exitCode = 1;
}
