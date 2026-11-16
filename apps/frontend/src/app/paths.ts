// The single source of in-app paths (areas: Image Studio | Video Studio | Inference | Components | Records).
// Every feature builds links with these helpers, so moving a route changes only this file. No imports (plain strings).

export const PATHS = {
  /** Image Studio（圖片生成；與 Video Studio 共用專案與素材庫）：/image?project=&shot=&take=。 */
  image: "/image",
  /** Video Studio（鏡頭、編輯、渲染）：/studio/{generate,edit,render}?project=。 */
  studio: "/studio",
  studioGenerate: "/studio/generate",
  studioEdit: "/studio/edit",
  studioRender: "/studio/render",
  /** 專案列表並把焦點放在「新增專案」（命令面板的「新增專案」）。 */
  studioNewProject: "/studio/generate?new=1",
  components: "/admin/components",
  pipelines: "/admin/pipelines",
  newPipeline: "/admin/pipelines/new",
  runs: "/records/runs",
  recordings: "/records/recordings",
  comparisons: "/records/comparisons",
  tracking: "/records/tracking",
  /** 推理 Studio 的入口：導向首頁「反推」（semantics）。 */
  inference: "/inference",
  /** 推理 Studio・反推（語意與資料集）：推理 Studio 的首頁。 */
  semantics: "/inference/semantics",
  /** 推理 Studio・圖片反推（prompt studies：?study=&tab=）。 */
  promptStudies: "/inference/prompt-studies",
  /** 推理 Studio・手動執行（選一個元件組合，上傳輸入後建立 run）：?pipeline=&run=。 */
  inferenceRun: "/inference/run",
} as const;

function withQuery(path: string, params: Record<string, string | null | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  const search = query.toString();
  return search ? `${path}?${search}` : path;
}

/** 元件頁並選取該 instance（?node=&component=）。 */
export function componentPath(nodeId: string, componentId: string): string {
  return withQuery(PATHS.components, { node: nodeId, component: componentId });
}

export function pipelinePath(pipelineId: string): string {
  return `${PATHS.pipelines}/${encodeURIComponent(pipelineId)}`;
}

export function runPath(runId: string): string {
  return `${PATHS.runs}/${encodeURIComponent(runId)}`;
}

export function recordingPath(recordingId: string, search = ""): string {
  return `${PATHS.recordings}/${encodeURIComponent(recordingId)}${search}`;
}

/** 效能紀錄列表的篩選（例如 run_id、component_id＋node_id）。 */
export function recordingsPath(params: Record<string, string | null | undefined> = {}): string {
  return withQuery(PATHS.recordings, params);
}

/** 比較頁：?ids=a,b（逗號不編碼，與既有分享連結一致）。 */
export function comparisonPath(ids: readonly string[]): string {
  return ids.length ? `${PATHS.comparisons}?ids=${ids.map(encodeURIComponent).join(",")}` : PATHS.comparisons;
}

/** 推理 Studio・手動執行（執行元件組合）：?pipeline=&run=。 */
export function inferencePath(params: { pipeline?: string | null; run?: string | null } = {}): string {
  return withQuery(PATHS.inferenceRun, { pipeline: params.pipeline, run: params.run });
}

/** 語意與資料集（?describe_run=&caption_run=&export_run=）。 */
export function semanticsPath(params: Record<string, string | null | undefined> = {}): string {
  return withQuery(PATHS.semantics, params);
}

/** Video Studio 的工作區（預設「鏡頭」：/studio/generate），可帶專案（不帶時是專案列表）。 */
export function videoStudioPath(workspace = "generate", projectId?: string | null): string {
  return withQuery(`${PATHS.studio}/${encodeURIComponent(workspace)}`, { project: projectId });
}

/** Image Studio，可帶專案（不帶時開啟最近的專案）與要選取的圖片（image_shot_id）。 */
export function imageStudioPath(projectId?: string | null, shotId?: string | null): string {
  return withQuery(PATHS.image, { project: projectId, shot: shotId });
}
