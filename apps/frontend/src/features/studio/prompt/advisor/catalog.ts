// 規則目錄（純資料）：每條規則的嚴重度、依據類別與出處。依據只分三類：
//  official＝官方文件明文（MiniMax-H3 docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md「官方 Base 指南」、
//            docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md「官方 Full-Reference 指南」、skills/h3-prompt-writing「官方 skill」、
//            MiniMax V2 OpenAPI）；已取回原文核對。
//  code＝已安裝程式的行為（deploy/runtimes 內的 SGLang minimax_h3、runtimes/h3 的 phasyn_h3.recipe.adapter、Studio 前端）。
//  guide＝製作建議，未經生成驗證。
// 文件  的規則表與這裡一一對應。
import type { Basis, Severity } from "./types";
import { t } from "@/i18n";

export interface RuleMeta {
  severity: Severity;
  basis: Basis;
  source: string;
  /** 觸發條件（一句繁中）。 */
  trigger: string;
}

const BASE = t("官方 Base 指南");
const REF = t("官方 Full-Reference 指南");

export const RULES = {
  "mode.unknown": { severity: "info", basis: "code", source: t("Studio 運算路由 capability（model/routes.ts）"), trigger: t("沒有提供任務（t2va／fl2va／ref2va）") },
  "mode.duration-unknown": { severity: "info", basis: "code", source: t("Studio 鏡頭影格數"), trigger: t("影格數未知（0）") },
  "mode.duration-range": { severity: "error", basis: "code", source: t("phasyn_h3.recipe.adapter geometry.py build_geometry（超出範圍會拒絕）；SGLang constants.py（4–15 秒）"), trigger: t("要求時長不在 4–15 秒") },

  "format.empty": { severity: "error", basis: "code", source: t("SGLang minimax_h3/presentation.py（prompt must be non-empty）"), trigger: t("prompt 是空的") },
  "format.markdown": { severity: "warning", basis: "code", source: t("SGLang minimax_h3/presentation.py（Prompt text passes through verbatim）"), trigger: t("有 Markdown 標記（粗體星號、雙底線、行首井號、反引號）") },
  "format.meta-title": { severity: "suggestion", basis: "code", source: t("SGLang minimax_h3/presentation.py（逐字送入）"), trigger: t("第一行是「10 秒影片 Prompt」這類文件標題") },
  "format.placeholder": { severity: "error", basis: "code", source: t("SGLang minimax_h3/presentation.py（逐字送入）"), trigger: t("範本留下 [TODO: …]") },
  "format.structure": { severity: "suggestion", basis: "official", source: t("{base} §2.2（T2VA／I2VA 三欄）；{ref} §1（Ref2VA 六段）；本機沒有 H3-Context-IR 改寫，prompt 原樣送進 H3（SGLang presentation.py）", { base: BASE, ref: REF }), trigger: t("沒有使用任務對應的官方欄位格式") },
  "format.missing-section": { severity: "warning", basis: "official", source: t("{base} §2.2；{ref} §1", { base: BASE, ref: REF }), trigger: t("已使用官方格式但缺少欄位") },
  "format.ref-main-field": { severity: "warning", basis: "official", source: `${REF} §5.2`, trigger: t("Ref2VA 使用了 integrated_multimodal_description") },
  "format.ref-sections-in-base": { severity: "warning", basis: "official", source: t("{base} §2.2；{ref} §5.2", { base: BASE, ref: REF }), trigger: t("t2va／fl2va 使用了 Ref2VA 專用段落") },
  "format.section-order": { severity: "warning", basis: "official", source: t("{base} §2.2；{ref} §1；官方 skill", { base: BASE, ref: REF }), trigger: t("欄位順序與官方不同") },
  "format.section-duplicate": { severity: "warning", basis: "official", source: `${REF} §1`, trigger: t("同一個欄位出現多次") },
  "format.section-empty": { severity: "warning", basis: "official", source: `${BASE} §2.2`, trigger: t("欄位沒有內容") },
  "format.field-name": { severity: "suggestion", basis: "official", source: t("官方 skill（Preserve the exact field names）"), trigger: t("欄位名稱大小寫與官方不同") },
  "format.i2va-line-missing": { severity: "suggestion", basis: "official", source: t("{base} §2.1（I2VA）", { base: BASE }), trigger: t("有首幀的鏡頭沒有 I2VA 對齊首行") },
  "format.i2va-line-position": { severity: "warning", basis: "official", source: t("{base} §2.1（must be the first line … one blank line）", { base: BASE }), trigger: t("對齊句不是第一行或後面沒有空行") },
  "format.alignment-line-mode": { severity: "warning", basis: "code", source: t("phasyn_h3.recipe.adapter materials.py TASK_POLICIES；Studio 首幀接續只提供首幀"), trigger: t("對齊句與任務不符（t2va／ref2va，或需要尾幀的 FL2VA／L2VA 句）") },
  "format.negative-prompt": { severity: "warning", basis: "code", source: t("SGLang constants.py MINIMAX_H3_DEFAULT_BRANCHES（單一正向分支 cond_1）；Diffusers MiniMax-H3 文件（no negative_prompt／guidance_scale）"), trigger: t("prompt 裡寫了 Negative prompt：…") },
  "format.example": { severity: "info", basis: "guide", source: t("Phasyn Studio 的 H3 Prompt 指南範例"), trigger: t("內容是指南的範例 prompt") },

  "timeline.user-headings": { severity: "suggestion", basis: "official", source: t("{base} §4.2；{ref} §5.1；同一鏡頭內的時段寫法 [Shot 1, 00:00.000-00:01.500] 見官方加速 LoRA 範例 predict_ref2v.py（MiniMax 指南沒有記載）", { base: BASE, ref: REF }), trigger: t("用「**0.0–1.5 秒：**」這類自訂時間標題") },
  "timeline.mixed-markers": { severity: "warning", basis: "official", source: `${BASE} §4.2`, trigger: t("自訂時間標題與 [Shot n] 混用") },
  "timeline.first-shot-time": { severity: "warning", basis: "official", source: t("{base} §4.2（Do not add a timestamp to the first shot）", { base: BASE }), trigger: t("第一個 [Shot] 帶 At 時間戳") },
  "timeline.shot-number": { severity: "warning", basis: "official", source: t("{base} §4.2（sequential shot numbers）", { base: BASE }), trigger: t("鏡頭編號不是 1、2、3… 連號") },
  "timeline.missing-time": { severity: "warning", basis: "official", source: `${BASE} §4.2`, trigger: t("後續鏡頭沒有 At mm:ss.sss 切鏡時間") },
  "timeline.time-format": { severity: "suggestion", basis: "official", source: t("{ref} §5.1（MM:SS.mmm）", { ref: REF }), trigger: t("時間戳不是 MM:SS.mmm") },
  "timeline.order": { severity: "error", basis: "official", source: t("{base} §4.2（strictly increasing）", { base: BASE }), trigger: t("切鏡時間沒有嚴格遞增") },
  "timeline.beyond-clip": { severity: "error", basis: "official", source: t("{base} §4.2（falls within the video duration）；實際片長＝影格數往上對齊到 17n+5 後 ÷ 24 fps（SGLang time_request.py）", { base: BASE }), trigger: t("時間戳超出實際片長") },
  "timeline.heading-beyond-clip": { severity: "warning", basis: "code", source: t("SGLang time_request.py；phasyn_h3.recipe.adapter geometry.py（17n+5 對齊）"), trigger: t("自訂時間標題超出實際片長") },
  "timeline.ends-early": { severity: "info", basis: "official", source: t("官方 skill（match the total duration of the description to the requested video length）"), trigger: t("時間軸描述比片長短 1 秒以上") },
  "timeline.duration-claim": { severity: "warning", basis: "official", source: t("官方 skill（match the total duration）；17n+5 對齊"), trigger: t("文字寫的秒數與實際片長不符") },
  "timeline.cuts-in-segment": { severity: "suggestion", basis: "official", source: t("{base} §4.2（每次切鏡是新的 [Shot n]）", { base: BASE }), trigger: t("一個時間段內描述多次切換畫面") },
  "timeline.trailing-text": { severity: "suggestion", basis: "official", source: t("{base} §4.1（風格寫在 [Shot 1] 開頭）；{ref} §5.2（風格開場在 [Shot 1] 之前）", { base: BASE, ref: REF }), trigger: t("時間軸最後一段之後還有整體說明") },

  "ref.unknown-mention": { severity: "error", basis: "code", source: t("Studio compilePrompt（找不到的 @ 名稱會擋下渲染）"), trigger: t("@ 名稱沒有對應的參考素材") },
  "ref.mention-case": { severity: "warning", basis: "code", source: t("Studio compilePrompt（@ 名稱區分大小寫）"), trigger: t("@ 名稱大小寫不符") },
  "ref.mention-unsupported": { severity: "error", basis: "code", source: t("Studio renderPlan.ts（非 ref2va 元件組合不接受參考素材）"), trigger: t("t2va／fl2va 鏡頭用了 @ 參考") },
  "ref.label-range": { severity: "error", basis: "code", source: t("SGLang presentation.py；phasyn_h3.recipe.adapter materials.py（同類素材依序編號）"), trigger: t("直接寫的 <Picture n> 等標籤超過送出的素材數") },
  "ref.labels-in-base": { severity: "warning", basis: "official", source: t("{ref} §5.2（T2VA 不使用參考標籤）；phasyn_h3.recipe.adapter TASK_POLICIES", { ref: REF }), trigger: t("t2va／fl2va 使用 <Subject n>、<Video n> 等參考標籤") },
  "ref.route-mismatch": { severity: "warning", basis: "code", source: t("phasyn_h3.recipe.adapter TASK_POLICIES；MiniMax V2 API（首尾幀與參考素材互斥）"), trigger: t("非 ref2va 鏡頭掛了參考素材") },
  "ref.limits": { severity: "error", basis: "code", source: t("phasyn_h3.recipe.adapter materials.py TASK_POLICIES（圖片 ≤ 9、影片 ≤ 3、聲音 ≤ 3、合計 1–12，拒絕只有聲音的請求）；Diffusers MiniMax-H3 文件（an audio reference has to be paired with at least one image or video reference）"), trigger: t("ref2va 素材數量超限、沒有素材或只有聲音") },
  "ref.unused": { severity: "warning", basis: "official", source: t("{ref} §2（每份參考素材先定義用途）", { ref: REF }), trigger: t("參考素材會送出但 prompt 沒有提到") },
  "ref.undefined": { severity: "suggestion", basis: "official", source: t("{ref} §2、§2.2", { ref: REF }), trigger: t("參考素材沒有在 subject_definitions 定義") },
  "ref.subject-undefined": { severity: "warning", basis: "official", source: t("{ref} §2（標籤在各段保持同一意義）", { ref: REF }), trigger: t("<Subject n> 沒有在 subject_definitions 定義") },
  "ref.retention-missing": { severity: "suggestion", basis: "official", source: t("{ref} §4（每個標籤一行）", { ref: REF }), trigger: t("定義過的標籤沒有 retention_analysis") },
  "ref.retention-format": { severity: "warning", basis: "official", source: t("{ref} §4.1、§4.2、§5.4", { ref: REF }), trigger: t("保留關係標記不是官方固定值，或寫了 (Sx)") },
  "ref.summary-prefix": { severity: "suggestion", basis: "official", source: `${REF} §3`, trigger: t("summary 沒有 [任務類型] 開頭或類型不在官方清單") },
  "ref.soundtrack": { severity: "info", basis: "code", source: t("phasyn_h3.recipe.adapter materials.py normalize_materials；SGLang stages/text_encoding.py；{ref} §2.5（<Video N> 與 <Audio N> 各自編號）", { ref: REF }), trigger: t("參考影片的原聲會成為一個 <Audio n>") },
  "ref.soundtrack-uncertain": { severity: "warning", basis: "code", source: t("phasyn_h3.recipe.adapter materials.py（ordinal_depends_on_probe）"), trigger: t("引用的 <Audio n> 編號要等 runtime probe 才確定") },

  "shot.subject-missing": {
    severity: "warning",
    basis: "code",
    source: t("Phasyn Studio：角色段列了、這一段卻沒有的角色仍會被畫出"),
    trigger: t("subject_definitions 定義的角色沒有出現在任何 [Shot N] 行"),
  },
  "shot.viewpoint": {
    severity: "suggestion",
    basis: "code",
    source: t("Phasyn Studio：原片是背影、鏡頭行卻寫側面時，新角色可能照抄原片那一鏡"),
    trigger: t("[Shot N] 行點名了 <Subject N> 卻沒寫視角"),
  },
  "shot.negation": {
    severity: "warning",
    basis: "code",
    source: t("Phasyn Studio：鏡頭行的否定詞可能反而被畫出來（例如 no wings 畫出翅膀）；SGLang stages/text_encoding.py（只有一個正向分支）"),
    trigger: t("[Shot N] 行裡有 no、not、without、never、none 等否定詞（台詞不算）"),
  },

  "length.api-limit": { severity: "info", basis: "official", source: t("MiniMax V2 OpenAPI（每個 text ≤ 7000 characters）"), trigger: t("超過 7000 字元") },
  "length.studio-limit": { severity: "error", basis: "code", source: "contracts StudioShot.prompt maxLength 16384", trigger: t("超過 16384 字元") },
  "length.detailed-words": { severity: "suggestion", basis: "official", source: t("{ref} §5.2（350–500 English words）", { ref: REF }), trigger: t("detailed_description 英文字數不在 350–500") },
  "length.short": { severity: "suggestion", basis: "guide", source: t("指南「每一鏡回答這六個問題」"), trigger: t("描述很短") },

  "sound.none": { severity: "suggestion", basis: "guide", source: t("指南「出片不對時：不想要的配樂／人聲」"), trigger: t("完全沒有描述聲音") },
  "sound.soundscape-na": { severity: "warning", basis: "official", source: t("{base} §4.6（N/A only when … complete silence）", { base: BASE }), trigger: t("overall_soundscape 是 N/A 但沒有要求全片靜音") },
  "sound.music-na-conflict": { severity: "warning", basis: "official", source: `${BASE} §4.7`, trigger: t("non_diegetic_music 是 N/A 但正文提到背景音樂") },
  "sound.music-in-soundscape": { severity: "suggestion", basis: "official", source: t("{base} §4.6、§4.7", { base: BASE }), trigger: t("overall_soundscape 描述了背景音樂") },
  "sound.dialogue-in-sound": { severity: "warning", basis: "official", source: t("{base} §4.6；{ref} §6", { base: BASE, ref: REF }), trigger: t("聲音欄位裡有 <d> 台詞") },
  "sound.music-mood": { severity: "suggestion", basis: "official", source: t("{base} §4.7（do not use abstract mood words）", { base: BASE }), trigger: t("配樂只有情緒詞、沒有樂器與節奏") },
  "sound.sentences": { severity: "suggestion", basis: "official", source: t("{base} §4.6（1–4 句）、§4.7（1–3 句）", { base: BASE }), trigger: t("聲音欄位句數超過官方建議") },

  "dialogue.unclosed": { severity: "error", basis: "official", source: `${BASE} §4.4`, trigger: t("<d> 與 </d> 沒有成對") },
  "dialogue.language-tag": { severity: "warning", basis: "official", source: t("{base} §4.4（only the language tag and the spoken content）", { base: BASE }), trigger: t("<d> 內沒有 [語言] 標籤") },
  "dialogue.speaker-id": { severity: "suggestion", basis: "official", source: `${BASE} §4.4`, trigger: t("有台詞但沒有 (S1) 說話者編號") },
  "dialogue.unmarked": { severity: "suggestion", basis: "official", source: `${BASE} §4.4`, trigger: t("台詞寫在引號裡而不是 <d>…</d>") },
  "text.onscreen-quotes": { severity: "suggestion", basis: "official", source: `${BASE} §4.5`, trigger: t("畫面文字沒有用英文雙引號") },

  "wording.vague-quality": { severity: "suggestion", basis: "official", source: t("官方 skill（Prefer concrete visual and audio details over abstract words）"), trigger: t("史詩級、電影感、masterpiece 等抽象品質詞") },
  "wording.abstract-feeling": { severity: "suggestion", basis: "guide", source: t("指南「寫作方法：把意圖變成可觀察事件」"), trigger: t("壓迫感、衝擊力等無法從畫面驗收的感受詞") },
  "wording.spec-terms": { severity: "info", basis: "code", source: t("SGLang constants.py MINIMAX_H3_SUPPORTED_FPS（固定 24 fps）；Studio 專案的畫面格式（官方驗證過的短邊是 768）"), trigger: t("8K、4K、120 FPS 等輸出規格字") },
  "wording.speed-generic": { severity: "suggestion", basis: "guide", source: t("指南「高速戰鬥：分開控制三種節奏」"), trigger: t("速度主要寫成形容詞") },
  "wording.speed-camera-only": { severity: "suggestion", basis: "guide", source: t("指南「出片不對時：相機很快，人物不快」"), trigger: t("只寫了鏡頭快，沒寫人物怎麼快") },
  "wording.tempo-conflict": { severity: "suggestion", basis: "guide", source: t("指南「容易把節奏拉慢的需求組合」"), trigger: t("同時要求高速與慢動作／停留／定格") },
  "wording.bracket-camera": { severity: "suggestion", basis: "official", source: t("{base} §4.3（natural English action within the shot）；MiniMax 的通用 API 指南仍舉 [pan] 這類寫法（未取回原文核對）", { base: BASE }), trigger: t("[pan left] 這類括號運鏡指令") },
  "wording.multi-camera": { severity: "suggestion", basis: "guide", source: t("指南「一鏡先用一種主要運鏡」"), trigger: t("同一鏡頭有 3 種以上運鏡") },
  "wording.chinese-only": { severity: "suggestion", basis: "official", source: t("{ref}（Write all six rewrite sections in English）；官方 skill", { ref: REF }), trigger: t("整份 prompt 主要是中文") },
  "wording.negation": { severity: "info", basis: "code", source: t("SGLang stages/text_encoding.py（every task emits exactly one positive embedding payload）；Diffusers MiniMax-H3 文件（no negative_prompt／guidance_scale）；官方加速 LoRA 範例在正文直接寫 No blood, …；ComfyUI 維護者提醒點名不想要的東西可能反而讓它出現（未驗證）"), trigger: t("「不要…」「avoid …」「No …, …」等否定寫法") },
} as const satisfies Record<string, RuleMeta>;

export type RuleId = keyof typeof RULES;

export const RULE_IDS = Object.keys(RULES) as RuleId[];
