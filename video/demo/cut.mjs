// 記録した画面を、切り方の表（JSON）に沿って 1 本の動画にする。
// 使い方: node video/demo/cut.mjs <撮りの名前> <切り方の .json> <書き出す .mp4>
// 切り方の表: { "segments": [ { "name": "話す", "from": 7.0, "to": 22.1, "speed": 4, "hold": 1.0 } ] }
//   from と to は記録の始まりからの秒。speed は速さの倍率。hold は最後の画面を止めて見せる秒数
//   maxGap を付けると、変化のない間（AI の返事を待つ間など）をその秒数までに縮める
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [take, cutFile, outFile] = process.argv.slice(2);
if (!take || !cutFile || !outFile) {
  console.error('使い方: node video/demo/cut.mjs <撮りの名前> <切り方の .json> <書き出す .mp4>');
  process.exit(2);
}

const dir = path.join(HERE, '.run', take);
const frames = fs.readFileSync(path.join(dir, 'frames.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const t0 = frames[0].t;
const cut = JSON.parse(fs.readFileSync(cutFile, 'utf8'));
const lines = ['ffconcat version 1.0'];
const ffmpeg = process.env.FFMPEG ?? path.join(os.homedir(), '.claude/ns-motion-studio/tools/node_modules/ffmpeg-static/ffmpeg.exe');
const framePath = name => path.join(dir, 'frames', name).replaceAll('\\', '/');

/** 指定の時刻に画面に出ていたフレームの番号 */
function frameAt(sec) {
  let i = 0;
  while (i + 1 < frames.length && frames[i + 1].t - t0 <= sec) i += 1;
  return i;
}

let total = 0;
for (const s of cut.segments) {
  const first = frameAt(s.from);
  const last = frameAt(s.to);
  const speed = s.speed ?? 1;
  let length = 0;
  for (let i = first; i <= last; i += 1) {
    const start = Math.max(frames[i].t - t0, s.from);
    const end = Math.min(i + 1 < frames.length ? frames[i + 1].t - t0 : s.to, s.to);
    let d = Math.max(end - start, 0) / speed;
    if (s.maxGap !== undefined) d = Math.min(d, s.maxGap);
    if (d <= 0) continue;
    lines.push(`file '${framePath(frames[i].name)}'`, `duration ${d.toFixed(4)}`);
    length += d;
  }
  if (s.hold) {
    lines.push(`file '${framePath(frames[last].name)}'`, `duration ${s.hold.toFixed(4)}`);
    length += s.hold;
  }
  console.log(`${String(s.name ?? '').padEnd(14, '　')} ${total.toFixed(1).padStart(6)} 〜 ${(total + length).toFixed(1).padStart(6)} 秒（${length.toFixed(1)} 秒）`);
  total += length;
}
// ffconcat は最後のファイルの長さを捨てるので、最後の 1 枚をもう一度書く
const lastFile = lines.filter(l => l.startsWith('file ')).at(-1);
lines.push(lastFile);

const list = path.join(dir, 'cut.ffconcat');
fs.writeFileSync(list, lines.join('\n') + '\n');
fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
const r = spawnSync(ffmpeg, [
  '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
  '-vf', 'fps=30,scale=1920:1080:flags=lanczos,format=yuv420p',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-movflags', '+faststart', '-an', outFile,
], { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`書き出しました: ${outFile}（${total.toFixed(1)} 秒）`);
