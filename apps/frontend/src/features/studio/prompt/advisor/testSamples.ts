// Prompt samples for unit tests only (imported by *.test.ts, never by app code, so they are not bundled). All synthetic:
//  - TIMELINE_SAMPLE: a 10-second Chinese draft with a document title, a style paragraph, six bold time headings and a
//    trailing "overall requirements" paragraph (the shape people paste from chat tools).
//  - REF2VA_SAMPLE: a six-section Ref2VA prompt (4 reference pictures, 243 frames = 10.125 s) whose timeline uses
//    `[Shot 1, mm:ss.mmm-mm:ss.mmm]` ranges inside one continuous shot.
import type { StudioLibraryItem, StudioReference } from "@/api/generated/contracts";
import { I2VA_ALIGNMENT_LINE } from "./templates";

export const TIMELINE_SAMPLE = "**10 秒影片 Prompt**\n\n未來都市夜景的科幻追逐動畫，2D 手繪質感，霓虹色塊上色，清楚輪廓線，高對比光影，電影級構圖，整體節奏極快，從頭到尾充滿壓迫感與速度感，像一支動畫片頭。\n\n**0.0–1.5 秒：** 雨夜的高樓屋頂，霓虹招牌在積水裡反光，鏡頭貼著屋頂快速前移，掠過水塔與天線。一名穿黃色雨衣的少年從水塔後方高速衝出，踩過積水躍向對面大樓。\n\n**1.5–3.0 秒：** 畫面快切到少年在半空中翻身，雨水從雨衣邊緣甩出成弧線，背後的城市燈光拉成一道道長條光帶。\n\n**3.0–5.0 秒：** 少年落在對面屋頂邊緣，膝蓋一彎立刻起跑，三架追蹤無人機從下方升起，紅色掃描光束在他身後的牆面交錯。\n\n**5.0–7.0 秒：** 少年衝進狹窄的通風管道，金屬牆面在兩側飛快後退，無人機緊追在後，光束打在管壁上濺出火花。\n\n**7.0–8.5 秒：** 管道盡頭忽然開闊，少年在破口邊緣停留一瞬，回頭望向逼近的無人機，雨衣下擺在強風中翻動。\n\n**8.5–10.0 秒：** 少年從高樓破口縱身躍下，張開背上的滑翔翼劃過霓虹街景，無人機在後方撞成一團火光，城市燈海在腳下無限展開。\n\n**整體要求：** 全片節奏維持快速，色彩鮮明，畫面乾淨俐落。\n角色造型前後一致，雨衣與滑翔翼的細節清楚可辨。";

export const REF2VA_SAMPLE = "subject_definitions:\n<Subject 1> is the young cyclist shown in <Picture 1>, preserving her facial identity, short curly brown hair, green windbreaker, grey cargo shorts, and yellow helmet.\n<Subject 2> is the elderly street vendor shown in <Picture 2>, preserving his facial identity, white beard, round glasses, striped apron, and wooden fruit cart, with no hat, no scarf, and no gloves.\n<Subject 3> is the small white terrier shown in <Picture 3>, preserving its fluffy coat, black nose, red collar, and short tail.\n<Subject 4> is the rainy market street shown in <Picture 4>, preserving the wet cobblestones, striped awnings, hanging paper lanterns, and narrow brick facades.\n\nsummary:\n[reference generation] A ten-second live-action scene in which <Subject 1> rides her bicycle through <Subject 4> after a summer shower, swerves around the cart of <Subject 2>, and stops when <Subject 3> darts across her path; the vendor laughs and hands her an apple while the terrier wags its tail.\n\nretention_analysis:\n<Subject 1> (appears in [Shot 1]): fully_preserved - her face, curly hair, green windbreaker, cargo shorts, and yellow helmet are retained.\n<Subject 2> (appears in [Shot 1]): fully_preserved - his face, beard, glasses, striped apron, and fruit cart are retained.\n<Subject 3> (appears in [Shot 1]): fully_preserved - its white coat, black nose, and red collar are retained.\n<Subject 4> (appears in [Shot 1]): fully_preserved - the cobblestones, awnings, lanterns, and brick facades are retained.\n\ndetailed_description:\nThe target video uses a naturalistic live-action style with soft overcast daylight, wet reflective cobblestones, and warm lantern glow spilling from the shop fronts. The light rain has just stopped, so thin mist hangs above the street and small drops still fall from the awning edges. The camera stays at street level throughout one continuous take, and the four subjects keep their reference appearances without any change of costume or color.\n\n[Shot 1, 00:00.000-00:02.000] A wide street-level view looks down <Subject 4>. <Subject 1> enters from the far end on her bicycle, pedaling at a relaxed pace between the striped awnings while puddles ripple under her tires. Her green windbreaker flutters a little at the hem, and the yellow helmet catches the lantern light. The camera tracks backward slowly at chest height to keep her in the center of the frame, with the narrow brick facades sliding past on both sides.\n\n[Shot 1, 00:02.000-00:04.200] <Subject 1> leans into a gentle curve around the wooden fruit cart of <Subject 2>, who is arranging apples on the top shelf. He glances up over his round glasses and lifts one hand in greeting, and she nods back without losing her balance. A few drops slide off the edge of the striped apron as he turns. The camera continues its slow backward track, keeping both of them and the stacked fruit in the same frame.\n\n[Shot 1, 00:04.200-00:06.800] <Subject 3> suddenly darts out from behind the cart and crosses in front of the front wheel. <Subject 1> squeezes both brakes, the bicycle stops a short distance from the terrier, and she plants one foot on the wet stones. Her body tips forward slightly and then settles back onto the saddle. The camera keeps its position as the dog sits down on the cobblestones, tilts its head, and looks up at her with its ears raised.\n\n[Shot 1, 00:06.800-00:07.900] <Subject 2> steps out from behind the cart with a warm laugh and wipes his hands on the apron, and the terrier stays seated with its tail sweeping the wet cobblestones from side to side.\n\n[Shot 1, 00:07.900-00:10.000] <Subject 2> hands <Subject 1> a red apple. She takes it, smiles, and pats <Subject 3> on the head before pushing off again with one easy stroke of the pedal. The terrier trots a few steps after the bicycle and then returns to the cart. The camera eases forward on the three of them as the paper lanterns sway in the light breeze and the street brightens behind them.\n\noverall_soundscape:\nBicycle tires hiss over wet cobblestones, a brake squeaks briefly, the terrier gives one short bark, and distant market chatter and dripping awnings fill the background.\n\nnon_diegetic_music:\nA light acoustic guitar melody with soft hand percussion at a relaxed tempo, fading out gently at the end.";

