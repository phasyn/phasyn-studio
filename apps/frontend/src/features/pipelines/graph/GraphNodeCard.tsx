// 節點卡（Bridge 式版面、Phasyn 深空配色）：類型色細邊＋圖示磚、標題（mono）、副標、run 狀態 chip、資訊列、左右接點列。
// 每一列都用 GEOMETRY 的固定高度，接點圓點才會剛好落在 graphLayout 算出的連線端點上。
import { ArrowRightFromLine, CircleAlert, CircleDashed, Repeat, Timer, TriangleAlert, Unplug, type LucideIcon } from "lucide-react";
import { memo, type KeyboardEvent } from "react";
import { StatusBadge } from "@/components/common/StatusBadge";
import { providerKind } from "@/components/workbench/kinds";
import { StatusChip } from "@/components/workbench/StatusChip";
import { BORDER_TONE, CHIP_TONE, DOT_TONE, TILE_TONE } from "@/components/workbench/tones";
import { cn } from "@/lib/cn";
import { formatMs } from "@/lib/format";
import { describeNode, durationText, hasRunLine, nodeBadges, stateLabel, type NodeBadgeKind } from "./graphModel";
import { SELECTED_NODE } from "./graphStyles";
import { GEOMETRY as G, type GraphNode, type GraphPort, type NodeBox } from "./graphTypes";
import { tServer, t } from "@/i18n";
import { T } from "@/i18n/T";
import { formatList } from "@/i18n/format";

const BADGE_ICON: Record<NodeBadgeKind, LucideIcon> = {
  "error-code": CircleAlert,
  "remote-unknown": TriangleAlert,
  errors: CircleAlert,
  warnings: TriangleAlert,
  "unknown-component": Unplug,
  cycle: Repeat,
  unused: CircleDashed,
};

const DOT_OFFSET = G.border + G.dotSize / 2;
const DOT_TOP = (G.portRowHeight - G.dotSize) / 2;

function portTitle(port: GraphPort): string {
  // 輸入節點的接點顯示 type_id（內部名稱 value 不對外）。
  const parts = [port.label === port.name ? t("{name}：{value}", { name: port.name, value: port.typeId ?? t("型別未知") }) : (port.typeId ?? t("型別未知"))];
  if (port.required) parts.push(t("必填"));
  if (port.literal) parts.push(t("常值（{value}，{typeId}）", { value: port.literal.file ? t("檔案") : "inline", typeId: port.literal.typeId }));
  if (port.missing) parts.push(t("元件描述沒有這個接點"));
  if (port.danglingSource != null && port.danglingSource !== "") parts.push(port.danglingSource);
  if (port.exports.length > 0) parts.push(t("流程輸出：{map}", { map: formatList(port.exports.map((item) => item.name)) }));
  if (port.description != null && port.description !== "") parts.push(tServer(port.description));
  parts.push(...port.issues.messages);
  return parts.join("\n");
}

function PortCell({ port }: { port: GraphPort }) {
  const out = port.side === "out";
  const filled = port.connected || port.literal !== null;
  const problem = port.missing || port.danglingSource !== null || port.issues.errors > 0;
  return (
    <span className={cn("flex min-w-0 flex-1 basis-0 items-center gap-1", out && "flex-row-reverse text-right")} title={portTitle(port)}>
      <span
        aria-hidden
        className={cn("absolute rounded-full ring-2 ring-surface", filled ? DOT_TONE[port.tone] : cn("border bg-surface", BORDER_TONE[port.tone]))}
        style={{ width: G.dotSize, height: G.dotSize, top: DOT_TOP, ...(out ? { right: -DOT_OFFSET } : { left: -DOT_OFFSET }) }}
      />
      <span className={cn("machine truncate text-caption", problem ? "text-danger" : port.connected || port.literal ? "text-fg-secondary" : "text-fg-tertiary")}>
        {port.label}
      </span>
      {port.required && !out ? (
        <span aria-hidden className={cn("shrink-0 text-caption", !port.connected && !port.literal ? "text-warning" : "text-fg-tertiary")}>
          *
        </span>
      ) : null}
      {port.literal ? <span className={cn("shrink-0 rounded-full border px-1.5 text-[11px] leading-4", CHIP_TONE.neutral)}>{t("常數")}</span> : null}
      {port.issues.errors > 0 || (port.danglingSource != null && port.danglingSource !== "") ? (
        <CircleAlert aria-hidden className="size-3 shrink-0 text-danger" />
      ) : port.issues.warnings > 0 ? (
        <TriangleAlert aria-hidden className="size-3 shrink-0 text-warning" />
      ) : null}
    </span>
  );
}

function NodeIcon({ node }: { node: GraphNode }) {
  const kind = node.kind === "step" ? providerKind(node.providerId) : null;
  if (kind?.art != null && kind.art !== "") return <img src={kind.art} alt="" className="size-7 object-contain" draggable={false} />;
  const Icon = node.kind === "input" ? ArrowRightFromLine : (kind?.icon ?? providerKind(null).icon);
  return <Icon />;
}

export interface GraphNodeCardProps {
  node: GraphNode;
  box: NodeBox;
  selected: boolean;
  tabbable: boolean;
  onActivate: (node: GraphNode) => void;
  onNodeKeyDown: (event: KeyboardEvent<HTMLButtonElement>, node: GraphNode) => void;
  onNodeFocus: (node: GraphNode) => void;
  registerRef: (key: string, element: HTMLButtonElement | null) => void;
}

