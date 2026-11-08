// 台本を手元の VOICEVOX で読み上げ、部分ごとの声 video/voice/1.wav〜8.wav を作る（git に入れない）。
// 文ごとの読みと置く時刻は video/narration.json。開発者本人の声を録ったときは、その wav を置けばこの道具は要らない。
// 使い方: node video/voice.mjs [--kana] [--speaker <番号>] [--speed 1.0] [--intonation 1.15] [--pause 1.1] [--parts 1,8] [--out <フォルダ>]
//   --kana を付けると、合成せずに、VOICEVOX がどう読むか（アクセント付きのカナ）だけを出す。
//     ' は声が下がる直前の拍、/ は間を置かない区切り、、は間を置く区切り、_ は声を出さない拍（「です」の「す」など）
//   narration.json の文に kana があれば、say の読みの代わりに、その読みとアクセントで読む。
//     機械っぽく聞こえる主な原因（「いい/のだろう」のように助詞や助動詞で区切れて声が上がり直す、アクセントの誤り）をここで直す
//   --pause は句読点の間の長さの倍率、--parts は作る部分の番号、--out は書き出すフォルダ（声の聞き比べ用）
// VOICEVOX のエンジンを http://127.0.0.1:50021 で起動しておく。クレジット「VOICEVOX:<キャラクター名>」を動画と説明欄に入れる
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = process.env.VOICEVOX_URL ?? 'http://127.0.0.1:50021';
const ffmpeg = process.env.FFMPEG ?? path.join(os.homedir(), '.claude/ns-motion-studio/tools/node_modules/ffmpeg-static/ffmpeg.exe');
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const KANA = argv.includes('--kana');
const SPEAKER = Number(opt('--speaker', 14));
const SPEED = Number(opt('--speed', 1.0));
const INTONATION = Number(opt('--intonation', 1.15));
const PAUSE = Number(opt('--pause', 1.1));
const PARTS = opt('--parts', null)?.split(',').map(Number) ?? null;
const GAP = 0.4; // 文と文のあいだの最短の間（秒）。詰めすぎると機械っぽく聞こえる

const narration = JSON.parse(fs.readFileSync(path.join(HERE, 'narration.json'), 'utf8'));
const tmp = path.join(HERE, 'demo', '.run', 'voice');
fs.mkdirSync(tmp, { recursive: true });
const OUT = path.resolve(opt('--out', path.join(HERE, 'voice')));
fs.mkdirSync(OUT, { recursive: true });

async function query(text) {
  const r = await fetch(`${ENGINE}/audio_query?speaker=${SPEAKER}&text=${encodeURIComponent(text)}`, { method: 'POST' });
  if (!r.ok) throw new Error(`audio_query が失敗しました（${r.status}）`);
  return r.json();
}

async function accentPhrases(kanaText) {
  const r = await fetch(`${ENGINE}/accent_phrases?speaker=${SPEAKER}&is_kana=true&text=${encodeURIComponent(kanaText)}`, { method: 'POST' });
  if (!r.ok) throw new Error(`読みの指定を読めませんでした（${r.status}）: ${kanaText}`);
  return r.json();
}

const wavSeconds = buf => buf.readUInt32LE(40) / buf.readUInt32LE(28);

let overflow = false;
for (const part of narration.parts) {
  if (PARTS && !PARTS.includes(part.voice)) continue;
  let clock = 0;
  const placed = [];
  for (const [i, line] of part.lines.entries()) {
    const q = await query(line.say);
    if (line.kana) q.accent_phrases = await accentPhrases(line.kana);
    if (KANA) {
      console.log(`${part.voice}-${i + 1}: ${line.kana ? '（指定）' + line.kana : q.kana}`);
      continue;
    }
    q.speedScale = SPEED * (part.speed ?? 1);
    q.intonationScale = INTONATION;
    q.pauseLengthScale = PAUSE;
    q.prePhonemeLength = 0.05;
    q.postPhonemeLength = 0.1;
    const r = await fetch(`${ENGINE}/synthesis?speaker=${SPEAKER}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(q),
    });
    if (!r.ok) throw new Error(`synthesis が失敗しました（${r.status}）`);
    const buf = Buffer.from(await r.arrayBuffer());
    const file = path.join(tmp, `${part.voice}-${i + 1}.wav`);
    fs.writeFileSync(file, buf);
    const at = Math.max(line.at, clock === 0 ? 0 : clock + GAP);
    const dur = wavSeconds(buf);
    placed.push({ file, at, dur });
    clock = at + dur;
  }
  if (KANA) continue;
  const over = clock > part.length - 0.15;
  overflow ||= over;
  console.log(`${part.voice}: ${placed.map(p => `${p.at.toFixed(1)}〜${(p.at + p.dur).toFixed(1)}`).join(' ')} / ${part.length} 秒${over ? ' 【はみ出し】' : ''}`);
  const args = ['-y', '-loglevel', 'error'];
  for (const p of placed) args.push('-i', p.file);
  const chains = placed.map((p, i) => `[${i}:a]aresample=48000,adelay=${Math.round(p.at * 1000)}:all=1[a${i}]`);
  const mix = `${placed.map((_, i) => `[a${i}]`).join('')}amix=inputs=${placed.length}:normalize=0,apad,atrim=0:${part.length}[a]`;
  args.push('-filter_complex', [...chains, mix].join(';'), '-map', '[a]', '-ac', '1', path.join(OUT, `${part.voice}.wav`));
  const res = spawnSync(ffmpeg, args, { stdio: 'inherit' });
  if (res.status !== 0) throw new Error('ffmpeg が止まりました');
}
if (overflow) {
  console.error('はみ出した部分があります。文を削るか、--speed を上げてください');
  process.exit(1);
}
