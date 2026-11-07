// 完成版の動画を timeline.json のシーンごとに切り分け、out/scenes/<シーン>.mp4 に置く。実画面とつなぐときに使う。
// 使い方: node video/motion/tools/split-scenes.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const ffmpeg = process.env.FFMPEG ?? path.join(os.homedir(), '.claude/ns-motion-studio/tools/node_modules/ffmpeg-static/ffmpeg.exe');
const timeline = JSON.parse(fs.readFileSync(path.join(ROOT, 'timeline.json'), 'utf8'));
const source = path.join(ROOT, 'out', `${timeline.title}_16x9.mp4`);
const outDir = path.join(ROOT, 'out', 'scenes');
fs.mkdirSync(outDir, { recursive: true });

for (const s of timeline.scenes) {
  const out = path.join(outDir, `${s.id}.mp4`);
  // 切り口をコマの単位でそろえるため、コピーせずに作り直す
  const r = spawnSync(ffmpeg, [
    '-y', '-loglevel', 'error', '-i', source,
    '-ss', String(s.start), '-t', String(s.end - s.start),
    '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-an', '-movflags', '+faststart', out,
  ], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
  console.log(`${s.id}: ${s.end - s.start} 秒 ${out}`);
}
