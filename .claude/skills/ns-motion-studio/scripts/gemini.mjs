// Gemini API での読み上げ（TTS）と BGM（Lyria）。どちらも Interactions API。
// 形は公式ドキュメントで確認（2026-10-21）:
//   https://ai.google.dev/gemini-api/docs/speech-generation
//   https://ai.google.dev/gemini-api/docs/music-generation
// キーは環境変数 GEMINI_API_KEY で受ける。制作フォルダには書かない。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { beginRun } from './lock.mjs';
import { isMain, removeFile } from './paths.mjs';
import { readTimeline, writeTimeline } from './timeline.mjs';
import { readProject, writeProject } from './project.mjs';
import { ffmpegPath } from './tools.mjs';
import { pcm16ToWav, readWavBuffer } from './wav.mjs';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';

/** 使う前に利用者へ示して了承を得る注意事項（spec 7章、外部 API の6項目） */
export const NOTICE_EXTERNAL_API = [
  '- 課金設定済み（有料）のプロジェクトのキーを使う。無料枠では、送った内容が Google の製品改善に使われ、人が読むこともある。',
  '- 未公開の製品情報、顧客名、個人情報を含む原稿を送るかどうかは、利用者が判断する。迷う場合は VOICEVOX（ローカル）を勧める。',
  '- 費用がかかる。BGM は1曲 $0.08。読み上げは文字量に応じて課金され、2027-01-01 に単価が上がる予定。',
  '- 生成音声には透かしが入る。他の利用者に似た曲が出る可能性があり、補償は確認できていない。重要な案件では公開前に確認する。',
  '- 特定のアーティストの声や既存曲の歌詞、実在の人物の声は指定しない。',
  '- AI で生成した音であることの表示は、社内のルールに従う。「人が作った」と偽らない。',
].join('\n');

function needKey(apiKey) {
  const key = apiKey ?? process.env.GEMINI_API_KEY;
  if (!key) throw new Error('Gemini のキーがありません。環境変数 GEMINI_API_KEY に設定してください（制作フォルダには書きません）。');
  return key;
}

async function post(body, { apiKey, fetch: f = fetch }) {
  const res = await f(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': needKey(apiKey) },
    body: JSON.stringify(body),
  });
  return res;
}

/** 応答の steps から、最初の音声（base64）を取り出して Buffer にする */
function audioOf(json) {
  for (const step of json.steps ?? []) {
    if (step.type !== 'model_output') continue;
    for (const c of step.content ?? []) if (c.type === 'audio' && c.data) return Buffer.from(c.data, 'base64');
  }
  throw new Error('Gemini の応答に音声が含まれていませんでした。');
}

