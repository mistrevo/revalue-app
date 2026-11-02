/**
 * 文字、数字、句読点、記号の文字だが、画面には何も出ないもの（ハングルの埋め字、点字の空白）。
 * 裏側（src/Revalue.Server/Features/Profile/ProfileEndpoints.cs の HasVisibleText）と同じにする。
 */
const BLANK_LOOKING = /[\u115F\u1160\u3164\uFFA0\u2800]/gu

/**
 * 見える文字（文字、数字、句読点、記号）を 1 つ以上含むか。空白、幅のない空白（U+200B）などの書式文字、制御文字、
 * 結合文字だけの言葉は、画面で空の項目に見えるので false。裏側も同じ言葉を断るので、保存する前に止める。
 */
export function hasVisibleText(text: string): boolean {
  return /[\p{L}\p{N}\p{P}\p{S}]/u.test(text.replace(BLANK_LOOKING, ''))
}
