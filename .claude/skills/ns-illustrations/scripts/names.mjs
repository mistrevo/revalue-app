// 素材のファイル名の読み方。catalog.mjs と variants.mjs が相互に import しないよう、ここに置く。

export const EXPRESSIONS = ['normal', 'smile', 'confused', 'surprised'];

/**
 * 人物のファイル名を ロール・ポーズ・向き・表情に分ける（style-guide.md「命名規則」「横向き」）
 * @param {string} name
 * @returns {{ role: string, pose: string, side: string, expr: string }}
 */
export function splitChar(name) {
  const rest = name.replace(/^char-/, '');
  const m = rest.match(/^(.+?)-([a-z]+)(?:-side-(left|right))?-([a-z]+)$/);
  if (!m || !EXPRESSIONS.includes(m[4])) throw new Error(`人物のファイル名が命名規則に合いません: ${name}.svg`);
  return { role: m[1], pose: m[2], side: m[3] ?? '', expr: m[4] };
}
