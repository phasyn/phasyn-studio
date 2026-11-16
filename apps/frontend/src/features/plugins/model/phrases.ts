// 詞組比對（非內建規則的 terms／any_terms），以 contracts/examples/plugin-rules
// 的共用案例約束。prompt 與詞組都先正規化：
//   1. ASCII 字母轉小寫（其他文字不做大小寫轉換：Kelvin 符號 K 不是 k）；
//   2. 彎引號 U+2018、U+2019 視為 '；
//   3. 每一段分隔字元收成一個空格。分隔字元：tab、換行、歸位、空格、不換行空格（U+00A0）、全形空格（U+3000）、
//      連字號 -、U+2010、U+2011 與 en dash（U+2013）。em dash、底線、句點與斜線不是分隔。
// 詞組出現在正規化後的 prompt 裡就算命中；word＝true 時，前後緊鄰的字元不能是 ASCII 字母、數字或底線（頭尾算字界）。
// 只做字串搜尋，從不把詞組組成正規表示式：別人寫的規則不會帶來回溯爆炸（ReDoS），也沒有 JS 與 Python 的 regex 方言差異。

const SEPARATORS: ReadonlySet<number> = new Set([0x09, 0x0a, 0x0d, 0x20, 0xa0, 0x3000, 0x2d, 0x2010, 0x2011, 0x2013]);
const APOSTROPHES: ReadonlySet<number> = new Set([0x2018, 0x2019]);
const SPACE = " ";

function isUpper(code: number): boolean {
  return code >= 0x41 && code <= 0x5a;
}

/** 正規化後的字界判斷：ASCII 小寫字母、數字或底線是「字」的一部分。 */
function isWordCode(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39) || code === 0x5f;
}

/** prompt 或詞組的正規化寫法（上面的 1–3）。 */
export function normalizePhraseText(text: string): string {
  const out: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (SEPARATORS.has(code)) {
      if (out[out.length - 1] !== SPACE) out.push(SPACE);
    } else if (APOSTROPHES.has(code)) out.push("'");
    else out.push(isUpper(code) ? String.fromCharCode(code + 32) : text.charAt(index));
  }
  return out.join("");
}

/** 一個詞組與它正規化後的寫法：規則編譯時算一次，之後每次評估（每按一個鍵）不再重算。 */
export interface PreparedPhrase {
  term: string;
  needle: string;
}

export function preparePhrases(terms: readonly string[]): PreparedPhrase[] {
  return terms.map((term) => ({ term, needle: normalizePhraseText(term) }));
}

/** 一個（已正規化的）詞組有沒有出現在已正規化的 prompt 裡。 */
function needleMatches(needle: string, normalizedPrompt: string, word: boolean): boolean {
  if (needle === "") return false;
  for (let start = normalizedPrompt.indexOf(needle); start >= 0; start = normalizedPrompt.indexOf(needle, start + 1)) {
    if (!word) return true;
    const end = start + needle.length;
    const before = start === 0 || !isWordCode(normalizedPrompt.charCodeAt(start - 1));
    const after = end === normalizedPrompt.length || !isWordCode(normalizedPrompt.charCodeAt(end));
    if (before && after) return true;
  }
  return false;
}

/** 清單裡第一個命中的詞組（照清單裡的寫法回傳）；都沒有命中為 null。 */
export function firstMatchingPhrase(phrases: readonly PreparedPhrase[], normalizedPrompt: string, word: boolean): string | null {
  return phrases.find((phrase) => needleMatches(phrase.needle, normalizedPrompt, word))?.term ?? null;
}

/** 一段文字裡第一個命中的詞組（規則評估以外的地方，例如 Prompt 建議與逐鏡描述，用同一套比對）；都沒有命中為 null。 */
export function findPhrase(phrases: readonly PreparedPhrase[], text: string, word: boolean): string | null {
  return firstMatchingPhrase(phrases, normalizePhraseText(text), word);
}