/** 測試用素材庫項目（合成資料）。 */
export function testItem(itemId: string, kind: StudioLibraryItem["kind"], options: { name?: string; hasAudio?: boolean | null; duration?: number | null } = {}): StudioLibraryItem {
  return {
    item_id: itemId,
    kind,
    name: options.name ?? `${itemId}.${kind === "image" ? "png" : kind === "video" ? "mp4" : "wav"}`,
    file: { node_id: "controller", file_id: `file-${itemId}`, size_bytes: 1, sha256: "0".repeat(64), media_type: kind === "image" ? "image/png" : kind === "video" ? "video/mp4" : "audio/wav", metadata: {} },
    created_at: "2026-10-17T00:00:00Z",
    duration_seconds: kind === "image" ? null : (options.duration ?? 5),
    width: kind === "audio" ? null : 768,
    height: kind === "audio" ? null : 768,
    has_audio: kind === "image" ? null : (options.hasAudio ?? (kind === "audio" ? true : null)),
  };
}

/** 測試用參考（alias 對應 itemId）。 */
export function testRef(alias: string, kind: StudioReference["kind"], itemId: string, extra: Partial<StudioReference> = {}): StudioReference {
  return { ref_id: `ref-${alias}`, kind, alias, item_id: itemId, start_seconds: null, end_seconds: null, ...extra };
}

/** 乾淨的 T2VA 三欄（124 幀＝5.167 秒）：不應有任何發現。 */
export const BASE_OK = [
  "integrated_multimodal_description: [Shot 1] Live-action, a medium-wide shot frames a baker opening the shutters of a small street bakery before sunrise. The camera pushes in with small amplitude at slow speed as the baker places a fresh loaf on the wooden counter. [Shot 2] At 00:03.000, the camera cuts to a close-up of steam rising from the sliced bread.",
  "overall_soundscape: Wooden shutters scrape open over a quiet street as trays clink softly inside the bakery.",
  "non_diegetic_music: A soft acoustic-guitar pattern at a moderate tempo, joined by sparse upright-bass notes.",
].join("\n\n");
export const I2VA_OK = `${I2VA_ALIGNMENT_LINE}\n\n${BASE_OK}`;
export const PAIR_LINE = "How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the 5.00-second mark of the target video.";

export const LIBRARY: StudioLibraryItem[] = [
  testItem("i1", "image"),
  testItem("i2", "image"),
  testItem("i3", "image"),
  testItem("vs", "video", { hasAudio: true }),
  testItem("vq", "video", { hasAudio: null }),
  testItem("vm", "video", { hasAudio: false }),
  testItem("a1", "audio"),
];
export const REFS: StudioReference[] = [testRef("Image1", "image", "i1"), testRef("Image2", "image", "i2")];
export const REF_OK = [
  "subject_definitions:\n<Subject 1> is the young woman in @Image1, with long dark hair and a blue cardigan.\n<Subject 2> is the coffee-shop interior in @Image2, with a brick wall and an orange sofa.",
  "summary:\n[reference generation] <Subject 1> reads a letter on the sofa inside <Subject 2>.",
  "retention_analysis:\n<Subject 1> (appears in [Shot 1]): fully_preserved - her face, hair, and cardigan are retained.\n<Subject 2> (appears in [Shot 1]): fully_preserved - the brick wall and orange sofa are retained.",
  "detailed_description:\nThe target video uses a realistic style with warm indoor lighting.\n[Shot 1] <Subject 1> sits on the sofa of <Subject 2> and unfolds a letter. The camera pushes in with small amplitude at slow speed.",
  "overall_soundscape:\nSoft indoor room tone continues throughout the scene.",
  "non_diegetic_music:\nN/A",
].join("\n\n");
