// Command palette items: the item model and the builders that turn live data (catalog, pipelines, runs, projects) and
// the static page list into items. Pure; no DOM or network.
import { componentEntries } from "@/api/catalog";
import type { Catalog, StudioProjectSummary } from "@/api/generated/contracts";
import type { WirePipeline, WireRun } from "@/api/types";
import { componentPath, PATHS, pipelinePath, runPath, videoStudioPath } from "@/app/paths";
import { statusSpec } from "@/components/common/statusSpec";
import { providerKind } from "@/components/workbench/kinds";
import { hasTranslation, LOCALE_NAMES, LOCALES, t, type Locale } from "@/i18n";
import { shortId } from "@/lib/format";

// ── 項目模型 ──────────────────────────────────────────────────────────────

/** 實體種類（決定圖示）；「最近開啟」的項目保留原本的種類。 */
export type CommandKind = "page" | "component" | "pipeline" | "run" | "project" | "action";
export type CommandGroup = CommandKind | "recent";

export interface CommandMeta {
  /** 元件的 provider_id（圖示與類型色由 providerKind 決定）。 */
  providerId?: string;
  /** 右側狀態 chip。 */
  status?: { kind: "component" | "run"; value: string };
  /** 右側時間（run 建立時間、專案更新時間）。 */
  time?: { iso: string; label: string };
  /** 元件所在 Node 不在線時的 directory 狀態（元件狀態可能過時）。 */
  nodeState?: string;
}

export interface CommandItem {
  /** 面板內唯一（`群組:識別`）。 */
  id: string;
  group: CommandGroup;
  kind: CommandKind;
  title: string;
  subtitle?: string;
  /** 使用者會直接輸入的識別字：component_id、pipeline_id、run_id、project_id 或頁面路徑。 */
  ident: string;
  keywords: string[];
  /** router 路徑（含 query）；動作項目沒有目的地（空字串）。 */
  to: string;
  meta?: CommandMeta;
  /** 動作（不導覽）：目前只有切換介面語言。 */
  action?: { type: "locale"; locale: Locale };
}

/** 同分時的群組順序，也是空查詢時的區段順序。 */
export const GROUP_ORDER: readonly CommandGroup[] = ["recent", "page", "component", "pipeline", "run", "project", "action"];

export const GROUP_LABELS: Record<CommandGroup, string> = {
  recent: t("最近開啟"),
  page: t("頁面"),
  component: t("元件"),
  pipeline: t("元件組合"),
  run: t("執行紀錄"),
  project: t("專案"),
  action: t("動作"),
};

// ── 由真實資料建立項目 ────────────────────────────────────────────────────

interface PageSpec {
  path: string;
  title: string;
  keywords: readonly string[];
  /** 識別字（預設由路徑產生）。 */
  ident?: string;
  /**
   * A Video Studio workspace: with a project open on the current page the item opens that project there; without one
   * it opens the workspace's project list, where choosing a project continues to the workspace.
   */
  workspace?: "generate" | "edit" | "render";
}

