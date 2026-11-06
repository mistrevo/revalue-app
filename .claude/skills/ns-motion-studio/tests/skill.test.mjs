// make-video スキル（SKILL.md と工程の references）の形を確かめる。
// 文書が指すファイルとコマンドが実在し、書いたフラグがスクリプトに本当にあることを見る（存在しない手順を案内しないため）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKILL_DIR = path.join(ROOT, 'skills', 'make-video');
const SKILL = path.join(SKILL_DIR, 'SKILL.md');
const REFS = path.join(SKILL_DIR, 'references');

/** 工程の references（Task 13 で書くもの） */
const PROCESS_REFS = ['setup', 'briefing', 'style', 'storyboard', 'composition', 'review-loop', 'audio', 'export', 'revise', 'claude-motion-fallback'];

/** references の下の .md をすべて（examples/ も含む） */
function referenceFiles(dir = REFS) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return referenceFiles(p);
    return e.name.endsWith('.md') ? [p] : [];
  });
}

const read = (f) => fs.readFileSync(f, 'utf8');
const docs = () => [SKILL, ...referenceFiles()];

test('SKILL.md の frontmatter に name: make-video と description がある', () => {
  const md = read(SKILL);
  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(fm, 'frontmatter がありません');
  assert.match(fm[1], /^name: make-video$/m);
  const desc = fm[1].match(/^description: (.+)$/m);
  assert.ok(desc, 'description がありません');
  assert.match(desc[1], /対象外/, 'description に対象外（スライドや既存資料の動画化）を書いてください');
  assert.ok(desc[1].length <= 1024, 'description が長すぎます');
});

test('工程の references がそろっている', () => {
  for (const name of PROCESS_REFS) assert.ok(fs.existsSync(path.join(REFS, `${name}.md`)), `${name}.md がありません`);
});

test('SKILL.md が指す references と scripts がすべて実在する', () => {
  const md = read(SKILL);
  const refs = [...md.matchAll(/references\/[\w./-]+\.md/g)].map((m) => m[0]);
  const scripts = [...md.matchAll(/scripts\/[\w./-]+\.m?js/g)].map((m) => m[0]);
  assert.ok(refs.length >= PROCESS_REFS.length, 'SKILL.md が工程の references を指していません');
  assert.ok(scripts.length > 0, 'SKILL.md がスクリプトを指していません');
  for (const r of refs) assert.ok(fs.existsSync(path.join(SKILL_DIR, r)), `${r} がありません`);
  for (const s of scripts) assert.ok(fs.existsSync(path.join(ROOT, s)), `${s} がありません`);
});

test('references の中の相対リンクがすべて実在する', () => {
  for (const f of referenceFiles()) {
    for (const m of read(f).matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)) {
      if (/^https?:/.test(m[1])) continue;
      assert.ok(fs.existsSync(path.resolve(path.dirname(f), m[1])), `${path.relative(REFS, f)} のリンク ${m[1]} がありません`);
    }
  }
});

