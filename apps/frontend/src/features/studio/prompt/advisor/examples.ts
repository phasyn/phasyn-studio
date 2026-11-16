// 指南範例（純資料）：原文照錄自 Phasyn Studio 作者撰寫的「MiniMax H3：怎麼寫 Prompt」指南（範例 A–D 與中文台詞短例；
// 說明），隨本專案授權公開。指南明說：範例的場景與動作由指南撰寫，欄位與標記參照
// 官方格式，全部「未經生成驗證」；秒數與切點是創作目標。介面上的名稱說它是什麼、什麼時候用（「範例：…」），
// 指南的編號與官方任務名稱放在 official（提示文字與範本預覽）。
import type { PromptMode } from "./types";
import { t } from "@/i18n";

export interface GuideExample {
  id: string;
  /** 「範例：…」：內容與片長，白話。 */
  title: string;
  mode: PromptMode;
  /** 會得到什麼、什麼時候用（一句）。 */
  note: string;
  /** 指南的範例編號、官方任務名稱與建議片長（提示文字與預覽）。 */
  official: string;
  /** 用來辨認「目前的 prompt 是這個範例」的一段原文。 */
  signature: string;
  text: string;
}

export const EXAMPLE_LABEL = t("範例");
/** 範例是什麼：預覽與「內容還是範例」的說明。 */
export const EXAMPLE_NOTE = t("範例是指南寫的，還沒有用生成結果驗證；照你的角色、素材與片長改寫後再用。");

