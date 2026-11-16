// SPDX-License-Identifier: Apache-2.0 AND PSF-2.0
// fnmatchToRegExp is adapted from CPython's fnmatch.translate (Lib/fnmatch.py, 3.12 series), Copyright (c) 2001-2023
// Python Software Foundation; All Rights Reserved; PSF License Version 2. Modified by the Phasyn Studio authors:
// ported to TypeScript, case-sensitive only, returns a RegExp and rejects invalid character ranges.
// See THIRD_PARTY_NOTICES.md.
import { t } from "@/i18n";
// 子部件 selector：exact 或 Python fnmatch.fnmatchcase 語意（* 跨越 '.'、? 單一字元、[seq]／[!seq]）。
// 與 Node 端 `path == selector or fnmatch.fnmatchcase(path, selector)` 一致；大小寫敏感。

const REGEX_SPECIAL = /[\\^$.*+?()[\]{}|/-]/g;

function escapeRegex(char: string): string {
  return char.replace(REGEX_SPECIAL, "\\$&");
}

function escapeClassChar(char: string): string {
  return char === "\\" || char === "]" || char === "[" || char === "^" ? `\\${char}` : char;
}

/** Python fnmatch.translate 的對應實作；無效的字元範圍（如 [z-a]）拋出錯誤。 */
export function fnmatchToRegExp(pattern: string): RegExp {
  let out = "";
  let index = 0;
  const length = pattern.length;
  while (index < length) {
    const char = pattern.charAt(index);
    index += 1;
    if (char === "*") {
      if (!out.endsWith(".*")) out += ".*";
    } else if (char === "?") {
      out += ".";
    } else if (char === "[") {
      let end = index;
      if (end < length && pattern.charAt(end) === "!") end += 1;
      if (end < length && pattern.charAt(end) === "]") end += 1;
      while (end < length && pattern.charAt(end) !== "]") end += 1;
      if (end >= length) {
        out += "\\[";
      } else {
        let stuff = pattern.slice(index, end);
        index = end + 1;
        let negate = false;
        if (stuff.startsWith("!")) {
          negate = true;
          stuff = stuff.slice(1);
        }
        if (stuff.length === 0) {
          // [!] 匹配任一字元；[] 不可能出現（']' 已被視為內容）
          out += negate ? "." : "(?!)";
        } else {
          // '-' 保留為範圍符號（首尾的 '-' 在字元類別中本來就是字面值）
          out += `[${negate ? "^" : ""}${[...stuff].map(escapeClassChar).join("")}]`;
        }
      }
    } else {
      out += escapeRegex(char);
    }
  }
  return new RegExp(`^(?:${out})$`, "s");
}

export function hasGlob(selector: string): boolean {
  return /[*?[]/.test(selector);
}

export interface SelectorCheck {
  /** null = selector 無效（空字串或範圍錯誤）。 */
  matched: string[] | null;
  error: string | null;
}

/** 依序檢查每個 part path 是否命中 selector。 */
export function matchSelector(selector: string, paths: readonly string[]): SelectorCheck {
  const trimmed = selector.trim();
  if (trimmed.length === 0) return { matched: null, error: t("selector 不可為空") };
  if (trimmed !== selector) return { matched: null, error: t("selector 前後不可有空白") };
  let regex: RegExp;
  try {
    regex = fnmatchToRegExp(selector);
  } catch (cause) {
    return { matched: null, error: t("selector 無法解析：{value}", { value: cause instanceof Error ? cause.message : String(cause) }) };
  }
  return { matched: paths.filter((path) => path === selector || regex.test(path)), error: null };
}
