// 指摘の受け取り（feedback.mjs）。確認ページのコピー文とチャットの自由な文から、カットと指摘を取り出す。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { duplicateOf, logFeedback, markResolved, parseFeedback, readFeedbackLog } from '../scripts/feedback.mjs';

/** 3 カット（0〜3、3〜5、5〜8 秒）の timeline */
const TL = {
  version: 1, title: '新製品紹介', fps: 30, ratios: ['16:9'],
  scenes: [
    { id: 's01', start: 0, end: 3, purpose: 'Hook' },
    { id: 's02', start: 3, end: 5, purpose: '課題' },
    { id: 's03', start: 5, end: 8, purpose: '解決' },
  ],
  texts: [], narration: [], sfx: [], bgm: null,
};

test('確認ページのコピー文が、カット3と全体の2件になる（見出しの行と空行は読まない）', () => {
  const text = [
    '[ns-motion-studio 指摘] 新製品紹介 / rough',
    'カット3（0:05〜0:08）：テロップの『製品』を『サービス』に',
    '',
    '全体：BGM をもう少し静かに',
  ].join('\n');
  const r = parseFeedback(text, TL);
  assert.deepEqual(r.unresolved, []);
  assert.deepEqual(r.items, [
    { cut: 3, start: 5, end: 8, text: 'テロップの『製品』を『サービス』に' },
    { cut: null, text: 'BGM をもう少し静かに' },
  ]);
});

test('全角の数字・コロン・括弧でもカット番号と時刻が取れる', () => {
  const r = parseFeedback('カット３（０：０５〜０：０８）：文字を大きく', TL);
  assert.deepEqual(r.items, [{ cut: 3, start: 5, end: 8, text: '文字を大きく' }]);
});

test('「cut 3」「#3」「カット2の〜」の書き方も受ける', () => {
  const r = parseFeedback('cut 3: 色を明るく\n#1 もっと速く\nカット2のテロップを短く', TL);
  assert.deepEqual(r.items.map((i) => i.cut), [3, 1, 2]);
  assert.equal(r.items[0].text, '色を明るく');
  assert.equal(r.items[1].text, 'もっと速く');
  assert.equal(r.items[2].text, 'カット2のテロップを短く');
  assert.deepEqual(r.unresolved, []);
});

test('時刻だけの行は、その時刻のカットに割り当てる', () => {
  const r = parseFeedback('0:04 の文字が小さい', TL);
  assert.deepEqual(r.items, [{ cut: 2, start: 4, text: '0:04 の文字が小さい' }]);
});

test('指摘の中の 16 進の色はカット番号と取り違えない', () => {
  const r = parseFeedback('0:04 の色を #333333 に\n0:04 #1a1a1a にして', TL);
  assert.deepEqual(r.unresolved, []);
  assert.deepEqual(r.items, [
    { cut: 2, start: 4, text: '0:04 の色を #333333 に' },
    { cut: 2, start: 4, text: '0:04 #1a1a1a にして' },
  ]);
});

test('決められない行は捨てずに unresolved に入れる', () => {
  const r = parseFeedback('なんか暗い\nカット9：ない番号\n0:30 のところ', TL);
  assert.deepEqual(r.items, []);
  assert.deepEqual(r.unresolved, ['なんか暗い', 'カット9：ない番号', '0:30 のところ']);
});

test('指摘を記録し、対応を書き込める', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsms 指摘-'));
  const first = logFeedback(dir, [{ cut: 3, start: 5, end: 8, text: '文字を大きく' }], 'rough');
  const second = logFeedback(dir, [{ cut: null, text: 'BGM を静かに' }], 'rough');
  assert.deepEqual(first, [0]);
  assert.deepEqual(second, [1]);
  markResolved(dir, 0, 'テロップを 64px から 80px にした');
  const log = readFeedbackLog(dir);
  assert.equal(log.items.length, 2);
  assert.equal(log.items[0].gate, 'rough');
  assert.equal(log.items[0].resolved.how, 'テロップを 64px から 80px にした');
  assert.equal(log.items[1].resolved, null);
  assert.ok(fs.existsSync(path.join(dir, 'reviews/feedback-log.json')));
  assert.throws(() => markResolved(dir, 5, 'x'), /5/);
});

test('同じ関門・カット・文の未対応の指摘は二重に記録しない（前の番号を返し、記録の時刻も変えない）。対応済みや別の関門なら記録する', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsms 指摘-'));
  logFeedback(dir, [{ cut: 3, text: 'もう少しゆっくり' }], 'rough');
  const at = readFeedbackLog(dir).items[0].loggedAt;
  assert.equal(duplicateOf(readFeedbackLog(dir), { cut: 3, text: ' もう少しゆっくり ' }, 'rough'), 0);
  assert.deepEqual(logFeedback(dir, [{ cut: 3, text: 'もう少しゆっくり' }, { cut: 1, text: '新しい指摘' }], 'rough'), [0, 1]);
  const log = readFeedbackLog(dir);
  assert.equal(log.items.length, 2);
  assert.equal(log.items[0].loggedAt, at);
  // 別の関門、別のカットなら別の指摘
  assert.equal(duplicateOf(log, { cut: 3, text: 'もう少しゆっくり' }, 'deliver'), -1);
  assert.equal(duplicateOf(log, { cut: 2, text: 'もう少しゆっくり' }, 'rough'), -1);
  // 対応済みの後に同じ文が来たら、新しい指摘として記録する
  markResolved(dir, 0, '0.4 秒から 0.6 秒にした');
  assert.deepEqual(logFeedback(dir, [{ cut: 3, text: 'もう少しゆっくり' }], 'rough'), [2]);
});

test('関門 brief で記録した指摘は briefing として残す', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsms 指摘-'));
  logFeedback(dir, [{ cut: null, text: '目的を変えたい' }], 'brief');
  assert.equal(readFeedbackLog(dir).items[0].gate, 'briefing');
});

test('初版の記録（gate: brief）の指摘と、briefing で貼り直した同じ指摘は二重に記録しない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsms 指摘-'));
  fs.mkdirSync(path.join(dir, 'reviews'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'reviews/feedback-log.json'), JSON.stringify({ items: [{ cut: null, text: '目的を変えたい', gate: 'brief', loggedAt: 'x', resolved: null }] }));
  assert.deepEqual(logFeedback(dir, [{ cut: null, text: '目的を変えたい' }], 'briefing'), [0]);
  assert.equal(readFeedbackLog(dir).items.length, 1);
});
