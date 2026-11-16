// 首幀對齊句規則：有首幀的鏡頭第一行要有官方的對齊句（後面空一行），需要尾幀的對齊句換成首幀的；只用文字與參考素材的
// 鏡頭不用對齊句。介面說「首幀對齊句」，句子本身是要原樣寫進 prompt 的英文。
import { I2VA_ALIGNMENT_LINE } from "../templates";
import { ensureI2vaLine, removeAlignmentLines } from "../transforms";
import type { Finding } from "../types";
import { fieldWithKey } from "../words";
import { finding, type RuleContext } from "./context";
import { t } from "@/i18n";

export function alignmentRules(ctx: RuleContext): Finding[] {
  const { scan, mode, firstFrame } = ctx;
  const lines = scan.alignment;
  const i2va = lines.filter((line) => line.kind === "i2va");
  const pair = lines.find((line) => line.kind === "pair");
  if (mode === "fl2va" && firstFrame) {
    if (pair) {
      return [
        finding("format.alignment-line-mode", {
          title: t("這句對齊句需要尾幀，這個鏡頭只有首幀"),
          detail: t("把這句換成首幀用的對齊句；這個鏡頭只送出首幀（上一鏡的最後一格或選的圖片），沒有尾幀。首幀的對齊句是：{i2vaAlignmentLine}", { i2vaAlignmentLine: I2VA_ALIGNMENT_LINE }),
          range: pair,
          fix: { label: t("換成首幀對齊句"), apply: ensureI2vaLine },
        }),
      ];
    }
    const first = i2va[0];
    if (!first) {
      return [
        finding("format.i2va-line-missing", {
          title: t("第一行還沒有首幀對齊句"),
          detail: t("在 prompt 第一行加上首幀對齊句，空一行再寫其他內容；這句告訴模型影片從首幀開始。首幀在模型裡叫 <Picture 1>，對齊句是：{i2vaAlignmentLine}", { i2vaAlignmentLine: I2VA_ALIGNMENT_LINE }),
          fix: { label: t("在第一行加上首幀對齊句"), apply: ensureI2vaLine },
        }),
      ];
    }
    if (!first.first || !first.blankAfter || i2va.length > 1) {
      return [
        finding("format.i2va-line-position", {
          title: t("首幀對齊句要在第一行，後面空一行"),
          detail: t("把對齊句移到 prompt 的第一行，下面空一行再接其他內容，只留一句；官方規定它必須在這個位置。"),
          range: first,
          fix: { label: t("把對齊句移到第一行"), apply: ensureI2vaLine },
        }),
      ];
    }
    return [];
  }
  const firstLine = lines[0];
  if ((mode === "t2va" || mode === "ref2va") && firstLine) {
    const t2va = mode === "t2va";
    return [
      finding("format.alignment-line-mode", {
        title: t2va ? t("沒有首幀，對齊句用不到") : t("參考素材鏡頭不用首幀對齊句"),
        detail: t2va
          ? t("刪掉這句對齊句；要從一張圖開始，把「方式」改成「接續上一鏡」或「首幀圖片」。只用文字的鏡頭不送任何圖片，句子裡的 <Picture 1> 沒有對應的畫面。")
          : t("刪掉這句對齊句；要讓某張參考圖當開場畫面，在{field}寫「<Picture N> is the first frame of [Shot 1]」。參考素材和首幀不能同時用。", {
              field: fieldWithKey("subject_definitions"),
            }),
        range: firstLine,
        fix: { label: t("刪除對齊句"), apply: removeAlignmentLines },
      }),
    ];
  }
  return [];
}
