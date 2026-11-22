// Prompt 插件在 Video Studio 的接點：專案選用的插件貢獻（StudioProject.prompt_plugins，StudioPluginRef）在渲染前套用到
// 每個鏡頭。規則與生成設定的定義來自主控的插件登錄表，評估器在 @/features/plugins；這裡只把
// 結果換成渲染規劃使用的形狀，並補上生成設定需要的實際值（畫面、影格數、DiT 實際使用的步數與 shift、路由能力）。
// 登錄表是非同步讀到的：這些函式讀「目前」的登錄表（currentPluginRegistry）。還沒讀到、讀不到、引用找不到，或所屬的包
// 停用／不相容時一律回報問題，渲染規劃因此擋下（fail closed），從不默默略過一條限制。
// H3 沒有負向 prompt：規則只寫正向描述，擋下的寫法要使用者自己改掉。
import type { StudioProject, StudioShot, StudioTake } from "@/api/generated/contracts";
import {
  changedRevs,
  checkGeneration,
  currentPluginRegistry,
  evaluateSelection,
  findingPlace,
  generationFindingText,
  resolveSelection,
  selectionRevs,
  type GenerationActuals,
  type PluginRegistry,
} from "@/features/plugins";
import { t } from "@/i18n";
import { OFFICIAL_REFERENCE_VIDEO_SHORT_EDGE } from "../swap/limitSpec";
import { referenceVideoShortEdge } from "../swap/limits";
import { ditDefaults, type StudioRoute } from "./routes";

export type { PluginRegistry };

export interface PluginFinding {
  /** 規則的引用（內建規則就是它的 id，例如 no-fighting-game）。 */
  pluginId: string;
  /** forbid／require 項目的 id。 */
  ruleId: string;
  /** 規則的名稱（已翻譯）。 */
  label: string;
  /** 已翻譯的說明。 */
  message: string;
  /** forbid：命中的原文片段；require：null。 */
  match: string | null;
  /** 逐鏡檢查的結果在 prompt 裡的位置（[Shot 2]、<Subject 2>）；整份 prompt 的檢查為 null。 */
  place: string | null;
}

export interface PluginResult {
  /** 套用 inject 之後要送出的 prompt。 */
  prompt: string;
  findings: PluginFinding[];
  /** 不能套用的原因：登錄表讀不到、引用找不到、所屬的包停用或不相容、同組重複、生成設定的要求不符合。 */
  problems: string[];
}

/** 檢查生成設定的要求時，實際的值從哪裡來。 */
export interface PluginRenderContext {
  project: Pick<StudioProject, "format">;
  shot: Pick<StudioShot, "frames" | "steps" | "video_shift" | "audio_shift">;
  /** 鏡頭的運算路由；找不到時為 null（路由相關的要求一律不符合）。 */
  route: StudioRoute | null;
}

/** 渲染規劃時各欄位實際的值：鏡頭留空的步數與 shift 取元件組合或 DiT 元件保存的值，都沒有＝未知。 */
export function generationActuals({ project, shot, route }: PluginRenderContext): GenerationActuals {
  const dit = ditDefaults(route);
  return {
    format: { width: project.format.width, height: project.format.height },
    frames: shot.frames,
    steps: shot.steps ?? dit.steps.value,
    video_shift: shot.video_shift ?? dit.video_shift.value,
    audio_shift: shot.audio_shift ?? dit.audio_shift.value,
    route_capability: route?.capability ?? null,
    reference_video_short_edge: route && !route.generationBinding ? (referenceVideoShortEdge(route) ?? OFFICIAL_REFERENCE_VIDEO_SHORT_EDGE) : null,
  };
}

/**
 * 套用專案的插件貢獻：規則依 style、effect、constraint 的順序加進 prompt，並回報違反的規則與不能套用的原因。
 * context：渲染規劃提供鏡頭與路由，用來檢查生成設定的要求；專案選了生成設定而沒有 context 時無法檢查，回報問題。
 */
export function applyPromptPlugins(
  prompt: string,
  ids: readonly string[] | null | undefined,
  context?: PluginRenderContext,
  registry: PluginRegistry = currentPluginRegistry(),
): PluginResult {
  const selection = resolveSelection(registry, ids);
  const evaluation = evaluateSelection(selection, prompt);
  const problems = evaluation.problems.map((problem) => problem.text);
  if (context) problems.push(...checkGeneration(selection.generation, generationActuals(context)).map(generationFindingText));
  else if (selection.generation.length > 0) problems.push(t("這裡無法檢查插件生成設定的要求"));
  return {
    prompt: evaluation.prompt,
    findings: evaluation.findings.map((item) => ({ pluginId: item.ref, ruleId: item.itemId, label: item.label, message: item.message, match: item.match, place: findingPlace(item) })),
    problems,
  };
}

function findingText({ label, match, message, place }: PluginFinding): string {
  if (place === null) return match !== null ? t("{label}：「{match}」— {message}", { label, match, message }) : t("{label}：{message}", { label, message });
  return match !== null ? t("{label}（{place}）：「{match}」— {message}", { label, place, match, message }) : t("{label}（{place}）：{message}", { label, place, message });
}

/** 擋下渲染的原因，一項一句（problems 與 findings 都空＝可以渲染；要不要擋由這兩個清單決定，不由這段文字）。逐鏡的結果寫出是哪一鏡或哪個角色。 */
export function pluginBlockItems(result: PluginResult): string[] {
  return [...result.problems, ...result.findings.map(findingText)];
}

/** 同上，接成一句。 */
export function pluginBlockText(result: PluginResult): string {
  return pluginBlockItems(result).join(t("；"));
}

/**
 * take 渲染時的插件貢獻與專案目前的是否相同：引用相同（順序不計），而且 take 記下的內容版本（revs）都還是登錄表目前的。
 * 沒有 revs 的舊 take 只比對引用；登錄表還沒讀到時無法比較版本，不當成變更。
 */
export function samePlugins(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined,
  revs?: StudioTake["prompt_plugin_revs"],
  registry: PluginRegistry = currentPluginRegistry(),
): boolean {
  const left = [...new Set(a ?? [])].sort();
  const right = [...new Set(b ?? [])].sort();
  if (left.length !== right.length || !left.every((id, index) => id === right[index])) return false;
  return changedRevs(registry, revs).length === 0;
}

/** 渲染時記在 take 上的欄位：專案選用的引用與它們當時的內容版本；沒有選用時是空物件。 */
export function takePluginFields(
  ids: readonly string[] | null | undefined,
  registry: PluginRegistry = currentPluginRegistry(),
): Pick<StudioTake, "prompt_plugins" | "prompt_plugin_revs"> {
  if (!ids || ids.length === 0) return {};
  const revs = selectionRevs(registry, ids);
  return { prompt_plugins: [...ids], ...(revs ? { prompt_plugin_revs: revs } : {}) };
}