/** 文書に書いた `node …/scripts/X.mjs …` のコマンド（ファイル、行、スクリプト名、コマンド全体、スクリプトのあとの引数） */
function commands() {
  const out = [];
  for (const f of docs()) {
    for (const line of read(f).split(/\r?\n/)) {
      for (const m of line.matchAll(/node\s+\S*?scripts\/([\w-]+\.mjs)"?([^`|]*)/g)) {
        out.push({ where: `${path.relative(SKILL_DIR, f)}: ${line.trim()}`, script: m[1], command: m[0], args: m[2] });
      }
    }
  }
  return out;
}

/** 文書に出てくる CLI のサブコマンド（位置引数の語） */
const SUBCOMMANDS = new Set(['at', 'beats', 'contact', 'strips', 'consent', 'bgm', 'slice', 'validate', 'init', 'approve', 'stage', 'course', 'intent', 'fallback', 'log', 'resolve', 'speakers']);

test('文書に書いた node <…>/scripts/X.mjs が実在し、添えたフラグとサブコマンドがそのスクリプトにある', () => {
  const cmds = commands();
  assert.ok(cmds.length >= 10, `コマンドの記載が少なすぎます（${cmds.length} 件）`);
  for (const { where, script, args } of cmds) {
    const file = path.join(ROOT, 'scripts', script);
    assert.ok(fs.existsSync(file), `${script} がありません（${where}）`);
    const src = read(file);
    for (const flag of args.match(/--[a-z][a-z-]*/g) ?? []) {
      // CLI は opt('--preset') のようにフラグをそのまま書くか、`--${name}` で組んで opt('voice') と呼ぶ
      const exact = src.includes(`'${flag}'`);
      const built = src.includes('`--${name}`') && src.includes(`opt('${flag.slice(2)}')`);
      assert.ok(exact || built, `${script} に ${flag} がありません（${where}）`);
    }
    // フラグの値を除いた、引用されていない語のうち、サブコマンドに当たるもの
    const words = args.replace(/"[^"]*"/g, ' ').split(/\s+/).filter((w, i, all) => w && !w.startsWith('--') && !all[i - 1]?.startsWith('--'));
    for (const w of words.filter((x) => SUBCOMMANDS.has(x))) {
      assert.ok(src.includes(`'${w}'`), `${script} にサブコマンド ${w} がありません（${where}）`);
    }
  }
});

test('コマンドの中の <プラグイン> と <制作> は、ダブルクォートで囲んでいる（空白を含むパスのため）', () => {
  for (const { where, command } of commands()) {
    assert.match(command, /^node\s+"<プラグイン>\/scripts\//, `スクリプトのパスを "<プラグイン>/scripts/…" と囲んでください（${where}）`);
    assert.doesNotMatch(command, /(^|[^"])<(制作|プラグイン)>/, `囲まれていない <制作> か <プラグイン> があります（${where}）`);
  }
});

test('SKILL.md と references に丸数字が無い', () => {
  for (const f of docs()) {
    assert.doesNotMatch(read(f), /[①-⑳]/u, `${path.relative(SKILL_DIR, f)} に丸数字があります`);
  }
});

test('SKILL.md の description は7種類の列挙ではなく、動画全般を対象にする', () => {
  const desc = read(SKILL).match(/^description: (.+)$/m)[1];
  assert.doesNotMatch(desc, /製品マニュアル・製品ローンチ・会社紹介の動画/);
  assert.match(desc, /告知/);
  assert.match(desc, /採用/);
});

test('SKILL.md に3つのコースと、コースごとの確認と自己点検の周の上限がある', () => {
  const md = read(SKILL);
  for (const s of ['お試し', 'サンプル', '本番', 'trial', 'sample', 'full', 'plan', 'project.mjs" course']) assert.ok(md.includes(s), `SKILL.md に「${s}」がありません`);
  assert.match(md, /お試し[^\n]*1周/);
  assert.match(md, /サンプル[^\n]*2周/);
  assert.match(md, /本番[^\n]*4周/);
});

test('SKILL.md の原則で、固定するのは事実を作らないことだけと書き、既定から外す宣言の方法を示す', () => {
  const md = read(SKILL);
  assert.match(md, /既定から外す/);
  assert.match(md, /project\.mjs" intent/);
  assert.match(md, /data-ms-intent/);
});

test('工程の文書が structures.md・content-rules.md・examples/ を指す', () => {
  const brief = read(path.join(REFS, 'briefing.md'));
  for (const s of ['structures.md', 'content-rules.md', 'examples/']) assert.ok(brief.includes(s), `briefing.md が ${s} を指していません`);
});

test('工程の文書に、古い段階・関門の名前（brief）と「ブリーフ」の語が残っていない', () => {
  for (const f of docs()) {
    const md = read(f);
    assert.doesNotMatch(md, /ブリーフ(?!ィング)/u, `${path.relative(SKILL_DIR, f)} に「ブリーフ」があります`);
    assert.doesNotMatch(md, /"<制作>" brief\b|\bbrief\.md\b|（brief）/, `${path.relative(SKILL_DIR, f)} に古い名前 brief があります`);
  }
});

/** プラグインの下の文字のファイル（.md .mjs .js .html .json）。node_modules は除く */
function textFiles(dir = ROOT) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : textFiles(p);
    return /\.(md|mjs|js|html|json)$/.test(e.name) ? [p] : [];
  });
}

test('プラグインの中に「ブリーフ」（ブリーフィングを除く）が残っていない', () => {
  // 語を分けて組む（この検査の行そのものに当たらないように）
  const word = 'ブリー' + 'フ';
  const found = new RegExp(word + '(?!ィング)', 'u');
  const files = textFiles();
  assert.ok(files.length > 50, `走査したファイルが少なすぎます（${files.length} 件）`);
  for (const f of files) {
    // ほかの検査が書いた正規表現と、検査の名前の「ブリーフ」は数えない
    const text = read(f).split(word + '(?!ィング)').join('').split('「' + word + '」').join('');
    assert.doesNotMatch(text, found, `${path.relative(ROOT, f)} に「${word}」があります`);
  }
});
