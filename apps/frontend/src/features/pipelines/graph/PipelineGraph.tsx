// pipeline DAG 畫布（元件組合、run 明細共用）：sunken 底＋靜態點陣、可平移縮放的節點卡與型別色連線；
// 流程輸出以徽章標在產生它的步驟輸出接點上（不是獨立節點）。
// 互動：拖曳背景平移、Ctrl／⌘＋滾輪以游標為中心縮放（一般滾輪平移）、方向鍵在節點間移動、Enter 選取、Esc 取消、
// +／-／0／F 縮放快捷鍵。視角只在第一次量到尺寸、pipeline／run 改變、或按「符合視窗」時自動調整；輪詢不會改變視角。
// 沒有動畫平移。
import { CircleAlert, Scan, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { EmptyState } from "@/components/common/EmptyState";
import { ToolButton, ToolSeparator } from "@/components/workbench/ToolStrip";
import { STROKE_TONE } from "@/components/workbench/tones";
import { cn } from "@/lib/cn";
import type { PipelineIssue } from "../pipelineModel";
import { GraphExportBadge } from "./GraphExportBadge";
import { GraphMinimap } from "./GraphMinimap";
import { GraphNodeCard } from "./GraphNodeCard";
import { layoutGraph } from "./graphLayout";
import { buildGraphModel, selectionKey, selectionOf } from "./graphModel";
import { GRAPH_CANVAS } from "./graphStyles";
import type { GraphNode, PipelineGraphProps } from "./graphTypes";
import {
  centerOn,
  clampView,
  contentOverflows,
  AUTO_FIT_MIN,
  fitView,
  isBoxVisible,
  nearestInDirection,
  readingOrder,
  revealBox,
  zoomAround,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  type Direction,
  type Size,
  type ViewTransform,
} from "./graphView";
import { useMeasuredElement } from "@/lib/useElementSize";
import { t } from "@/i18n";
import { T } from "@/i18n/T";
import { formatList } from "@/i18n/format";

const NO_ISSUES: readonly PipelineIssue[] = [];
const ARROWS: Record<string, Direction> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
const DEFAULT_VIEW: ViewTransform = { x: 0, y: 0, k: 1 };
/** The smallest canvas that shows the minimap (168 × 104 px plus its margin): about three times its height. */
const MINIMAP_ROOM = { width: 480, height: 360 } as const;

interface StoredView {
  identity: string;
  view: ViewTransform;
  /** true＝符合視窗模式：容器尺寸改變時重新符合（內容改變不重算）。 */
  auto: boolean;
  width: number;
  height: number;
  /** 符合視窗模式重算時使用的最小縮放（初次顯示＝AUTO_FIT_MIN；按「符合視窗」＝0，顯示整張）。 */
  fitMin: number;
}

interface Latest {
  view: ViewTransform;
  size: Size;
  identity: string;
  onSelect: PipelineGraphProps["onSelect"];
}

export function PipelineGraph({ pipeline, lookup, run = null, issues, selection, onSelect, label, className, nodeLabel }: PipelineGraphProps) {
  const hintId = useId();
  const allIssues = issues ?? NO_ISSUES;
  const model = useMemo(() => buildGraphModel(pipeline, lookup, { run, issues: allIssues, ...(nodeLabel === undefined ? {} : { nodeLabel }) }), [pipeline, lookup, run, allIssues, nodeLabel]);
  const layout = useMemo(() => layoutGraph(model), [model]);
  const edgeInfo = useMemo(() => new Map(model.edges.map((edge) => [edge.key, edge])), [model]);
  const [setViewport, viewport, size] = useMeasuredElement<HTMLElement>();
  const identity = `${pipeline.pipeline_id}␟${run?.run_id ?? ""}`;
  const [stored, setStored] = useState<StoredView | null>(null);
  const selected = selectionKey(selection);
  const activeKey = selected !== null && layout.boxes.has(selected) ? selected : null;
  const [revealed, setRevealed] = useState(activeKey);
  const [tabKey, setTabKey] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ pointer: number; x: number; y: number; origin: ViewTransform; moved: boolean } | null>(null);
  const nodeRefsRef = useRef(new Map<string, HTMLButtonElement>());

  // 視角：第一次量到尺寸、或 pipeline／run 換了 → 符合視窗；外部改變選取且節點在畫面外 → 最小平移讓它進入畫面。
  const sized = size.width > 0 && size.height > 0;
  const current = stored !== null && stored.identity === identity ? stored : null;
  let resolved: ViewTransform = current?.view ?? (sized ? fitView(layout, size, AUTO_FIT_MIN) : DEFAULT_VIEW);
  let next: StoredView | null = null;
  if (sized && (current === null || (current.auto && (current.width !== size.width || current.height !== size.height)))) {
    const fitMin = current?.fitMin ?? AUTO_FIT_MIN;
    resolved = fitView(layout, size, fitMin);
    next = { identity, view: resolved, auto: true, width: size.width, height: size.height, fitMin };
  }
  if (revealed !== activeKey) {
    setRevealed(activeKey);
    const box = activeKey !== null ? layout.boxes.get(activeKey) : undefined;
    if (sized && box && !isBoxVisible(box, resolved, size)) {
      resolved = clampView(revealBox(resolved, box, size), layout, size);
      next = { identity, view: resolved, auto: false, width: size.width, height: size.height, fitMin: AUTO_FIT_MIN };
    }
  }
  if (next !== null) setStored(next);
  const view = resolved;

  const latestRef = useRef<Latest>({ view, size, identity, onSelect });
  useLayoutEffect(() => {
    latestRef.current = { view, size, identity, onSelect };
  });

  const commit = (change: (base: ViewTransform) => ViewTransform) => {
    setStored((previous) => {
      const base = previous !== null && previous.identity === identity ? previous.view : view;
      return { identity, view: clampView(change(base), layout, size), auto: false, width: size.width, height: size.height, fitMin: AUTO_FIT_MIN };
    });
  };
  const middle = () => ({ x: size.width / 2, y: size.height / 2 });
  const zoomBy = (factor: number) => { commit((base) => zoomAround(base, base.k * factor, middle())); };
  const resetZoom = () => { commit((base) => zoomAround(base, 1, middle())); };
  const refit = () => {
    // 「符合視窗」：顯示整張圖（不套用初次顯示的最小縮放）
    if (sized) setStored({ identity, view: fitView(layout, size), auto: true, width: size.width, height: size.height, fitMin: 0 });
  };

  const onWheel = useEffectEvent((event: WheelEvent) => {
    if (!viewport || !sized) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1;
    if (event.ctrlKey || event.metaKey) {
      const rect = viewport.getBoundingClientRect();
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const factor = Math.exp(-event.deltaY * unit * 0.002);
      commit((base) => zoomAround(base, base.k * factor, point));
      return;
    }
    let dx = event.deltaX * unit;
    let dy = event.deltaY * unit;
    if (event.shiftKey && dx === 0) {
      dx = dy;
      dy = 0;
    }
    commit((base) => ({ ...base, x: base.x - dx, y: base.y - dy }));
  });
  useEffect(() => {
    if (!viewport) return;
    // React 的 onWheel 是 passive，無法阻止頁面捲動／瀏覽器縮放，因此用原生 listener。
    const listener = (event: WheelEvent) => { onWheel(event); };
    viewport.addEventListener("wheel", listener, { passive: false });
    return () => { viewport.removeEventListener("wheel", listener); };
  }, [viewport]);

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !(event.target instanceof Element) || event.target.closest("[data-graph-node],[data-graph-tool]")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, origin: view, moved: false };
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const state = dragRef.current;
    if (state?.pointer !== event.pointerId) return;
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    if (!state.moved && Math.hypot(dx, dy) < 4) return;
    if (!state.moved) {
      state.moved = true;
      setDragging(true);
    }
    const moved = clampView({ ...state.origin, x: state.origin.x + dx, y: state.origin.y + dy }, layout, size);
    setStored({ identity, view: moved, auto: false, width: size.width, height: size.height, fitMin: AUTO_FIT_MIN });
  };
  const endDrag = (event: PointerEvent<HTMLElement>, cancelled: boolean) => {
    const state = dragRef.current;
    if (state?.pointer !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    // 點背景（沒有拖曳）＝取消選取。
    if (!state.moved && !cancelled && selection !== null) onSelect(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    switch (event.key) {
      case "+":
      case "=":
        zoomBy(ZOOM_STEP);
        break;
      case "-":
      case "_":
        zoomBy(1 / ZOOM_STEP);
        break;
      case "0":
        resetZoom();
        break;
      case "f":
      case "F":
        refit();
        break;
      case "Escape":
        if (selection === null) return;
        onSelect(null);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  // 節點卡的 callback 保持穩定（平移時節點卡不重繪）；需要最新視角的部分讀 latest。
  const registerRef = useCallback((key: string, element: HTMLButtonElement | null) => {
    if (element) nodeRefsRef.current.set(key, element);
    else nodeRefsRef.current.delete(key);
  }, []);
  const onActivate = useCallback((node: GraphNode) => { latestRef.current.onSelect(selectionOf(node)); }, []);
  const onSelectExport = useCallback((name: string) => { latestRef.current.onSelect({ kind: "output", id: name }); }, []);
  const selectedExport = selection?.kind === "output" ? selection.id : null;
  const onNodeFocus = useCallback(
    (node: GraphNode) => {
      setTabKey(node.key);
      const box = layout.boxes.get(node.key);
      const { view: base, size: area, identity: id } = latestRef.current;
      if (!box || area.width <= 0 || isBoxVisible(box, base, area)) return;
      setStored({ identity: id, view: clampView(revealBox(base, box, area), layout, area), auto: false, width: area.width, height: area.height, fitMin: AUTO_FIT_MIN });
    },
    [layout],
  );
  const onNodeKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, node: GraphNode) => {
      let target: string | null;
      const direction = ARROWS[event.key];
      if (direction) target = nearestInDirection(layout.boxes.values(), node.key, direction)?.key ?? null;
      else if (event.key === "Home") target = readingOrder(layout.boxes.values())[0]?.key ?? null;
      else if (event.key === "End") target = readingOrder(layout.boxes.values()).at(-1)?.key ?? null;
      else return;
      event.preventDefault();
      event.stopPropagation();
      if (target !== null) nodeRefsRef.current.get(target)?.focus({ preventScroll: true });
    },
    [layout],
  );

  const firstKey = readingOrder(layout.boxes.values())[0]?.key ?? null;
  const tabStop = (tabKey !== null && layout.boxes.has(tabKey) ? tabKey : null) ?? activeKey ?? firstKey;

  const edgeLayer = useMemo(() => {
    const related = (key: string) => {
      const edge = edgeInfo.get(key);
      return activeKey !== null && edge !== undefined && (edge.from.node === activeKey || edge.to.node === activeKey);
    };
    const ordered = [...layout.edges].sort((a, b) => Number(related(a.key)) - Number(related(b.key)));
    return (
      <svg aria-hidden width={layout.width} height={layout.height} className="pointer-events-none absolute top-0 left-0 overflow-visible">
        {ordered.map((path) => {
          const edge = edgeInfo.get(path.key);
          const hot = related(path.key);
          return (
            <path
              key={path.key}
              d={path.d}
              fill="none"
              strokeLinecap="round"
              strokeDasharray={(edge?.mismatch === true) ? "5 4" : undefined}
              // 選取節點時：相關連線加粗、其他淡出（線寬與透明度以 CSS 過場）
              style={{ strokeWidth: hot ? 2.5 : 1.5 }}
              className={cn(
                "transition-[opacity,stroke-width] duration-(--duration-fast) ease-standard",
                (edge?.mismatch === true) ? "stroke-danger" : edge?.tone === undefined ? STROKE_TONE.neutral : STROKE_TONE[edge.tone],
                activeKey !== null && !hot && "opacity-30",
              )}
            />
          );
        })}
      </svg>
    );
  }, [layout, edgeInfo, activeKey]);

  const nodeLayer = useMemo(
    () =>
      model.nodes.map((node) => {
        const box = layout.boxes.get(node.key);
        if (!box) return null;
        return (
          <GraphNodeCard
            key={node.key}
            node={node}
            box={box}
            selected={node.key === activeKey}
            tabbable={node.key === tabStop}
            onActivate={onActivate}
            onNodeKeyDown={onNodeKeyDown}
            onNodeFocus={onNodeFocus}
            registerRef={registerRef}
          />
        );
      }),
    [model, layout, activeKey, tabStop, onActivate, onNodeKeyDown, onNodeFocus, registerRef],
  );

  const exportLayer = useMemo(() => {
    const nodes = new Map(model.nodes.map((node) => [node.key, node]));
    return layout.exports.map((box) => {
      const node = nodes.get(box.nodeKey);
      const port = node?.outputs.find((item) => item.name === box.port);
      if (!node || !port) return null;
      return <GraphExportBadge key={box.key} box={box} port={port} stepId={node.id} selectedName={selectedExport} onSelect={onSelectExport} />;
    });
  }, [model, layout, selectedExport, onSelectExport]);

  if (pipeline.steps.length === 0) {
    return (
      <section aria-label={label} className={cn("relative grid size-full place-items-center overflow-hidden", GRAPH_CANVAS, className)}>
        <EmptyState illustration="frames" title={t("此流程還沒有步驟")} description={t("新增步驟並設定每個輸入埠的來源後，節點圖會顯示在這裡。")} />
      </section>
    );
  }

  const percent = Math.round(view.k * 100);
  return (
    <section /* eslint-disable-line jsx-a11y-x/no-noninteractive-element-interactions -- This graph delegates pointer and keyboard navigation for its nodes to the graph surface. */
      ref={setViewport}
      aria-label={label}
      aria-describedby={hintId}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => { endDrag(event, false); }}
      onPointerCancel={(event) => { endDrag(event, true); }}
      onKeyDown={onKeyDown}
      onScroll={(event) => {
        // 瀏覽器在 Tab 聚焦畫面外的節點時會捲動 overflow 容器；視角由 transform 負責，捲動一律歸零。
        event.currentTarget.scrollTop = 0;
        event.currentTarget.scrollLeft = 0;
      }}
      className={cn("relative size-full touch-none overflow-hidden select-none", GRAPH_CANVAS, dragging ? "cursor-grabbing" : "cursor-grab", className)}
    >
      <p id={hintId} className="sr-only">
        {t("方向鍵在節點間移動，Enter 選取，Esc 取消選取；+／- 縮放，0 回到 100%，F 符合視窗；拖曳背景平移，Ctrl 或 ⌘ 加滾輪縮放。流程輸出標在步驟的輸出接點上，也列在流程大綱中。")}
      </p>
      {/* 第一次量到尺寸時整張圖淡入（只動透明度：平移縮放的 transform 寫在 style，不能被進場動畫覆寫）。 */}
      <div
        className={cn("absolute top-0 left-0 origin-top-left", sized ? "animate-fade-in" : "invisible")}
        style={{ width: layout.width, height: layout.height, transform: `translate(${String(view.x)}px, ${String(view.y)}px) scale(${String(view.k)})` }}
      >
        {edgeLayer}
        {nodeLayer}
        {exportLayer}
      </div>
      {model.danglingExports.length > 0 ? (
        <p
          data-graph-tool=""
          className="absolute top-2 left-2 z-10 flex max-w-[55%] items-center gap-1.5 rounded-lg border border-danger/40 bg-surface px-2 py-1 text-caption text-danger shadow-edge animate-rise-in"
          title={t("這些流程輸出的來源步驟不存在：{danglingExports}", { danglingExports: formatList(model.danglingExports) })}
        >
          <CircleAlert aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">
            <T source={"流程輸出 {span} 的來源步驟不存在"} values={{ span: <span className="machine">{formatList(model.danglingExports)}</span> }} />
          </span>
        </p>
      ) : null}
      {/* 浮在畫布上的控制（HUD 材質：半透明＋模糊；畫布本身維持實色）。 */}
      <div
        data-graph-tool=""
        role="group"
        aria-label={t("縮放")}
        className="material-hud absolute top-2 right-2 z-10 flex items-center gap-0.5 rounded-lg border border-line-subtle/70 p-0.5 shadow-edge"
      >
        <ToolButton
          label={t("縮小（-）")}
          icon={<ZoomOut aria-hidden />}
          onClick={() => { zoomBy(1 / ZOOM_STEP); }}
          disabledReason={view.k <= ZOOM_MIN + 1e-6 ? t("已是最小縮放 {zoomMin}%", { zoomMin: ZOOM_MIN * 100 }) : null}
        />
        <ToolButton
          label={t("重設為 100%（0）")}
          aria-label={t("目前縮放 {percent}%，重設為 100%", { percent })}
          icon={null}
          text={<span className="machine">{percent}%</span>}
          onClick={resetZoom}
          className="min-w-12"
        />
        <ToolButton
          label={t("放大（+）")}
          icon={<ZoomIn aria-hidden />}
          onClick={() => { zoomBy(ZOOM_STEP); }}
          disabledReason={view.k >= ZOOM_MAX - 1e-6 ? t("已是最大縮放 {zoomMax}%", { zoomMax: ZOOM_MAX * 100 }) : null}
        />
        <ToolSeparator />
        <ToolButton label={t("符合視窗（F）")} icon={<Scan aria-hidden />} onClick={refit} />
      </div>
      {/* The minimap only where it leaves room for the graph: on a small canvas (the run overview) it would cover nodes */}
      {sized && size.width >= MINIMAP_ROOM.width && size.height >= MINIMAP_ROOM.height && contentOverflows(layout, view, size) ? (
        <GraphMinimap layout={layout} view={view} viewport={size} selectedKey={activeKey} onCenter={(point) => { commit((base) => centerOn(base, point, size)); }} />
      ) : null}
    </section>
  );
}
