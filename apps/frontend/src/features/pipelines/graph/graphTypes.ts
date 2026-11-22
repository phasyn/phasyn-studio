// 節點圖（pipeline DAG）的共用型別與幾何常數：graphModel（資料）→ graphLayout（座標）→ PipelineGraph（畫面）。
// 元件卡的每一列高度都寫死在這裡，版面計算與 DOM 用同一組數字，接點座標才會對齊連線端點。
// 流程輸出（pipeline outputs）不是節點：以徽章標在產生它的步驟輸出接點上（「↗ final」）。
import type { StepState, WirePipeline, WireRun } from "@/api/types";
import type { Tone } from "@/components/workbench/tones";
import type { DescriptorLookup, PipelineIssue } from "../pipelineModel";

/** 圖上的節點：pipeline 輸入與步驟。 */
export type GraphNodeKind = "input" | "step";

/** 選取：輸入節點、步驟節點，或流程輸出（接點上的徽章；id＝輸出名稱）。 */
export interface GraphSelection { kind: GraphNodeKind | "output"; id: string }

/** Node（主機）顯示名稱；不知道時回傳 null（畫面改用縮寫的 node_id）。 */
export type NodeLabelLookup = (nodeId: string) => string | null;

export interface PipelineGraphProps {
  pipeline: WirePipeline;
  lookup: DescriptorLookup;
  /** run 模式：節點顯示步驟狀態與實測時間。 */
  run?: WireRun | null;
  /** 接線檢查結果：步驟節點顯示錯誤／警告數，接點顯示問題標記。 */
  issues?: readonly PipelineIssue[];
  selection: GraphSelection | null;
  onSelect: (next: GraphSelection | null) => void;
  /** 畫布區域的 aria-label。 */
  label: string;
  className?: string;
  /** 選填：Node 顯示名稱（例如 `(id) => nodeLabel(catalog.data, id)`）；未提供時副標只顯示 component_id。 */
  nodeLabel?: NodeLabelLookup;
}

export interface IssueCount {
  errors: number;
  warnings: number;
  /** 依出現順序的訊息（tooltip 與 aria 用）。 */
  messages: string[];
}

/** 標在步驟輸出接點上的流程輸出。 */
export interface GraphExport {
  /** pipeline 輸出名稱（outputs 的鍵）。 */
  name: string;
  /** run 模式：yes＝run 輸出已有此鍵；pending＝run 進行中尚未產生；no＝run 已結束仍沒有。非 run 模式＝null。 */
  produced: "yes" | "pending" | "no" | null;
}

export interface GraphPort {
  name: string;
  /** 顯示文字：步驟接點＝名稱；輸入／輸出節點＝type_id。 */
  label: string;
  side: "in" | "out";
  /** 未知（元件不在目錄、上游型別不明）＝null。 */
  typeId: string | null;
  tone: Tone;
  required: boolean;
  /** 有接線（輸入：from_input／from_step；輸出：有下游或 pipeline 輸出）。 */
  connected: boolean;
  /** 常值綁定：不畫連線，在接點上標「常數」。 */
  literal: { typeId: string; file: boolean } | null;
  /** 元件描述沒有這個接點，但接線引用了它（PORT_MISMATCH）。 */
  missing: boolean;
  /** 接線指向不存在的來源（pipeline 輸入或步驟不存在）。 */
  danglingSource: string | null;
  issues: IssueCount;
  description: string | null;
  /** 只對步驟輸出接點：這個接點被宣告為哪些流程輸出（依宣告順序）。 */
  exports: GraphExport[];
}

export interface StepRunInfo {
  /** run.steps 沒有這一步的紀錄＝"unknown"。 */
  state: StepState | "unknown";
  startedAt: string | null;
  finishedAt: string | null;
  /** finished_at − started_at；任一缺漏或順序異常＝null（絕不以 0 代替）。 */
  durationMs: number | null;
  /** durationMs 為 null 的原因（繁中）。 */
  durationReason: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  remoteOutcomeUnknown: boolean;
}