export const GraphNodeCard = memo(function GraphNodeCard({ node, box, selected, tabbable, onActivate, onNodeKeyDown, onNodeFocus, registerRef }: GraphNodeCardProps) {
  const badges = nodeBadges(node);
  const failed = node.run?.state === "failed";
  const running = node.run?.state === "running";
  const rows = Array.from({ length: box.portRows }, (_, index) => index);
  return (
    <button
      ref={(element) => { registerRef(node.key, element); }}
      type="button"
      data-graph-node={node.key}
      tabIndex={tabbable ? 0 : -1}
      aria-pressed={selected}
      aria-label={describeNode(node, stateLabel(node), durationText(node))}
      onClick={() => { onActivate(node); }}
      onKeyDown={(event) => { onNodeKeyDown(event, node); }}
      onFocus={() => { onNodeFocus(node); }}
      // 選取＝1 px 品牌漸層邊＋淡光暈（取代藍色外框；邊框寬度不變，接點位置不受影響）；失敗的步驟選取時保留 danger 邊框、
      // 只加光暈。執行中＝慢速光暈呼吸（生成中狀態）。顏色與陰影 120 ms 過場；位置與尺寸不做動畫（連線端點是固定座標）。
      className={cn(
        "absolute flex cursor-pointer flex-col rounded-xl border bg-surface text-left transition-[border-color,box-shadow,background-color] duration-(--duration-fast) ease-standard focus-visible:outline-offset-4",
        node.unknownComponent ? "border-dashed border-line-strong" : BORDER_TONE[node.tone],
        failed && "border-danger",
        selected ? (failed ? "shadow-glow-sm" : SELECTED_NODE) : "shadow-edge hover:bg-raised hover:ring-1 hover:ring-line-control",
        running && "animate-glow-pulse",
      )}
      style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
    >
      <span className="flex shrink-0 items-center gap-2 px-2.5" style={{ height: G.headerHeight }}>
        <span aria-hidden className={cn("grid size-8 shrink-0 place-items-center overflow-hidden rounded-lg border [&_svg]:size-4", TILE_TONE[node.tone])}>
          <NodeIcon node={node} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="machine truncate text-data font-semibold text-fg" title={node.title}>
            {node.title}
          </span>
          <span className="truncate text-caption text-fg-tertiary" title={(node.componentLabel != null && node.componentLabel !== "") ? `${node.subtitle ?? ""}\n${node.componentLabel}` : (node.subtitle ?? undefined)}>
            {node.kind === "step" && (node.componentId != null && node.componentId !== "") ? (
              <>
                <span className="machine">{node.componentId}</span>
                {(node.nodeLabel != null && node.nodeLabel !== "") ? ` · ${node.nodeLabel}` : null}
              </>
            ) : (
              node.subtitle
            )}
          </span>
        </span>
        {node.run ? (
          node.run.state === "unknown" ? (
            <StatusChip tone="neutral" label={t("未回報")} title={t("run 沒有這一步的紀錄")} />
          ) : (
            <StatusBadge kind="step" value={node.run.state} />
          )
        ) : null}
      </span>
      {hasRunLine(node) ? (
        <span className="flex shrink-0 items-center gap-1.5 px-2.5 text-caption text-fg-secondary" style={{ height: G.metaRowHeight }}>
          <Timer aria-hidden className="size-3.5 shrink-0 text-fg-tertiary" />
          {node.run?.durationMs !== null && node.run?.durationMs !== undefined ? (
            <span className="truncate">
              <T source={"耗時 <0>{durationMs}</0>"} values={{ durationMs: formatMs(node.run.durationMs) }} slots={[<span key="slot-0" className="machine text-fg" />]} />
            </span>
          ) : (
            <span className="truncate text-fg-tertiary">{t("耗時 未量測（{value}）", { value: node.run?.durationReason ?? t("原因未知") })}</span>
          )}
        </span>
      ) : null}
      {badges.length > 0 ? (
        <span className="flex shrink-0 items-center gap-1 overflow-hidden px-2.5" style={{ height: G.metaRowHeight }} title={badges.map((badge) => badge.title).join("\n")}>
          {badges.map((badge) => {
            const Icon = BADGE_ICON[badge.kind];
            return (
              <span
                key={badge.kind}
                className={cn("inline-flex min-w-0 shrink-0 items-center gap-1 rounded-full border px-1.5 text-[11px] leading-4 whitespace-nowrap last:shrink", CHIP_TONE[badge.tone])}
              >
                <Icon aria-hidden className="size-3 shrink-0" />
                <span className={cn("truncate", badge.mono && "machine")}>{badge.label}</span>
              </span>
            );
          })}
        </span>
      ) : null}
      {rows.length > 0 ? (
        <span className="block shrink-0 border-t border-line-subtle" style={{ paddingTop: G.portPadY, paddingBottom: G.portPadY }}>
          {rows.map((index) => {
            const input = node.inputs[index];
            const output = node.outputs[index];
            return (
              <span key={index} className="relative flex items-center gap-2 px-2.5" style={{ height: G.portRowHeight }}>
                {input ? <PortCell port={input} /> : null}
                {output ? <PortCell port={output} /> : null}
              </span>
            );
          })}
        </span>
      ) : null}
    </button>
  );
});