const isWav = (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF';

/**
 * Gemini で読み上げた WAV（24kHz モノ）を返す。
 * @param {string} text
 * @param {{voice: string, model?: string, apiKey?: string, fetch?: typeof fetch}} opts
 * @returns {Promise<Buffer>}
 */
export async function geminiTts(text, { voice, model = 'gemini-3.8-flash-tts', apiKey, fetch: f = fetch }) {
  const res = await post(
    {
      model,
      input: [{ type: 'user_input', content: [{ type: 'text', text }] }],
      response_format: { type: 'audio', mime_type: 'audio/l16', sample_rate: 24000 },
      generation_config: { speech_config: [{ voice }] },
    },
    { apiKey, fetch: f },
  );
  if (!res.ok) throw new Error(`Gemini の読み上げが失敗しました（HTTP ${res.status}）: ${(await res.text()).slice(0, 300)}`);
  const pcm = audioOf(await res.json());
  return isWav(pcm) ? pcm : pcm16ToWav(pcm, { sampleRate: 24000, channels: 1 });
}

/**
 * Lyria で曲を作る。歌なし（instrumental）を必ず指示に含める。
 * WAV を求め、受け付けられなければ既定の形式（MP3）で頼み直す。戻りの形式は呼び出し側が確かめる。
 * @param {string} prompt
 * @param {{model?: string, format?: 'wav', apiKey?: string, fetch?: typeof fetch}} opts
 * @returns {Promise<Buffer>}
 */
export async function lyriaCompose(prompt, { model = 'lyria-3.5', format = 'wav', apiKey, fetch: f = fetch }) {
  const input = /instrumental/i.test(prompt) ? prompt : `${prompt}\nInstrumental only, no vocals.`;
  let res = await post({ model, input, response_format: { type: 'audio', mime_type: `audio/${format}` } }, { apiKey, fetch: f });
  // 2回目は、要求を断られた（HTTP 400。形式の指定を受け付けない）ときだけ。キー・回数制限・サーバーの失敗では頼み直さない（了承に見せた回数を超えない）
  if (res.status === 400) res = await post({ model, input, response_format: { type: 'audio' } }, { apiKey, fetch: f });
  if (!res.ok) throw new Error(`Gemini の曲づくりが失敗しました（HTTP ${res.status}）: ${(await res.text()).slice(0, 300)}`);
  return audioOf(await res.json());
}

/** 了承済みでなければ、理由付きで例外にする */
export function requireConsent(project) {
  if (!project.externalApiConsent) {
    throw new Error('外部 API（Gemini）を使うには、注意事項への利用者の同意が必要です。注意事項を示して了承を得てから、同意を記録してください。');
  }
}

/**
 * 有料の実行ごとの了承。無ければ、呼ぶ回数と目的を添えて、何も送らずに止める。
 * approved は、利用者がこの実行（回数と目的）に「はい」と言ったときだけ true にする。
 * @param {boolean|undefined} approved
 * @param {{calls: number, purpose: string}} what
 */
export function requireApproval(approved, { calls, purpose }) {
  const line = `有料の API を ${calls} 回呼びます（${purpose}）。`;
  if (!approved) {
    throw new Error(`${line}まだ何も送っていません。回数と目的を利用者に伝え、この実行への利用者本人の了承を得てから、--approved を付けて実行し直してください。`);
  }
  return line;
}

/**
 * 同意を project.json に記録する（注意事項の文面と、利用者本人の言葉ごと）
 * @param {string} dir
 * @param {{quote?: string}} [opts] quote は利用者がチャットに書いた了承の言葉そのまま
 */
export function recordConsent(dir, { quote } = {}) {
  if (!quote || !quote.trim()) {
    throw new Error('同意の記録には、利用者本人がチャットに書いた了承の言葉が必要です（--quote "<利用者の言葉そのまま>"）。代わりに了承しないでください。');
  }
  const p = readProject(dir);
  p.externalApiConsent = { date: new Date().toISOString(), quote: quote.trim(), notice: NOTICE_EXTERNAL_API };
  writeProject(dir, p);
  return p;
}

/** どの音源を使ったかの記録（権利一覧用）。プロンプトの全文は音楽のみ残す */
export function recordModel(dir, entry) {
  const p = readProject(dir);
  p.models = [...(p.models ?? []), { date: new Date().toISOString(), ...entry }];
  writeProject(dir, p);
}

/**
 * BGM を作って audio/bgm.wav に置き、timeline.bgm を設定する。
 * @param {string} dir
 * @param {{prompt: string, seconds?: number, approved?: boolean, apiKey?: string, fetch?: typeof fetch, log?: (m: string) => void}} opts
 */
export async function composeBgm(dir, { prompt, seconds, approved, apiKey, fetch: f = fetch, log = console.log }) {
  requireConsent(readProject(dir));
  log(requireApproval(approved, { calls: 1, purpose: 'BGM を1曲、$0.08。形式の指定を断られた（HTTP 400）ときだけもう1回' }));
  const full = [prompt, seconds ? `Length: about ${seconds} seconds.` : '', 'Instrumental only, no vocals.'].filter(Boolean).join('\n');
  const buf = await lyriaCompose(full, { apiKey, fetch: f });
  const out = path.join(dir, 'audio', 'bgm.wav');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (isWav(buf)) {
    readWavBuffer(buf); // 壊れていないことだけ確かめる
    fs.writeFileSync(out, buf);
  } else {
    // WAV にできなかった場合（MP3）。ffmpeg で 48kHz ステレオの WAV にする
    const tmp = `${out}.src`;
    fs.writeFileSync(tmp, buf);
    const r = spawnSync(ffmpegPath(), ['-y', '-i', tmp, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', out], { stdio: 'ignore' });
    removeFile(tmp);
    if (r.status !== 0) throw new Error('BGM を WAV に変換できませんでした（ffmpeg が失敗）。');
  }
  const tl = readTimeline(dir);
  const bpm = /(\d{2,3})\s*bpm/i.exec(prompt);
  tl.bgm = { file: 'audio/bgm.wav', bpm: bpm ? Number(bpm[1]) : null, gain: -18, source: 'lyria-3.5', license: 'Gemini API 生成物（SynthID 透かし入り）' };
  writeTimeline(dir, tl);
  recordModel(dir, { kind: 'music', model: 'lyria-3.5', prompt: full });
  return tl;
}

if (isMain(import.meta.url)) {
  const [cmd, dir, ...rest] = process.argv.slice(2);
  // 値の欄に次のフラグ（--approved など）が来たら、値が無いとみなす（フラグを値として食わない）
  const opt = (name) => {
    const i = rest.indexOf(`--${name}`);
    const v = i >= 0 ? rest[i + 1] : undefined;
    return v === undefined || v.startsWith('--') ? undefined : v;
  };
  try {
    if (cmd === 'bgm' && dir) {
      const prompt = opt('prompt');
      if (!prompt) throw new Error('--prompt が必要です');
      // 時刻表を書き換えるので、書き出し・点検と重ねない
      beginRun(dir, 'gemini.mjs bgm');
      await composeBgm(dir, { prompt, seconds: opt('seconds') ? Number(opt('seconds')) : undefined, approved: rest.includes('--approved') });
      console.log('BGM を audio/bgm.wav に書きました');
    } else if (cmd === 'consent' && dir) {
      if (!rest.includes('--yes')) {
        // 文面を見せるための正常な実行。誤りに見えないよう、標準出力に出して終了コード 0 で終える（何も記録しない）
        console.log('次の注意事項を、言い換えずに利用者に示してください。利用者本人が了承したら、その言葉をそのまま --quote に入れ、--yes を付けて実行すると記録します（まだ何も記録していません）。\n' + NOTICE_EXTERNAL_API);
      } else {
        recordConsent(dir, { quote: opt('quote') });
        console.log('同意を project.json に記録しました');
      }
    } else {
      throw new Error('使い方: node gemini.mjs bgm <制作フォルダ> --prompt "…" --seconds 60 [--approved] / node gemini.mjs consent <制作フォルダ> [--yes --quote "<利用者の言葉>"]');
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
