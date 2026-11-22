// React Query key：每個伺服器資源一個 owner。
export const qk = {
  controller: () => ["controller"] as const,
  catalog: () => ["catalog"] as const,
  providers: (nodeId: string) => ["providers", nodeId] as const,
  settings: (nodeId: string, componentId: string) => ["settings", nodeId, componentId] as const,
  /** mutation key（同一個 instance 的 meta 修改／刪除）。 */
  componentMeta: (nodeId: string, componentId: string) => ["component-meta", nodeId, componentId] as const,
  componentDelete: (nodeId: string, componentId: string) => ["component-delete", nodeId, componentId] as const,
  pipelines: () => ["pipelines"] as const,
  pipeline: (pipelineId: string) => ["pipeline", pipelineId] as const,
  /** 元件組合的分類與排序（x-phasyn-extension）。 */
  pipelineLayout: () => ["pipeline-layout"] as const,
  /** mutation key＋scope（分類與排序的保存依序執行）。 */
  pipelineLayoutSave: () => ["pipeline-layout-save"] as const,
  runs: () => ["runs"] as const,
  /** The newest run (outside runs(): invalidating the lists never re-reads it, and it never invalidates itself). */
  runHead: () => ["run-head"] as const,
  runList: (limit: number, archived: "exclude" | "include" | "only" = "exclude") => ["runs", "list", limit, archived] as const,
  run: (runId: string) => ["run", runId] as const,
  /** DELETE dry-run of one run (outside the runs() prefix so list invalidation never re-sends it). */
  runPurgePlan: (runId: string) => ["run-purge-plan", runId] as const,
  /**
   * One Node's own recordings of a run (read through the Controller's forward). Outside the run() prefix: invalidating
   * the run must not query the Node again; only the user's explicit query does.
   */
  runNodeHistory: (runId: string, nodeId: string) => ["run-node-history", runId, nodeId] as const,
  /** Root of every recording query (feature keys extend it). */
  recordings: () => ["recordings"] as const,
  /** Every event page of one recording (all streams): invalidate after the recording changes. */
  recordingEvents: (recordingId: string) => ["recordings", "events", recordingId] as const,
  /** The latest load recording of a component (under recordings(), so a new recording refreshes it). */
  lastLoad: (nodeId: string, componentId: string) => ["recordings", "last-load", nodeId, componentId] as const,
  /** Root of every cost-profile query: invalidate it when new recordings may change the fits. */
  costProfilesAll: () => ["cost-profiles"] as const,
  /** Cost profiles, optionally filtered to one Node and/or component (null = all). */
  costProfiles: (nodeId: string | null = null, componentId: string | null = null) => ["cost-profiles", nodeId, componentId] as const,
  /** A duration estimate of the given inputs by one estimator (the inputs are plain JSON, so equal inputs share it). */
  durationEstimate: (estimatorId: string, inputs: unknown) => ["duration-estimate", estimatorId, inputs] as const,
  presets: () => ["presets"] as const,
  fileJson: (nodeId: string, fileId: string) => ["file-json", nodeId, fileId] as const,
  latestInvoke: (nodeId: string, componentId: string) => ["latest-invoke", nodeId, componentId] as const,
  /** A component's weight plan, file status and download job (x-phasyn-extension). */
  weights: (nodeId: string, componentId: string) => ["weights", nodeId, componentId] as const,
};

/** Polling intervals (ms): the single table every poll in the app uses. */
export const POLL = {
  catalog: 3000,
  activeRun: 2000,
  runList: 3000,
  /** The newest run only (a few KB) while nothing runs: notices runs started outside this tab (MCP, another tab). */
  runHead: 4000,
  /** Waiting for a started component to become ready. */
  componentStart: 1500,
  /** A running weight download (the Node reports the bytes it has received). */
  weightsDownload: 1000,
} as const;