/** 依工作區排列：Image Studio｜Video Studio｜推理 Studio｜元件修改｜紀錄（與 app bar 相同順序）。 */
const PAGES: readonly PageSpec[] = [
  {
    path: PATHS.image,
    title: "Image Studio",
    keywords: ["image", "image studio", "generate", "t2i", "i2i", "qwen-image", "圖片", "生成圖片", "文生圖", "圖生圖", "遮罩", "角色圖"],
  },
  {
    path: PATHS.studioGenerate,
    title: t("Video Studio・鏡頭"),
    keywords: ["studio", "video", "generate", "shot", "prompt", "take", "影片", "鏡頭", "生成", "專案列表"],
    workspace: "generate",
  },
  {
    path: PATHS.studioEdit,
    title: t("Video Studio・編輯"),
    keywords: ["studio", "video", "edit", "timeline", "transition", "fade", "speed", "volume", "color", "text", "影片", "時間軸", "剪輯", "效果", "轉場", "淡入淡出", "速度", "音量", "色彩", "文字", "字幕"],
    workspace: "edit",
  },
  {
    path: PATHS.studioRender,
    title: t("Video Studio・渲染"),
    keywords: ["studio", "video", "render", "queue", "export", "影片", "佇列", "輸出", "匯出"],
    workspace: "render",
  },
  {
    path: PATHS.studioNewProject,
    title: t("新增專案"),
    keywords: ["studio", "new project", "create project", "新增專案", "建立專案", "專案", "Video Studio", "Image Studio"],
    ident: "studio/new",
  },
  {
    path: PATHS.semantics,
    title: t("推理 Studio・反推（語意與資料集）"),
    keywords: ["inference", "semantics", "dataset", "caption", "scene", "describe", "推理", "反推", "影片反推", "語意", "資料集"],
  },
  {
    path: PATHS.promptStudies,
    title: t("推理 Studio・圖片反推"),
    keywords: ["inference", "prompt", "study", "image", "vision", "scene", "推理", "圖片反推", "反推", "場景", "搜尋"],
  },
  {
    path: PATHS.inferenceRun,
    title: t("推理 Studio・手動執行"),
    keywords: ["inference", "execute", "pipeline", "upload", "materials", "推理", "執行元件組合", "上傳", "參考素材"],
  },
  { path: PATHS.components, title: t("元件"), keywords: ["components", "component", "instance", "node", "元件修改", "管理"] },
  { path: PATHS.pipelines, title: t("元件組合"), keywords: ["pipelines", "pipeline", "dag", "graph", "步驟", "接線", "元件修改", "管理"] },
  { path: PATHS.runs, title: t("執行紀錄"), keywords: ["runs", "run", "history", "紀錄"] },
  { path: PATHS.recordings, title: t("效能紀錄"), keywords: ["recordings", "recording", "metrics", "events", "指標", "事件", "紀錄"] },
  { path: PATHS.comparisons, title: t("比較"), keywords: ["comparisons", "compare", "diff", "差異", "紀錄"] },
  { path: PATHS.tracking, title: t("追蹤設定"), keywords: ["tracking", "recorder", "trace", "sampling", "取樣", "紀錄"] },
];

/** 識別字＝去掉工作區前綴的路由段（components、runs、semantics、studio/edit；/image＝image），完整路徑放副標題。 */
function pageIdent(path: string): string {
  return path.replace(/^\/(admin|records|inference)\//, "").replace(/^\//, "");
}

/**
 * The pages of the five areas. `openProject` (see navigation.openProjectOf) makes the Video Studio pages open that
 * project; without it they open the project list of their workspace.
 */
export function pageItems(openProject: string | null = null): CommandItem[] {
  return PAGES.map((page) => ({
    id: `page:${page.path}`,
    group: "page",
    kind: "page",
    title: page.title,
    subtitle: page.path,
    ident: page.ident ?? pageIdent(page.path),
    keywords: [...page.keywords],
    to: page.workspace && (openProject != null && openProject !== "") ? videoStudioPath(page.workspace, openProject) : page.path,
  }));
}

/** 靜態頁面（沒有開啟中的專案時）。 */
export const PAGE_ITEMS: readonly CommandItem[] = pageItems();

/**
 * 動作：切換介面語言（每個其他語言一項）。選了會存偏好並重新載入；語言名稱以該語言自稱顯示。
 * 關鍵字刻意包含三種語言的說法（不翻譯），在任何介面語言下都找得到。
 */
export function localeActionItems(current: Locale): CommandItem[] {
  return LOCALES.filter((locale) => locale !== current).map((locale) => ({
    id: `action:locale:${locale}`,
    group: "action",
    kind: "action",
    title: t("切換語言：{language}", { language: LOCALE_NAMES[locale] }),
    subtitle: t("切換後會重新載入頁面"),
    ident: locale,
    // i18n-ignore-start
    keywords: ["language", "lang", "locale", "i18n", "語言", "切換語言", "介面語言", "言語", "表示言語", LOCALE_NAMES[locale]],
    // i18n-ignore-end
    to: "",
    action: { type: "locale", locale },
  }));
}

/** 關鍵字＝原文＋目前語言的譯文（譯文與原文相同時不重複）：任何介面語言下都能用原文或譯文搜尋。 */
export function keywordVariants(keywords: readonly string[]): string[] {
  const out: string[] = [];
  for (const keyword of keywords) {
    // 只查有條目的關鍵字（英文識別字本來就不翻，不用每個都查、也不產生缺譯警告）
    for (const variant of [keyword, hasTranslation(keyword) ? t(keyword) : keyword]) if (variant && !out.includes(variant)) out.push(variant);
  }
  return out;
}

function compact(values: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const text = value?.trim();
    if ((text != null && text !== "") && !out.includes(text)) out.push(text);
  }
  return out;
}