export interface GraphNode {
  /** `${kind}:${id}`：同一張圖內唯一。 */
  key: string;
  kind: GraphNodeKind;
  id: string;
  title: string;
  subtitle: string | null;
  /** 類型色（步驟依 provider kind；輸入／輸出依資料型別）。 */
  tone: Tone;
  providerId: string | null;
  kindLabel: string;
  componentId: string | null;
  componentLabel: string | null;
  nodeId: string | null;
  nodeLabel: string | null;
  /** 步驟的元件不在目錄（未知元件：已刪除、Node 離線或尚未選擇）：接點由接線推得。 */
  unknownComponent: boolean;
  /** 步驟在接線循環中（CYCLIC_PIPELINE）：版面放在最後一層並標示。 */
  cyclic: boolean;
  /** pipeline 輸入是否必填（只對輸入節點有意義）。 */
  required: boolean;
  inputs: GraphPort[];
  outputs: GraphPort[];
  /** 步驟節點的 run 資訊（只在 run 模式）。 */
  run: StepRunInfo | null;
  issues: IssueCount;
  /** 穩定排序：輸入依宣告順序、步驟依拓撲順序（有循環時依宣告順序）。 */
  order: number;
}

export interface GraphEndpoint {
  node: string;
  port: string;
}

export interface GraphEdge {
  key: string;
  from: GraphEndpoint;
  to: GraphEndpoint;
  typeId: string | null;
  tone: Tone;
  kind: "input" | "step";
  /** 兩端型別都已知且不同（伺服器會以 PORT_MISMATCH 拒絕）。 */
  mismatch: boolean;
}

export interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** pipelineModel.topoOrder 找到的循環路徑（a → b → a）。 */
  cycle: string[] | null;
  runMode: boolean;
  /** 來源步驟不存在的流程輸出（無法標在任何接點上；驗證清單另有錯誤）。 */
  danglingExports: string[];
}

export interface Point {
  x: number;
  y: number;
}

export interface NodeBox {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
  /** 在該層內的順序（0 起算，由上而下）。 */
  rank: number;
  metaRows: number;
  portRows: number;
}

export interface EdgePath {
  key: string;
  d: string;
  from: Point;
  to: Point;
  /** 目標在來源左側或同欄（循環造成的回頭線）。 */
  backward: boolean;
}

/** 流程輸出徽章的位置（接點右側、連線起點上；寬度是上限，實際依文字）。 */
export interface ExportBox {
  key: string;
  nodeKey: string;
  port: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GraphLayout {
  boxes: Map<string, NodeBox>;
  /** 流程輸出徽章（每個有流程輸出的接點一個）。 */
  exports: ExportBox[];
  /** key：anchorKey(nodeKey, side, port)。 */
  anchors: Map<string, Point>;
  edges: EdgePath[];
  /** 每層的節點 key（由上而下）。 */
  layers: string[][];
  /** 循環節點所在層；沒有循環＝null。 */
  cyclicLayer: number | null;
  width: number;
  height: number;
}

/** 幾何（px）：卡片寬固定，高度＝標頭＋資訊列＋接點列。 */
export const GEOMETRY = {
  nodeWidth: 224,
  border: 1,
  headerHeight: 48,
  metaRowHeight: 20,
  /** 接點區上方分隔線。 */
  divider: 1,
  portPadY: 6,
  portRowHeight: 22,
  dotSize: 8,
  layerGap: 96,
  rowGap: 28,
  padding: 32,
  /** 回頭線向外繞的距離。 */
  loop: 48,
  /** 流程輸出徽章：距接點、高度、最大寬度（不超過欄距，不會壓到下一欄的節點卡）。 */
  exportOffset: 8,
  exportHeight: 18,
  exportMaxWidth: 84,
} as const;
