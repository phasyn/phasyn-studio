// 內建規則的正規表示式只在這裡被「讀」而不執行：依最外層的「|」拆成一個個寫法，讓預覽看得懂。評估用的是 ./evaluate。

/** 依最外層的「|」拆開正規表示式（括號與字元集合裡的不拆）。 */
export function splitAlternatives(pattern: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inClass = false;
  let start = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\") {
      index += 1;
    } else if (inClass) {
      inClass = char !== "]";
    } else if (char === "[") {
      inClass = true;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
    } else if (char === "|" && depth === 0) {
      parts.push(pattern.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(pattern.slice(start));
  return parts.filter((part) => part !== "");
}