export const GUIDE_EXAMPLES: readonly GuideExample[] = [
  {
    id: "a",
    title: t("範例：突進、格擋、錯身（一鏡 5 秒）"),
    mode: "t2va",
    note: t("一鏡到底的快節奏交鋒：一開場就在動、碰撞清楚、碰撞後立刻換位；只有動作音效，沒有配樂。"),
    official: t("指南範例 A：英文 T2VA 結構稿，建議片長約 5 秒"),
    signature: "integrated_multimodal_description: [Shot 1] 2D Japanese action animation with crisp ink outlines",
    text: "integrated_multimodal_description: [Shot 1] 2D Japanese action animation with crisp ink outlines, flat cel shading, and a cool moonlit palette. A medium-wide side view shows a red-jacketed swordswoman on the left and a silver-haired spearman in a navy coat on the right, facing each other across a ruined stone courtyard. Their full bodies and weapons are visible. The action is already underway as the shot opens: the swordswoman drives off her rear foot and races from left to right, crossing the gap within the opening second. The spearman steps diagonally backward and raises his steel spear shaft into her incoming diagonal sword strike. The weapons meet once with a brief, sharp spray of sparks. He immediately redirects the blade outward, and she follows her own momentum past his front shoulder. Both pivot on planted feet and continue moving apart into new fighting positions before the clip ends. Each movement follows directly from the previous contact, with the exchange performed at full real-time speed. Their feet strike and leave the stones rapidly, while small chips fly backward along the ground. The camera tracks laterally beside the exchange at fast speed, keeping the contact point and both silhouettes legible. Short motion smears emphasize the fastest limbs and weapon edges, while faces remain readable.\n\noverall_soundscape: Rapid footfalls scrape over loose stone, followed by one hard metallic clash and a short scattering of chips. A quick air rush follows the passing sword, and both fighters' coats snap as they pivot.\n\nnon_diegetic_music: N/A",
  },
  {
    id: "b-en",
    title: t("範例：三鏡交鋒（10 秒，英文）"),
    mode: "t2va",
    note: t("三個鏡頭的交鋒，在 3.0 與 6.5 秒切鏡：第二鏡接著前一鏡的動作，第三鏡交代兩人已經換位。"),
    official: t("指南範例 B：英文 T2VA 結構稿，建議片長約 10 秒"),
    signature: "Her horizontal sword strike meets his steel shaft in a second clear impact.",
    text: "integrated_multimodal_description: [Shot 1] 2D Japanese action animation, with crisp ink outlines, flat cel shading, and cool moonlight. A medium-wide side view establishes a ruined stone courtyard. A short-haired swordswoman in a red jacket is on the left, facing a silver-haired spearman in a navy coat on the right. The fight is already in motion when the shot opens. She drives off her rear foot and sprints toward him within the first second. He steps diagonally back and lifts the spear shaft into her diagonal slash. One brief spark burst marks the contact. The initial clash flows directly into an outward deflection as both fighters rapidly adjust their footing. The camera tracks laterally at fast speed along the same side of their action, keeping both bodies and the weapons readable. The exchange unfolds continuously at full real-time speed.\n\n[Shot 2] At 00:03.000, the camera cuts to a medium-close side view of the same ongoing exchange. The spearman presses the sword outward with his shaft. The swordswoman turns her hips, draws the blade close to her body, and darts under the raised shaft, passing him in one rapid movement. Her red jacket crosses the foreground while his navy coat turns behind her. The camera makes a short, fast lateral move with their contact point and stays on the established side of the fight. Loose stones shoot outward from her planted foot; the spear swings through the space she has just left. The motion continues directly from the first shot.\n\n[Shot 3] At 00:06.500, the camera cuts to a low-angle wide view showing their exchanged positions: the swordswoman is on the right and the spearman is on the left. Both pivot immediately and drive toward the center. Her horizontal sword strike meets his steel shaft in a second clear impact. The camera pulls back with small amplitude at fast speed as sparks scatter and the fighters rebound apart. Their silhouettes remain distinct, and their feet and weapons continue moving through the final moment. Brief motion smears follow only the fastest limb and weapon movements; the impact positions stay readable.\n\noverall_soundscape: Fast footsteps, grit, and snapping fabric follow the fighters through all three shots. Each of the two weapon contacts has a distinct metallic crack, followed by a brief air rush and small falling stones.\n\nnon_diegetic_music: N/A",
  },
  {
    id: "b-zh",
    title: t("範例：三鏡交鋒（10 秒，中文草稿）"),
    mode: "t2va",
    note: t("同一段交鋒的中文草稿：適合改成你的內容，或貼給 LLM 整理成英文結構稿。"),
    official: t("指南範例 B：中文創作稿（不是官方的分段格式），建議片長約 10 秒"),
    signature: "第三鏡，約 6.5 秒切入：低角度廣角，兩人已換位",
    text: "10 秒、16:9，日本二維手繪動漫的戰鬥 OP。清楚墨線、平塗賽璐璐陰影、冷色月光；紅外套女劍士與銀髮深藍外套槍士，在破損石造廣場交鋒。全段以即時全速連續動作推進，出招、格擋與移位緊接發生。\n\n第一鏡，開場至約 3 秒：側面中遠景，女劍士在左、槍士在右。開場女劍士已蹬地向右衝刺，第一秒內逼近；槍士斜退，抬起槍身擋下斜斬。短促火花在接觸點閃過，槍身立即把劍刃帶向外側，雙方快速調整步法。攝影機沿側面快速平行追蹤，雙方全身與武器保持可辨識。\n\n第二鏡，約 3 秒切入：中近景承接前一鏡正在進行的偏轉，槍士順勢壓開劍刃，女劍士轉髖、收劍，迅速從槍身下方穿過。攝影機保持在兩人原本的同一側，短距離跟隨接觸點；碎石沿腳下滑動方向飛散。\n\n第三鏡，約 6.5 秒切入：低角度廣角，兩人已換位，女劍士在右、槍士在左。兩人迅速轉身，再次踏地衝向中央，完成第二次清楚的武器碰撞；雙方借反作用力分開，最後仍在移動中。\n\n聲音：蹬地、衣料拍動、掠過空氣的短促破風聲；每次武器接觸對應一記乾脆金屬撞擊。保留動作音效，背景配樂留待後製。",
  },
  {
    id: "c",
    title: t("範例：從首幀開始的交鋒（5 秒）"),
    mode: "fl2va",
    note: t("需要一張相符的首幀：紅衣劍士在左、藍衣槍士在右、石造廣場；第一行是首幀對齊句。"),
    official: t("指南範例 C：I2VA，含官方的對齊首行，建議片長約 5 秒"),
    signature: "The shot opens with the exact two fighters, costumes, weapons, positions, courtyard, and camera angle established by <Picture 1>.",
    text: "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\nintegrated_multimodal_description: [Shot 1] 2D cel-shaded action animation. The shot opens with the exact two fighters, costumes, weapons, positions, courtyard, and camera angle established by <Picture 1>. The red-jacketed swordswoman on the left is already leaning into her forward step, while the navy-coated spearman on the right braces his weapon. She immediately drives off her rear foot and closes the visible gap. He shifts diagonally back and intercepts her incoming sword with the middle of the spear shaft. A short spark burst marks the collision. He deflects her blade and she follows through past his front shoulder; both turn and move into new positions before the five-second clip ends. The camera begins at the reference framing, then tracks laterally with the exchange at fast speed. Their bodies remain distinct and their movement runs continuously at full real-time speed.\n\noverall_soundscape: Fast footfalls scrape the stone, one sharp metal impact rings out, and fabric snaps as the fighters pass and turn.\n\nnon_diegetic_music: N/A",
  },
  {
    id: "d",
    title: t("範例：角色圖＋分鏡圖＋動作預演（10 秒）"),
    mode: "ref2va",
    note: t("假設有 3 張圖片和 1 段無聲的 10 秒預演影片，在 3.0 與 6.5 秒切鏡；名字、外觀與素材分工都要換成你的。"),
    official: t("指南範例 D：Ref2VA 六段全參考稿，建議片長約 10 秒"),
    signature: "<Picture 3> is the three-panel storyboard for [Shot 1], [Shot 2], and [Shot 3]",
    text: "subject_definitions:\n<Subject 1> is the red-jacketed swordswoman in <Picture 1>, providing her face, short dark hair, red jacket, dark trousers, and single steel sword.\n<Subject 2> is the silver-haired spearman in <Picture 2>, providing his face, swept-back silver hair, navy coat, dark boots, and steel spear.\n<Picture 3> is the three-panel storyboard for [Shot 1], [Shot 2], and [Shot 3], providing the courtyard layout, viewpoints, and character placement.\n<Video 1> is the silent ten-second rehearsal, providing the rapid approach, contact, pass, and second clash, together with the side-tracking camera and cuts at 3.0 and 6.5 seconds.\n\nsummary:\n[reference generation] A ten-second animated duel combines the appearances of <Subject 1> and <Subject 2> with the action timing and camera structure of <Video 1>. <Picture 3> guides the composition of three successive full-frame shots in a ruined courtyard.\n\nretention_analysis:\n<Subject 1> (appears in [Shot 1], [Shot 2], [Shot 3]): fully_preserved - retain the defined face, hair, costume, and weapon identity throughout the new actions.\n<Subject 2> (appears in [Shot 1], [Shot 2], [Shot 3]): fully_preserved - retain the defined face, hair, costume, and weapon identity throughout the new actions.\n<Picture 3> (composition of [Shot 1], [Shot 2], [Shot 3]): weak_reference - use each panel's spatial arrangement as guidance for one full-frame shot.\n<Video 1> (action timing, camera path, and cut structure): fully_preserved - follow the rehearsal's defined movement sequence and temporal structure while rendering the referenced characters.\n\ndetailed_description:\nThe target video uses crisp 2D ink outlines, flat cel shading, and cold moonlit stone textures. The visual treatment follows the character illustrations, with brief motion smears attached to rapidly moving limbs and weapon edges.\n\n[Shot 1] A medium-wide side view opens on the courtyard layout from the first panel of <Picture 3>. <Subject 1> occupies the left side, leaning into an immediate forward sprint; her short hair and red jacket remain identifiable. <Subject 2> stands on the right, facing her with the spear angled across his body, his silver hair visible above the navy collar. Following the approach timing in <Video 1>, she crosses the gap during the opening second. He steps diagonally backward and intercepts her downward diagonal slash with the middle of his shaft. The single contact produces a sharp metallic crack and a brief spray of sparks. The contact flows directly into an outward deflection as both fighters rapidly adjust their footing. The camera follows the rehearsal's fast lateral tracking path, keeping their full bodies, the floor, and the point of contact visible. Grit flies backward from their planted feet.\n\n[Shot 2] At 00:03.000, the camera cuts to a medium-close side view based on the second panel of <Picture 3>, continuing the same exchange. <Subject 2> presses the sword outward. <Subject 1> turns her hips, retracts the blade close to her ribs, and darts under the lifted shaft, matching the quick passing action in <Video 1>. The red jacket sweeps across the foreground as the navy coat rotates behind it. The camera stays on the same side of the fight and makes a short, fast lateral adjustment to follow the passing bodies. The spear cuts through the space she has just vacated, with a brief air rush. Their steps are rapid and closely spaced.\n\n[Shot 3] At 00:06.500, the camera cuts to the low wide angle of the third panel of <Picture 3>. <Subject 1> is now on the right and <Subject 2> is on the left. Following the final movement phrase of <Video 1>, they pivot, rush back toward the center, and complete a second distinct weapon clash. The camera pulls back quickly over a short distance as they rebound apart. Their clothes, weapons, and silhouettes stay distinct, and both continue moving through the final moment. The full exchange runs at the rehearsal's real-time pace, with short impact sounds and immediate reactions.\n\noverall_soundscape: Rapid footfalls, scattered grit, short air rushes, and snapping cloth follow the movements. Two separate metallic impacts mark the two weapon contacts.\n\nnon_diegetic_music: N/A",
  },
  {
    id: "dialogue",
    title: t("範例：英文畫面加中文台詞"),
    mode: "t2va",
    note: t("示範台詞標記 <d>[Chinese] …</d> 與說話者編號 (S1)；不含跨鏡頭的長台詞。"),
    official: t("指南的中文台詞短例：英文場景稿加中文原始台詞"),
    signature: "says: <d>[Chinese] 換我了。</d>",
    text: "integrated_multimodal_description: [Shot 1] 2D cel-shaded animation. In a medium close-up, a red-jacketed swordswoman with a clear, brisk voice (S1) looks toward the opponent on her left and says: <d>[Chinese] 換我了。</d> Her mouth moves visibly with the line, then closes as she steps forward and raises her sword.\n\noverall_soundscape: Her boot scrapes the stone, followed by a brief rustle of her jacket.\n\nnon_diegetic_music: N/A",
  },
];
