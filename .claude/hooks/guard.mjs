#!/usr/bin/env node
// PreToolUse フック: 公開リポジトリに鍵や実在の人の連絡先が入るのを止める。
//
// 調べるもの
//   - Write / Edit / MultiEdit / NotebookEdit で書き込む中身
//     （リポジトリの外と、git が無視するファイル（.env など）は調べない）
//   - Bash の git commit: コミットメッセージと、コミットされうる差分（ステージ済み・未ステージ・未追跡）
//   - Bash の git push: まだ送っていないコミットの差分
//
// 鍵は例外なく止める。連絡先は、載せてよいもの（ライセンス表記など）に限り
// .claude/hooks/guard-allow.txt に 1 行 1 つで書けば通す。
// 開発者の名前は、.claude/hooks/guard-names.txt に「文字数 種類（latin か cjk） 小文字にした名前の SHA-256」
// を書いて照らし合わせる。短い名前のハッシュは総当たりで戻せるので、このファイルは git が無視する（手元と VM に置く）。
// テスト: node --test .claude/hooks/guard.test.mjs
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const SECRET_PATTERNS = [
  ['Anthropic の API キー', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['GitHub のトークン', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/],
  ['Azure の接続文字列のキー', /\b(?:AccountKey|SharedAccessKey)=[A-Za-z0-9+/]{30,}/],
  ['Azure の SAS トークン', /[?&]sig=[A-Za-z0-9%+/]{30,}/],
  ['Azure のクライアントシークレット', /(?<![A-Za-z0-9_~.-])[A-Za-z0-9_~.]{3}\dQ~[A-Za-z0-9_~.-]{31,34}(?![A-Za-z0-9_~.-])/],
  ['Google の OAuth クライアントシークレット', /GOCSPX-[A-Za-z0-9_-]{20,}/],
  ['AWS のアクセスキー', /\bAKIA[0-9A-Z]{16}\b/],
  ['秘密鍵', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const SAFE_EMAILS = [
  /@(?:[A-Za-z0-9-]+\.)*example\.(?:com|net|org|jp|co\.jp)$/i,
  /@(?:[A-Za-z0-9-]+\.)*(?:example|test|invalid|localhost)$/i,
  /@users\.noreply\.github\.com$/i,
  /^noreply@anthropic\.com$/i,
  /^git@github\.com$/i,
];
// 日本の電話番号（ハイフンつき）。GUID や日付に当たらないよう、前後のハイフンと桁数で絞る。
const PHONE = /(?<![\d-])(?:0\d{1,4}-\d{1,4}-\d{4}|\+81[-\s]?\d{1,4}[-\s]?\d{1,4}[-\s]?\d{4})(?![\d-])/g;

const MAX_FILE_BYTES = 1024 * 1024;

function mask(s) {
  return s.length <= 8 ? s : `${s.slice(0, 6)}…`;
}

function loadAllowList(projectDir) {
  const file = path.join(projectDir, '.claude', 'hooks', 'guard-allow.txt');
  if (!existsSync(file)) return new Set();
  return new Set(
    readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')),
  );
}

function loadNames(projectDir) {
  const file = path.join(projectDir, '.claude', 'hooks', 'guard-names.txt');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/)
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => { const [len, kind, hash] = l.split(/\s+/); return { len: Number(len), kind, hash }; })
    .filter((n) => n.len > 0 && (n.kind === 'latin' || n.kind === 'cjk') && /^[0-9a-f]{64}$/.test(n.hash));
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function containsName(text, names) {
  if (!names.length) return false;
  const lower = text.toLowerCase();
  for (const n of names) {
    if (n.kind === 'latin') {
      // ローマ字の名前は、英字の並びとして丸ごと一致するときだけ当てる
      for (const m of lower.matchAll(/[a-z]+/g)) {
        if (m[0].length === n.len && sha256(m[0]) === n.hash) return true;
      }
    } else {
      // 漢字・かなの名前は、漢字・かなの並びの中のどこかに含まれていれば当てる
      for (const m of lower.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu)) {
        const chars = Array.from(m[0]);
        for (let i = 0; i + n.len <= chars.length; i++) {
          if (sha256(chars.slice(i, i + n.len).join('')) === n.hash) return true;
        }
      }
    }
  }
  return false;
}

function scan(text, where, allow, names = []) {
  const found = [];
  if (containsName(text, names)) found.push(`開発者の名前（ここには表示しない）（${where}）`);
  for (const [label, re] of SECRET_PATTERNS) {
    const m = text.match(re);
    if (m) found.push(`${label}: ${mask(m[0])}（${where}）`);
  }
  for (const m of text.matchAll(EMAIL)) {
    const email = m[0];
    if (allow.has(email) || SAFE_EMAILS.some((re) => re.test(email))) continue;
    found.push(`メールアドレス: ${mask(email)}（${where}）`);
  }
  for (const m of text.matchAll(PHONE)) {
    const digits = m[0].replace(/\D/g, '');
    const looksJapanese = digits.startsWith('81') ? digits.length >= 11 && digits.length <= 12 : digits.length >= 10 && digits.length <= 11;
    if (!looksJapanese || allow.has(m[0])) continue;
    found.push(`電話番号: ${mask(m[0])}（${where}）`);
  }
  return found;
}

function git(projectDir, args) {
  return execFileSync('git', args, { cwd: projectDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
}

function tryGit(projectDir, args) {
  try { return git(projectDir, args); } catch { return null; }
}

function addedLines(diff) {
  return diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n');
}

function isIgnoredOrOutside(projectDir, filePath) {
  const rel = path.relative(projectDir, path.resolve(projectDir, filePath));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return true;
  const posix = rel.split(path.sep).join('/');
  if (posix === '.git' || posix.startsWith('.git/')) return true;
  try {
    execFileSync('git', ['check-ignore', '-q', '--', posix], { cwd: projectDir, stdio: 'ignore' });
    return true; // 終了コード 0 = 無視されるファイル
  } catch {
    return false;
  }
}

function writtenText(toolName, input) {
  switch (toolName) {
    case 'Write': return input.content ?? '';
    case 'Edit': return input.new_string ?? '';
    case 'MultiEdit': return (input.edits ?? []).map((e) => e.new_string ?? '').join('\n');
    case 'NotebookEdit': return input.new_source ?? '';
    default: return '';
  }
}

function untrackedText(projectDir) {
  const list = tryGit(projectDir, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (!list) return [];
  const out = [];
  for (const rel of list.split('\0').filter(Boolean)) {
    const abs = path.join(projectDir, rel);
    try {
      if (statSync(abs).size > MAX_FILE_BYTES) continue;
      const buf = readFileSync(abs);
      if (buf.includes(0)) continue; // バイナリは見ない
      out.push([rel, buf.toString('utf8')]);
    } catch { /* 読めないファイルは飛ばす */ }
  }
  return out;
}

function checkCommit(projectDir, command, allow, names) {
  const found = scan(command, 'コミットのコマンド', allow, names);
  const staged = tryGit(projectDir, ['diff', '--cached', '--no-color', '-U0']) ?? '';
  const unstaged = tryGit(projectDir, ['diff', '--no-color', '-U0']) ?? '';
  found.push(...scan(addedLines(staged + '\n' + unstaged), '変更した行', allow, names));
  for (const [rel, text] of untrackedText(projectDir)) found.push(...scan(text, rel, allow, names));
  return found;
}

function checkPush(projectDir, allow, names) {
  const range = tryGit(projectDir, ['rev-parse', '--verify', '-q', '@{u}']) !== null
    ? '@{u}..HEAD'
    : tryGit(projectDir, ['rev-parse', '--verify', '-q', 'origin/main']) !== null ? 'origin/main..HEAD' : 'HEAD';
  const log = tryGit(projectDir, ['log', '-p', '--no-color', '--format=', range]) ?? '';
  // 作成者名とコミットメッセージは行頭に + がないので、差分の追加行とは別に名前だけ調べる
  const meta = tryGit(projectDir, ['log', '--no-color', '--format=%an %cn%n%B', range]) ?? '';
  const found = scan(addedLines(log), `送るコミット（${range}）`, allow, names);
  if (containsName(meta, names)) found.push(`開発者の名前（ここには表示しない）（送るコミットの作成者名かメッセージ）`);
  return found;
}

function deny(found) {
  const reason = [
    '公開リポジトリに入れてはいけないものが見つかったので止めました（.claude/hooks/guard.mjs）。',
    ...found.map((f) => `- ${f}`),
    '直し方: 鍵は Key Vault か .env（git が無視する）に置き、コードからは設定として読む。人の連絡先は架空のものか example.com の例に置き換える。開発者の名前は「開発者」と書く（コミットの作成者名なら git config user.name を直す）。',
    'ライセンス表記など、実在の連絡先でも載せてよいものだけは .claude/hooks/guard-allow.txt に 1 行で足し、理由をコミットメッセージに書く。',
    'フックを外す、文字列を分けて書くなどの回避はしない。',
  ].join('\n');
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
}

function main() {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const toolName = input.tool_name ?? '';
  const toolInput = input.tool_input ?? {};
  const allow = loadAllowList(projectDir);
  const names = loadNames(projectDir);
  let found = [];

  if (toolName === 'Bash') {
    const command = toolInput.command ?? '';
    if (/\bgit\s+(?:-[Cc]\s+\S+\s+)*commit\b/.test(command)) found.push(...checkCommit(projectDir, command, allow, names));
    if (/\bgit\s+(?:-[Cc]\s+\S+\s+)*push\b/.test(command)) found.push(...checkPush(projectDir, allow, names));
  } else {
    const filePath = toolInput.file_path ?? toolInput.notebook_path;
    if (filePath && !isIgnoredOrOutside(projectDir, filePath)) {
      found = scan(writtenText(toolName, toolInput), path.relative(projectDir, path.resolve(projectDir, filePath)), allow, names);
    }
  }

  if (found.length) deny([...new Set(found)]);
}

try {
  main();
} catch (err) {
  process.stderr.write(`guard.mjs でエラーが起きたため、確認せずに通しました: ${err?.message ?? err}\n`);
  process.exit(1);
}
