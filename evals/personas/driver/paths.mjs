// 道具が共通で使う置き場所と設定
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** リポジトリの根。 */
export const ROOT = path.resolve(HERE, '..', '..', '..');

/** 回ごとの記録の置き場所（git に入れない）。 */
export const RUNS = path.join(ROOT, 'evals', 'personas', '.run');

/** 人物ファイルの置き場所。 */
export const PEOPLE = path.join(ROOT, 'evals', 'personas', 'people');

/** 手元のサーバー。 */
export const BASE = process.env.REVALUE_URL ?? 'http://localhost:5080';

/** 画面を動かす道具が待ち受けるポート。 */
export const DRIVER_PORT = Number(process.env.PERSONA_DRIVER_PORT ?? 5199);

/** 人の記号（a〜f）と人物ファイルの名前。 */
export const PERSONAS = {
  a: 'a-madoka',
  b: 'b-fumi',
  c: 'c-kenichi',
  d: 'd-reina',
  e: 'e-sayaka',
  f: 'f-rin',
};

/** 回と人の記録の置き場所。 */
export const runDir = (run, persona) => (persona ? path.join(RUNS, run, persona) : path.join(RUNS, run));
