// guard.mjs のテスト。実行: node --test .claude/hooks/
// 本物に見える鍵や連絡先をこのファイルに直接書かないよう、文字列はつなぎ合わせて作る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'guard.mjs');
const FAKE_ANTHROPIC_KEY = 'sk-' + 'ant-' + 'api03-' + 'x'.repeat(40);
const FAKE_PRIVATE_KEY = '-----BEGIN ' + 'RSA PRIVATE KEY-----';
const REAL_LOOKING_EMAIL = 'hanako.yamada' + '@' + 'gmail.com';
const REAL_LOOKING_PHONE = '090' + '-1234-' + '5678';

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'guard-test-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  writeFileSync(path.join(dir, '.gitignore'), '.env\n');
  git('add', '.gitignore');
  git('commit', '-q', '-m', 'init');
  return dir;
}

function runGuard(dir, toolName, toolInput) {
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', cwd: dir, tool_name: toolName, tool_input: toolInput });
  const r = spawnSync('node', [GUARD], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  assert.equal(r.status, 0, r.stderr);
  if (!r.stdout.trim()) return { decision: 'allow' };
  const out = JSON.parse(r.stdout);
  return { decision: out.hookSpecificOutput.permissionDecision, reason: out.hookSpecificOutput.permissionDecisionReason };
}

test('鍵を含む書き込みを止める', () => {
  const dir = makeRepo();
  try {
    const r = runGuard(dir, 'Write', { file_path: path.join(dir, 'appsettings.json'), content: `{"key":"${FAKE_ANTHROPIC_KEY}"}` });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /Anthropic/);
    assert.equal(runGuard(dir, 'Edit', { file_path: path.join(dir, 'a.pem.txt'), old_string: 'a', new_string: FAKE_PRIVATE_KEY }).decision, 'deny');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ふつうの書き込みと、git が無視するファイルへの書き込みは通す', () => {
  const dir = makeRepo();
  try {
    assert.equal(runGuard(dir, 'Write', { file_path: path.join(dir, 'README.md'), content: '# RE:VALUE\n2026-11-02 に開始。' }).decision, 'allow');
    assert.equal(runGuard(dir, 'Write', { file_path: path.join(dir, '.env'), content: `ANTHROPIC_API_KEY=${FAKE_ANTHROPIC_KEY}` }).decision, 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('実在しうるメールアドレスと電話番号を止め、例示用のものは通す', () => {
  const dir = makeRepo();
  try {
    const file = path.join(dir, 'evals', 'e01.md');
    assert.equal(runGuard(dir, 'Write', { file_path: file, content: `連絡先: ${REAL_LOOKING_EMAIL}` }).decision, 'deny');
    assert.equal(runGuard(dir, 'MultiEdit', { file_path: file, edits: [{ old_string: 'a', new_string: `電話 ${REAL_LOOKING_PHONE}` }] }).decision, 'deny');
    assert.equal(runGuard(dir, 'Write', { file_path: file, content: 'hanako@example.com と 203209215+mistrevo@users.noreply.github.com' }).decision, 'allow');
    assert.equal(runGuard(dir, 'Write', { file_path: file, content: 'id 00000000-0000-0000-0000-000000000000、日付 2026-11-02、react@18.3.1' }).decision, 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('guard-allow.txt に書いた文字列は通す', () => {
  const dir = makeRepo();
  try {
    const allow = path.join(dir, '.claude', 'hooks');
    execFileSync('node', ['-e', `require('fs').mkdirSync(${JSON.stringify(allow)},{recursive:true})`]);
    writeFileSync(path.join(allow, 'guard-allow.txt'), `# ライセンス表記\n${REAL_LOOKING_EMAIL}\n`);
    assert.equal(runGuard(dir, 'Write', { file_path: path.join(dir, 'LICENSE'), content: REAL_LOOKING_EMAIL }).decision, 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('guard-names.txt のハッシュに当たる名前を止める（名前そのものは書かない）', () => {
  const dir = makeRepo();
  try {
    const hooks = path.join(dir, '.claude', 'hooks');
    execFileSync('node', ['-e', `require('fs').mkdirSync(${JSON.stringify(hooks)},{recursive:true})`]);
    const sha = (s) => createHash('sha256').update(s).digest('hex');
    writeFileSync(path.join(hooks, 'guard-names.txt'), `# 架空の名前で試す\n2 cjk ${sha('ほげ')}\n8 latin ${sha('hogeyama')}\n`);
    const file = path.join(dir, 'CLAUDE.md');
    assert.equal(runGuard(dir, 'Write', { file_path: file, content: 'ほげさんに確認する' }).decision, 'deny');
    assert.equal(runGuard(dir, 'Write', { file_path: file, content: 'Author: HOGEYAMA, Taro' }).decision, 'deny');
    assert.equal(runGuard(dir, 'Write', { file_path: file, content: '開発者に確認する。hogeyamax は別の語' }).decision, 'allow');
    assert.equal(runGuard(dir, 'Bash', { command: 'git commit -m "ほげの指摘を反映"' }).decision, 'deny');
    const r = runGuard(dir, 'Write', { file_path: file, content: 'ほげ' });
    assert.doesNotMatch(r.reason, /ほげ/, '止めた理由に名前そのものを出さない');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('コミットされうる差分に鍵があれば git commit を止める', () => {
  const dir = makeRepo();
  try {
    writeFileSync(path.join(dir, 'config.json'), `{"k":"${FAKE_ANTHROPIC_KEY}"}`);
    assert.equal(runGuard(dir, 'Bash', { command: 'git add -A && git commit -m "設定を足す"' }).decision, 'deny');
    rmSync(path.join(dir, 'config.json'));
    writeFileSync(path.join(dir, '.env'), `K=${FAKE_ANTHROPIC_KEY}`);
    assert.equal(runGuard(dir, 'Bash', { command: 'git add -A && git commit -m "設定を足す"' }).decision, 'allow');
    assert.equal(runGuard(dir, 'Bash', { command: 'ls -la' }).decision, 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('コミットメッセージに連絡先があれば止める', () => {
  const dir = makeRepo();
  try {
    assert.equal(runGuard(dir, 'Bash', { command: `git commit -m "${REAL_LOOKING_EMAIL} さんの指摘を反映"` }).decision, 'deny');
    assert.equal(runGuard(dir, 'Bash', { command: 'git commit -m "直す\n\nCo-Authored-By: Claude <noreply@anthropic.com>"' }).decision, 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
