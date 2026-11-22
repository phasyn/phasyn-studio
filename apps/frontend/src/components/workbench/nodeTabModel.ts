// Node 分頁的資料（元件修改區的左欄與元件頁共用）：分頁項目、目前 Node 的決定方式、元件頁網址。
import type { ComponentEntry, NodeView } from "@/api/catalog";
import { statusSpec } from "@/components/common/statusSpec";
import type { NodeTabItem } from "./NodeTabs";
import type { Tone } from "./tones";
import { t } from "@/i18n";

function livenessTone(node: NodeView): Tone {
  if (node.liveness === "online") return "success";
  if (node.liveness === "duplicate_node_id") return "danger";
  if (node.liveness === "offline") return "warning";
  return "neutral";
}

function livenessLabel(node: NodeView): string {
  return node.liveness === "unknown" ? t("連線狀態未知") : statusSpec("directory", node.liveness).label;
}

/** 依目錄順序（不因上下線重排，分頁位置固定）；計數＝該 Node 的 instance 數。 */
export function nodeTabItems(nodes: readonly NodeView[], entries: readonly ComponentEntry[]): NodeTabItem[] {
  return nodes.map((node) => {
    const count = entries.filter((entry) => entry.node.node_id === node.node_id).length;
    const state = livenessLabel(node);
    return {
      id: node.node_id,
      label: node.label,
      title: `${node.label}\n${node.node_id}\n${state}${node.snapshot ? ` · ${node.snapshot.platform}` : t(" · 尚未收到元件快照")}`,
      count,
      dot: livenessTone(node),
      dotLabel: state,
      muted: node.stale,
    };
  });
}

export interface ActiveNodeInput {
  nodeIds: readonly string[];
  entries: readonly ComponentEntry[];
  /** 網址 ?node=（元件頁的狀態來源；不在目錄時仍採用，由畫面顯示「目錄中沒有」）。 */
  node: string | null;
  /** 網址 ?component=（沒有 node 時用它所在的 Node）。 */
  component: string | null;
  /** 這台瀏覽器上次看的 Node。 */
  remembered: string | null;
}

/** 目前的 Node：網址 node → component 所在 Node → 上次看的 → 目錄第一個。 */
export function resolveActiveNode(input: ActiveNodeInput): string | null {
  if (input.node != null && input.node !== "") return input.node;
  if (input.component != null && input.component !== "") {
    const owner = input.entries.find((entry) => entry.descriptor.component_id === input.component);
    if (owner) return owner.node.node_id;
  }
  if ((input.remembered != null && input.remembered !== "") && input.nodeIds.includes(input.remembered)) return input.remembered;
  return input.nodeIds[0] ?? null;
}

export const COMPONENTS_PATH = "/admin/components";

/** 元件頁網址：?node=＆component=。 */
export function componentsHref(nodeId: string | null, componentId?: string | null): string {
  const params = new URLSearchParams();
  if (nodeId != null && nodeId !== "") params.set("node", nodeId);
  if (componentId != null && componentId !== "") params.set("component", componentId);
  const search = params.toString();
  return search ? `${COMPONENTS_PATH}?${search}` : COMPONENTS_PATH;
}
