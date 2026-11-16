// 「複製改寫指令」（純函式，不連網）：指南的 LLM 改寫指令（原文照錄，602 字元）＋本機條件＋素材對照表＋目前的 prompt。
// 使用者自己貼到慣用的 LLM；這不是官方 H3-Context-IR，也不宣稱有相同品質（指南原話）。
import { KIND_LABEL } from "../../references/materials";
import { clipText, labelPlan, type ReferenceLabel } from "./labels";
import { I2VA_ALIGNMENT_LINE } from "./templates";
import { clipTiming, describeClip, formatCueTime } from "./timing";
import type { AnalyzeInput, PromptMode } from "./types";

/** Phasyn Studio 作者撰寫的 H3 Prompt 指南中「交給 LLM 改寫時的可重用指令」原文（隨本專案授權公開）。 */
export const REWRITE_INSTRUCTION = "請把我提供的創作需求整理成 MiniMax-H3 的模型用 Prompt。\n\n先辨認用途：T2VA、I2VA、FL2VA、L2VA 或 Ref2VA；不要把人物外觀參考誤當作首幀。\n依 MiniMax 官方 Base 或 Full-Reference Guide 選對欄位與段落順序。若可讀取原文，先讀對應指南；若讀不到，明確說明，不要假稱已查閱。\n用英文撰寫模型用改寫段落；對白、歌詞與畫面可見文字保留我提供的原文。\n所有素材編號必須來自實際輸入與順序，沒有提供的素材不得虛構。每份素材先定義用途，再在對應鏡頭中引用。\n每鏡交代起始位置、主要動作、接觸或狀態變化、反應與終點。分開描述人物速度、攝影機運動及切鏡節奏。\n高速戰鬥以開場即動作、短促接觸、立即反應和持續移位來表達；保留可見的武器接觸點與角色辨識特徵。\n使用 [Shot 1] 作開場，不加開場時間戳；後續切鏡使用官方時間格式，且必須遞增並落在指定片長內。\n把環境與動作音效、人物台詞、背景配樂放到對應位置。沒有背景配樂時，non_diegetic_music 使用 N/A。\n不要自動添加我未要求的對白、旁白、慢動作或新的故事事件。若條件衝突，先列出衝突，再給出最小修改方案。\n\n輸出：模式與素材對照；可直接複製的最終 Prompt；需要另行設定的 duration／解析度／比例；仍需生成驗證的重點。不要聲稱提示詞能保證逐幀時序或成功率。";

export const OFFICIAL_GUIDE_URLS = {
  base: "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md",
  ref: "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md",
} as const;

function taskLine(mode: PromptMode | null): string {
  if (mode === "t2va") return "T2VA（只有文字，沒有素材）→ 官方 Base 三欄格式：integrated_multimodal_description、overall_soundscape、non_diegetic_music；沒有對齊首行。";
  if (mode === "fl2va") {
    return `I2VA（首幀＝前一個鏡頭的最後一格或素材庫圖片，在文字編碼器中標為 <Picture 1>；沒有尾幀）→ 第一行必須是官方 I2VA 對齊句「${I2VA_ALIGNMENT_LINE}」，空一行後接 Base 三欄。`;
  }
  if (mode === "ref2va") return "Ref2VA（參考素材）→ 官方 Full-Reference 六段格式：subject_definitions → summary → retention_analysis → detailed_description → overall_soundscape → non_diegetic_music。不接受首幀／尾幀。";
  return "未知（請先依需求判斷，並說明判斷依據）。";
}

function soundtrackText(entry: ReferenceLabel): string {
  const soundtrack = entry.soundtrack;
  if (!soundtrack) return "";
  if (soundtrack.state === "used") return `；原聲會以 ${soundtrack.label ?? "<Audio n>（編號待 runtime 確認）"} 一起送入（引用影片原聲時用這個標籤）`;
  if (soundtrack.state === "off") return "；原聲已關閉";
  if (soundtrack.state === "none") return "；沒有音軌";
  return "；是否有音軌待 runtime 確認（有的話會多一個 <Audio n>）";
}

/** 改寫請求全文：指令、本機條件、素材對照、目前的 prompt。 */
export function buildRewriteRequest(input: AnalyzeInput): string {
  const mode = input.mode ?? null;
  const timing = clipTiming(input.frames);
  const plan = labelPlan(input.references, input.library);
  const lines = [
    REWRITE_INSTRUCTION,
    "",
    "---",
    "本機條件（Phasyn Studio；請依此整理，不要改動）：",
    "- 生成：本機 MiniMax H3-Base（SGLang）。prompt 原樣送進 Qwen3-VL 文字編碼器；沒有 H3-Context-IR 改寫，也沒有 negative prompt／CFG（只有一個正向條件）。",
    `- 任務：${taskLine(mode)}`,
    `- 片長：${timing ? `${describeClip(timing)}；之後鏡頭的切鏡時間必須小於 ${formatCueTime(timing.seconds)}。` : "未知（請先在 Studio 設定鏡頭的時長）。"}`,
    "- 解析度、比例與幀率由 Studio 設定（固定 24 fps），不要寫在 prompt。",
  ];
  if (plan.entries.length === 0) {
    lines.push("- 素材：無。");
  } else {
    lines.push(
      mode === "ref2va"
        ? "- 素材（依送出順序；在 prompt 裡用左邊的 @ 名稱引用，Studio 送出前會換成右邊的 H3 標籤；直接寫標籤時編號必須與此表一致）："
        : "- 素材（這個運算路由不會送出參考素材，僅供參考）：",
    );
    for (const entry of plan.entries) {
      const clip = clipText(entry.ref);
      lines.push(`  @${entry.ref.alias} → ${entry.label}：${KIND_LABEL[entry.ref.kind]}「${entry.item?.name ?? "素材庫找不到這個檔案"}」${clip ? `，片段 ${clip}` : ""}${soundtrackText(entry)}`);
    }
  }
  lines.push(
    "- 官方指南原文：",
    `  Base（T2VA／I2VA／FL2VA／L2VA）：${OFFICIAL_GUIDE_URLS.base}`,
    `  Full-Reference（Ref2VA）：${OFFICIAL_GUIDE_URLS.ref}`,
    "",
    "我的需求（目前的 prompt 原文）：",
    '"""',
    input.text.trim() || "（目前是空的）",
    '"""',
  );
  return lines.join("\n");
}
