#!/usr/bin/env node
// SessionStart フック: 自走の進み具合（docs/superpowers/progress.md）を最初に読ませる。
// セッションやアカウントが切り替わっても、続きから始められるようにするため。
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const MAX_LINES = 120;
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const file = path.join(projectDir, 'docs', 'superpowers', 'progress.md');

if (existsSync(file)) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const body = lines.slice(0, MAX_LINES).join('\n');
  const more = lines.length > MAX_LINES ? '\n…（続きは docs/superpowers/progress.md）' : '';
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `自走の進み具合（docs/superpowers/progress.md）:\n\n${body}${more}`,
    },
  }));
}
