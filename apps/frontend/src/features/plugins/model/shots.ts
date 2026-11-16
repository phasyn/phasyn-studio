// 逐鏡檢查（規則的 shots）怎麼把 prompt 切成鏡頭：與參考實作
// （tools/contracts/plugin_rules_reference.py）用同一套規則，並以 contracts/examples/plugin-rules 的共用案例約束。
//   1. 只有換行（LF）結束一行；緊接在換行前的 CR 屬於換行。
//   2. 一行以欄位名稱加冒號（半形或全形）開頭，就開始那個欄位。prompt 有這樣的行時，只有 detailed_description 與
//      integrated_multimodal_description 描述鏡頭；一行都沒有時，整份 prompt 都是描述。
//   3. 描述裡的每個鏡頭標記（[Shot 2]、同一鏡的時段 [Shot 1, 00:00.000-00:02.000]；Shot 不分 ASCII 大小寫）開始一個鏡頭，
//      到下一個標記、只有空格與 tab 的一行，或下一個欄位為止。同號的鏡頭是同一個鏡頭；鏡頭的文字是標記之後的內容。
//   4. 台詞（<d> 到下一個 </d>，沒有 </d> 就到結尾）在鏡頭的文字裡算成一個空格：說出來的話不會被畫出來。
//   5. subject_definitions 裡以 <Subject N> 開頭的行定義角色 N。角色與鏡頭都依第一次出現的順序，同號只算一次。
// 純函式，不用 u 旗標：與 Python 的 re 一樣只認 ASCII 的數字與字母。

const FIELD_HEADING =
  /^[ \t]*(subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music)[ \t]*[:：]/;
const DESCRIPTION_FIELDS: ReadonlySet<string> = new Set(["detailed_description", "integrated_multimodal_description"]);
const SHOT_MARKER = /\[[Ss][Hh][Oo][Tt][ \t]*([0-9]{1,3})[ \t]*(?:,[^\]\n]*)?\]/g;
const SUBJECT_TAG = /<Subject[ \t]*([0-9]{1,3})>/g;
const SUBJECT_AT_START = /^<Subject[ \t]*([0-9]{1,3})>/;
const DIALOGUE_OPEN = "<d>";
const DIALOGUE_CLOSE = "</d>";

export interface ShotText {
  /** N of [Shot N]. */
  number: number;
  /** What follows the shot's markers (several spans joined by line feeds), dialogue counted as one space. */
  text: string;
}

export interface ShotScan {
  /** The subjects subject_definitions defines, in the order they are first defined. */
  subjects: readonly number[];
  shots: readonly ShotText[];
}

function linesOf(prompt: string): string[] {
  const pieces = prompt.split("\n");
  return pieces.map((piece, index) => (index < pieces.length - 1 && piece.endsWith("\r") ? piece.slice(0, -1) : piece));
}

/** 台詞（<d> 到下一個 </d>，沒有 </d> 就到結尾）換成一個空格。 */
export function withoutDialogue(text: string): string {
  let out = "";
  let start = 0;
  for (;;) {
    const opened = text.indexOf(DIALOGUE_OPEN, start);
    if (opened < 0) return out + text.slice(start);
    out += `${text.slice(start, opened)} `;
    const closed = text.indexOf(DIALOGUE_CLOSE, opened + DIALOGUE_OPEN.length);
    if (closed < 0) return out;
    start = closed + DIALOGUE_CLOSE.length;
  }
}

export function scanShots(prompt: string): ShotScan {
  const lines = linesOf(prompt);
  const headings = lines.map((line) => FIELD_HEADING.exec(line));
  const sectioned = headings.some((heading) => heading !== null);
  const parts = new Map<number, string[]>();
  const subjects: number[] = [];
  let field: string | null = null;
  let current: number | null = null;
  lines.forEach((line, index) => {
    const heading = headings[index] ?? null;
    let content = line;
    if (heading) {
      field = heading[1] ?? null;
      content = line.slice(heading[0].length);
      current = null;
    }
    if (field === "subject_definitions") {
      const defined = SUBJECT_AT_START.exec(content.replace(/^[ \t]+/, ""));
      const number = defined ? Number(defined[1]) : null;
      if (number !== null && !subjects.includes(number)) subjects.push(number);
    }
    if ((sectioned && (field === null || !DESCRIPTION_FIELDS.has(field))) || /^[ \t]*$/.test(content)) {
      current = null;
      return;
    }
    const markers = [...content.matchAll(SHOT_MARKER)];
    const first = markers[0];
    if (current !== null) parts.get(current)?.push(first ? content.slice(0, first.index) : content);
    markers.forEach((marker, at) => {
      const end = markers[at + 1]?.index ?? content.length;
      const number = Number(marker[1]);
      const list = parts.get(number) ?? [];
      list.push(content.slice(marker.index + marker[0].length, end));
      parts.set(number, list);
      current = number;
    });
  });
  return { subjects, shots: [...parts].map(([number, list]) => ({ number, text: withoutDialogue(list.join("\n")) })) };
}

/** The subjects a shot's text names (<Subject N>, compared by number). */
export function namedSubjects(text: string): Set<number> {
  return new Set([...text.matchAll(SUBJECT_TAG)].map((match) => Number(match[1])));
}
