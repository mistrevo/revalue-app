// 説明の部分（video/motion）と実画面（video/demo）をつなぎ、声があれば重ねて、提出用の動画を 1 本にする。
// 使い方: node video/build.mjs <切り方の .json> <書き出す .mp4>
// 切り方の表:
//   { "take": "撮りの名前", "parts": [ { "scene": "s01" }, { "demo": [ { "name": "...", "from": 0, "to": 1, "speed": 2, "maxGap": 0.5, "hold": 1 } ],
//       "overlays": [ { "id": "ask-one", "from": 3, "to": 8, "x": 1290, "y": 620 } ] } ] }
//   overlays の from と to は、その部分の先頭からの秒
// 声: video/voice/1.wav〜8.wav のように、部分の順の番号で置く（git に入れない）。parts の "voice": 1 で結びつける。部分の先頭から重ねる
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [cutFile, outFile] = process.argv.slice(2);
if (!cutFile || !outFile) {
  console.error('使い方: node video/build.mjs <切り方の .json> <書き出す .mp4>');
  process.exit(2);
}
const ffmpeg = process.env.FFMPEG ?? path.join(os.homedir(), '.claude/ns-motion-studio/tools/node_modules/ffmpeg-static/ffmpeg.exe');
const cut = JSON.parse(fs.readFileSync(cutFile, 'utf8'));
const work = path.join(HERE, 'demo', '.run', 'build');
fs.mkdirSync(work, { recursive: true });
const posix = p => p.replaceAll('\\', '/');

function run(args) {
  const r = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ffmpeg が止まりました（${r.status}）`);
}

function probeSeconds(file) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  const m = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(r.stderr);
  if (!m) throw new Error(`長さが読めません: ${file}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** 実画面の部分を、記録のコマから切り出す。 */
function demoPart(part, index) {
  const dir = path.join(HERE, 'demo', '.run', cut.take);
  const frames = fs.readFileSync(path.join(dir, 'frames.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const t0 = frames[0].t;
  const frameAt = sec => {
    let i = 0;
    while (i + 1 < frames.length && frames[i + 1].t - t0 <= sec) i += 1;
    return i;
  };
  const framePath = name => posix(path.join(dir, 'frames', name));
  const lines = ['ffconcat version 1.0'];
  let total = 0;
  for (const s of part.demo) {
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
    console.log(`    ${String(s.name ?? '').padEnd(12, '　')} ${total.toFixed(1).padStart(6)} 〜 ${(total + length).toFixed(1).padStart(6)}`);
    total += length;
  }
  lines.push(lines.filter(l => l.startsWith('file ')).at(-1));
  const list = path.join(work, `part${index}.ffconcat`);
  fs.writeFileSync(list, lines.join('\n') + '\n');

  const overlays = part.overlays ?? [];
  const inputs = ['-f', 'concat', '-safe', '0', '-i', list];
  // 静止画は 1 コマしかなく、フェードの時刻に届かないので、部分の長さだけ繰り返す
  for (const o of overlays) inputs.push('-loop', '1', '-framerate', '30', '-t', total.toFixed(3), '-i', path.join(work, 'overlays', `${o.id}.png`));
  const filters = ['[0:v]fps=30,scale=1920:1080:flags=lanczos,format=yuv420p[base]'];
  let last = 'base';
  overlays.forEach((o, i) => {
    const to = o.to ?? total;
    filters.push(`[${i + 1}:v]format=rgba,fade=t=in:st=${o.from}:d=0.2:alpha=1,fade=t=out:st=${Math.max(to - 0.2, o.from)}:d=0.2:alpha=1[o${i}]`);
    filters.push(`[${last}][o${i}]overlay=${o.x}:${o.y}:enable='between(t,${o.from},${to})':format=auto[v${i}]`);
    last = `v${i}`;
  });
  const out = path.join(work, `part${index}.mp4`);
  run([...inputs, '-filter_complex', filters.join(';'), '-map', `[${last}]`, '-t', total.toFixed(3), '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', '-r', '30', '-an', out]);
  return out;
}

const videos = [];
let clock = 0;
const voices = [];
cut.parts.forEach((part, index) => {
  const file = part.scene ? path.join(HERE, 'motion', 'out', 'scenes', `${part.scene}.mp4`) : demoPart(part, index);
  const length = probeSeconds(file);
  console.log(`${String(index + 1).padStart(2)}. ${String(part.name ?? part.scene ?? 'demo').padEnd(10, '　')} ${clock.toFixed(1).padStart(6)} 〜 ${(clock + length).toFixed(1).padStart(6)} 秒`);
  if (part.voice) {
    const wav = path.join(HERE, 'voice', `${part.voice}.wav`);
    if (fs.existsSync(wav)) voices.push({ wav, at: clock });
    else console.log(`    声がまだありません: ${wav}`);
  }
  videos.push(file);
  clock += length;
});

const listFile = path.join(work, 'parts.ffconcat');
fs.writeFileSync(listFile, ['ffconcat version 1.0', ...videos.map(v => `file '${posix(path.resolve(v))}'`)].join('\n') + '\n');
fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });

const args = ['-f', 'concat', '-safe', '0', '-i', listFile];
if (voices.length) {
  for (const v of voices) args.push('-i', v.wav);
  const delays = voices.map((v, i) => `[${i + 1}:a]aresample=48000,adelay=${Math.round(v.at * 1000)}:all=1[a${i}]`);
  const mix = `${voices.map((_, i) => `[a${i}]`).join('')}amix=inputs=${voices.length}:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[a]`;
  args.push('-filter_complex', [...delays, mix].join(';'), '-map', '0:v', '-map', '[a]', '-c:a', 'aac', '-b:a', process.env.AUDIO_BITRATE ?? '192k');
} else {
  args.push('-map', '0:v', '-an');
}
args.push('-c:v', 'libx264', '-preset', process.env.X264_PRESET ?? 'medium', '-crf', process.env.X264_CRF ?? '17', '-pix_fmt', 'yuv420p', '-r', '30', '-movflags', '+faststart', '-t', clock.toFixed(3), outFile);
run(args);
const seconds = probeSeconds(outFile);
console.log(`書き出しました: ${outFile}（${Math.floor(seconds / 60)} 分 ${(seconds % 60).toFixed(1)} 秒、声 ${voices.length} 本）`);
if (seconds > 180) console.log('【注意】3 分を超えています。超えた部分は見てもらえません');