/** 目錄中所有元件（含離線 Node 的最後快照；以 nodeState 標示過時）。 */
export function componentItems(catalog: Catalog | undefined): CommandItem[] {
  return componentEntries(catalog).map(({ descriptor, node }) => {
    // 未知 provider 的通用類型名「元件」不當關鍵字（否則搜尋「元件」會把它們全部當成完全相符）。
    const kindLabel = providerKind(descriptor.provider_id).label;
    return {
      id: `component:${node.node_id}:${descriptor.component_id}`,
      group: "component",
      kind: "component",
      title: (descriptor.label || "").trim() || descriptor.component_id,
      subtitle: `${descriptor.component_id} · ${node.label}`,
      ident: descriptor.component_id,
      keywords: compact([
        descriptor.provider_id,
        kindLabel === GROUP_LABELS.component ? null : kindLabel,
        node.label,
        node.node_id,
        descriptor.runtime_id,
        descriptor.device.id,
        descriptor.state,
        statusSpec("component", descriptor.state).label,
      ]),
      to: componentPath(node.node_id, descriptor.component_id),
      meta: {
        providerId: descriptor.provider_id,
        status: { kind: "component", value: descriptor.state },
        ...(node.stale ? { nodeState: node.liveness } : {}),
      },
    };
  });
}

export function pipelineItems(pipelines: readonly WirePipeline[] | undefined): CommandItem[] {
  return (pipelines ?? []).map((pipeline) => ({
    id: `pipeline:${pipeline.pipeline_id}`,
    group: "pipeline",
    kind: "pipeline",
    title: (pipeline.label || "").trim() || pipeline.pipeline_id,
    subtitle: t("{pipeline_id} · {stepsCount} 個步驟", { pipeline_id: pipeline.pipeline_id, stepsCount: pipeline.steps.length }),
    ident: pipeline.pipeline_id,
    keywords: compact(pipeline.steps.flatMap((step) => [step.step_id, step.component_id])),
    to: pipelinePath(pipeline.pipeline_id),
  }));
}

/** run 列表第一頁（新到舊）；沒有 label 時以 run_id 前 8 碼為標題。 */
export function runItems(runs: readonly WireRun[] | undefined): CommandItem[] {
  return (runs ?? []).map((run) => {
    const label = run.request.label?.trim() ?? "";
    const pipelineId = run.request.pipeline.pipeline_id;
    return {
      id: `run:${run.run_id}`,
      group: "run",
      kind: "run",
      title: label || shortId(run.run_id),
      subtitle: label ? `${shortId(run.run_id)} · ${pipelineId}` : pipelineId,
      ident: run.run_id,
      // pipeline 的長 label（TE → DiT → VAE…）不當關鍵字：會讓大量 run 因 pipeline 描述而相符。
      keywords: compact([pipelineId, run.state, statusSpec("run", run.state).label]),
      to: runPath(run.run_id),
      meta: { status: { kind: "run", value: run.state }, time: { iso: run.created_at, label: t("建立") } },
    };
  });
}

export function projectItems(projects: readonly StudioProjectSummary[] | undefined): CommandItem[] {
  return (projects ?? []).map((project) => ({
    id: `project:${project.project_id}`,
    group: "project",
    kind: "project",
    title: (project.title || "").trim() || project.project_id,
    subtitle: t("{project_id} · {shot_count} 個鏡頭・已渲染 {rendered_shot_count}", { project_id: project.project_id, shot_count: project.shot_count, rendered_shot_count: project.rendered_shot_count }),
    ident: project.project_id,
    keywords: [],
    to: `/studio/generate?project=${encodeURIComponent(project.project_id)}`,
    meta: { time: { iso: project.updated_at, label: t("更新") } },
  }));
}
