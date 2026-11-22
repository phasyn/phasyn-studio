// 分層版面（純函式）：最長路徑分層 → 長邊插入虛擬點 → 重心法排序（多輪，保留交叉最少者）→
// 依連線對齊的縱向座標（保序、最小間距：isotonic regression）→ 接點座標、三次貝茲連線與流程輸出徽章位置。
// 輸入固定在第一欄；循環中的步驟放在步驟的最後一層並由 model 標示。流程輸出不是節點，徽章放在接點右側。
import { metaRowsOf } from "./graphModel";
import { GEOMETRY, type EdgePath, type ExportBox, type GraphLayout, type GraphModel, type GraphNode, type NodeBox, type Point } from "./graphTypes";

const G = GEOMETRY;
/** 長邊經過中間欄位時佔用的高度與間距。 */
const DUMMY_HEIGHT = 8;
const DUMMY_GAP = 12;
const SWEEPS = 4;
const ALIGN_PASSES = 4;

export function anchorKey(nodeKey: string, side: "in" | "out", port: string): string {
  return `${nodeKey}␟${side}␟${port}`;
}

export function portRows(node: GraphNode): number {
  return Math.max(node.inputs.length, node.outputs.length);
}

export function nodeHeight(node: GraphNode): number {
  const rows = portRows(node);
  const ports = rows > 0 ? G.divider + G.portPadY * 2 + rows * G.portRowHeight : 0;
  return G.border * 2 + G.headerHeight + metaRowsOf(node) * G.metaRowHeight + ports;
}

/** 第 index 個接點列中心相對卡片頂端的距離。 */
export function portOffsetY(node: GraphNode, index: number): number {
  return G.border + G.headerHeight + metaRowsOf(node) * G.metaRowHeight + G.divider + G.portPadY + index * G.portRowHeight + G.portRowHeight / 2;
}

export function layerX(layer: number): number {
  return layer * (G.nodeWidth + G.layerGap);
}

interface Entry {
  id: string;
  /** null＝長邊的虛擬點。 */
  node: GraphNode | null;
  height: number;
  /** 穩定排序用（真實節點的 order；虛擬點沿用來源節點）。 */
  order: number;
  top: number;
}

interface Segment {
  upper: string;
  /** 接點在上層實體內的相對位置（0–1，排序用）。 */
  upperFrac: number;
  upperOffset: number;
  lower: string;
  lowerFrac: number;
  lowerOffset: number;
}

/** 最長路徑分層：輸入＝0；步驟＝1＋上游最大層；循環步驟放步驟最後一層。空層會被壓縮。 */
export function assignLayers(model: GraphModel): Map<string, number> {
  const layer = new Map<string, number>();
  const steps = model.nodes.filter((node) => node.kind === "step");
  for (const node of model.nodes) if (node.kind === "input") layer.set(node.key, 0);

  const acyclic = steps.filter((node) => !node.cyclic).sort((a, b) => a.order - b.order);
  const acyclicKeys = new Set(acyclic.map((node) => node.key));
  const preds = new Map<string, string[]>(acyclic.map((node) => [node.key, []]));
  const succs = new Map<string, string[]>(acyclic.map((node) => [node.key, []]));
  for (const edge of model.edges) {
    if (edge.kind !== "step" || !acyclicKeys.has(edge.from.node) || !acyclicKeys.has(edge.to.node) || edge.from.node === edge.to.node) continue;
    preds.get(edge.to.node)?.push(edge.from.node);
    succs.get(edge.from.node)?.push(edge.to.node);
  }
  // Kahn：同時可處理者依 order，結果穩定。
  const remaining = new Map(acyclic.map((node) => [node.key, preds.get(node.key)?.length ?? 0]));
  const ready = acyclic.filter((node) => remaining.get(node.key) === 0).map((node) => node.key);
  const orderOf = new Map(acyclic.map((node) => [node.key, node.order]));
  while (ready.length > 0) {
    ready.sort((a, b) => (orderOf.get(a) ?? 0) - (orderOf.get(b) ?? 0));
    const key = ready.shift();
    if (key === undefined) break;
    const own = Math.max(1, ...(preds.get(key) ?? []).map((pred) => (layer.get(pred) ?? 0) + 1));
    layer.set(key, own);
    for (const next of succs.get(key) ?? []) {
      const left = (remaining.get(next) ?? 0) - 1;
      remaining.set(next, left);
      if (left === 0) ready.push(next);
    }
  }
  // 防護：理論上無循環子圖一定排得完；若資料異常仍給每個步驟一層。
  for (const node of acyclic) if (!layer.has(node.key)) layer.set(node.key, 1);
  let lastStep = 0;
  for (const node of acyclic) lastStep = Math.max(lastStep, layer.get(node.key) ?? 1);
  const cyclic = steps.filter((node) => node.cyclic);
  if (cyclic.length > 0) {
    lastStep = Math.max(1, lastStep + 1);
    for (const node of cyclic) layer.set(node.key, lastStep);
  }

  const used = [...new Set(layer.values())].sort((a, b) => a - b);
  const compact = new Map(used.map((value, index) => [value, index]));
  for (const [key, value] of layer) layer.set(key, compact.get(value) ?? value);
  return layer;
}

/** 依保序與最小間距調整每列頂端：minimize Σ(top − desired)²（pool adjacent violators）。 */
export function packColumn(desired: readonly number[], heights: readonly number[], gaps: readonly number[]): number[] {
  const offsets: number[] = [];
  let offset = 0;
  desired.forEach((_, index) => {
    if (index > 0) offset += (heights[index - 1] ?? 0) + (gaps[index - 1] ?? 0);
    offsets.push(offset);
  });
  const blocks: { sum: number; count: number }[] = [];
  desired.forEach((value, index) => {
    blocks.push({ sum: value - (offsets[index] ?? 0), count: 1 });
    for (;;) {
      const last = blocks[blocks.length - 1];
      const prev = blocks[blocks.length - 2];
      if (!last || !prev || prev.sum / prev.count <= last.sum / last.count) break;
      prev.sum += last.sum;
      prev.count += last.count;
      blocks.pop();
    }
  });
  const out: number[] = [];
  for (const block of blocks) for (let i = 0; i < block.count; i += 1) out.push(block.sum / block.count + (offsets[out.length] ?? 0));
  return out;
}

function countCrossings(layers: readonly string[][], segments: readonly Segment[], layerOf: Map<string, number>): number {
  const rank = new Map<string, number>();
  for (const layer of layers) layer.forEach((id, index) => void rank.set(id, index));
  const byLayer = new Map<number, { a: number; b: number }[]>();
  for (const segment of segments) {
    const layer = layerOf.get(segment.upper) ?? 0;
    const list = byLayer.get(layer) ?? [];
    list.push({ a: (rank.get(segment.upper) ?? 0) + segment.upperFrac, b: (rank.get(segment.lower) ?? 0) + segment.lowerFrac });
    byLayer.set(layer, list);
  }
  let crossings = 0;
  for (const list of byLayer.values()) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const p = list[i];
        const q = list[j];
        if (p && q && (p.a - q.a) * (p.b - q.b) < 0) crossings += 1;
      }
    }
  }
  return crossings;
}

type Command = { op: "M" | "L"; p: Point } | { op: "C"; c1: Point; c2: Point; p: Point };

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function stringify(commands: readonly Command[]): string {
  return commands
    .map((command) =>
      command.op === "C"
        ? `C ${String(round(command.c1.x))} ${String(round(command.c1.y))}, ${String(round(command.c2.x))} ${String(round(command.c2.y))}, ${String(round(command.p.x))} ${String(round(command.p.y))}`
        : `${command.op} ${String(round(command.p.x))} ${String(round(command.p.y))}`,
    )
    .join(" ");
}

/** 水平切線的三次貝茲：從右側輸出接點到左側輸入接點。 */
function curve(from: Point, to: Point): Command {
  const dx = Math.max(24, (to.x - from.x) / 2);
  return { op: "C", c1: { x: from.x + dx, y: from.y }, c2: { x: to.x - dx, y: to.y }, p: to };
}

/** 完整版面。 */
export function layoutGraph(model: GraphModel): GraphLayout {
  const nodesByKey = new Map(model.nodes.map((node) => [node.key, node]));
  const layerOf = assignLayers(model);
  const layerCount = Math.max(0, ...[...layerOf.values()].map((value) => value + 1));

  // 實體：真實節點＋長邊的虛擬點；相鄰層之間的線段。
  const entries = new Map<string, Entry>();
  for (const node of model.nodes) entries.set(node.key, { id: node.key, node, height: nodeHeight(node), order: node.order, top: 0 });
  const segments: Segment[] = [];
  const chains = new Map<string, string[]>();
  const portFrac = (node: GraphNode, side: "in" | "out", port: string) => {
    const list = side === "in" ? node.inputs : node.outputs;
    const index = Math.max(0, list.findIndex((item) => item.name === port));
    return { frac: (index + 0.5) / Math.max(1, list.length), offset: portOffsetY(node, index) };
  };
  for (const edge of model.edges) {
    const from = nodesByKey.get(edge.from.node);
    const to = nodesByKey.get(edge.to.node);
    if (!from || !to) continue;
    const a = layerOf.get(from.key) ?? 0;
    const b = layerOf.get(to.key) ?? 0;
    if (b <= a) continue; // 回頭線（循環）不參與排序與對齊。
    const chain: string[] = [];
    for (let layer = a + 1; layer < b; layer += 1) {
      const id = `${edge.key}␟${String(layer)}`;
      entries.set(id, { id, node: null, height: DUMMY_HEIGHT, order: from.order, top: 0 });
      layerOf.set(id, layer);
      chain.push(id);
    }
    chains.set(edge.key, chain);
    const ids = [from.key, ...chain, to.key];
    for (let i = 0; i + 1 < ids.length; i += 1) {
      const upper = ids[i] ?? "";
      const lower = ids[i + 1] ?? "";
      const up = i === 0 ? portFrac(from, "out", edge.from.port) : { frac: 0.5, offset: DUMMY_HEIGHT / 2 };
      const low = i + 2 === ids.length ? portFrac(to, "in", edge.to.port) : { frac: 0.5, offset: DUMMY_HEIGHT / 2 };
      segments.push({ upper, upperFrac: up.frac, upperOffset: up.offset, lower, lowerFrac: low.frac, lowerOffset: low.offset });
    }
  }
  const incoming = new Map<string, Segment[]>();
  const outgoing = new Map<string, Segment[]>();
  for (const segment of segments) {
    incoming.set(segment.lower, [...(incoming.get(segment.lower) ?? []), segment]);
    outgoing.set(segment.upper, [...(outgoing.get(segment.upper) ?? []), segment]);
  }

  // 排序：初始依 order；之後上下交替以重心法調整，保留交叉最少的結果。
  let layers: string[][] = Array.from({ length: layerCount }, () => []);
  for (const entry of entries.values()) layers[layerOf.get(entry.id) ?? 0]?.push(entry.id);
  const orderOf = (id: string) => entries.get(id)?.order ?? 0;
  layers = layers.map((layer) => [...layer].sort((a, b) => orderOf(a) - orderOf(b)));
  const sweep = (current: string[][], down: boolean): string[][] => {
    const next = current.map((layer) => [...layer]);
    const indices = down ? next.map((_, index) => index).slice(1) : next.map((_, index) => index).slice(0, -1).reverse();
    for (const index of indices) {
      const neighbor = next[down ? index - 1 : index + 1] ?? [];
      const rank = new Map(neighbor.map((id, position) => [id, position]));
      const layer = next[index] ?? [];
      const position = new Map(layer.map((id, at) => [id, at]));
      const bary = new Map<string, number>();
      for (const id of layer) {
        const links = (down ? incoming.get(id) : outgoing.get(id)) ?? [];
        const values = links.map((segment) =>
          down ? (rank.get(segment.upper) ?? 0) + segment.upperFrac : (rank.get(segment.lower) ?? 0) + segment.lowerFrac,
        );
        bary.set(id, values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : (position.get(id) ?? 0) + 0.5);
      }
      next[index] = [...layer].sort((a, b) => (bary.get(a) ?? 0) - (bary.get(b) ?? 0) || (position.get(a) ?? 0) - (position.get(b) ?? 0));
    }
    return next;
  };
  let best = layers;
  let bestCrossings = countCrossings(best, segments, layerOf);
  let current = layers;
  for (let attempt = 0; attempt < SWEEPS && bestCrossings > 0; attempt += 1) {
    current = sweep(current, attempt % 2 === 0);
    const crossings = countCrossings(current, segments, layerOf);
    if (crossings < bestCrossings) {
      best = current;
      bestCrossings = crossings;
    }
  }
  layers = best;

  // 縱向座標：先依序堆疊，再上下交替對齊連線（保序、最小間距）。
  const gapBetween = (a: Entry | undefined, b: Entry | undefined) => (a?.node && b?.node ? G.rowGap : DUMMY_GAP);
  const pack = (layer: string[], desired: (entry: Entry) => number) => {
    const list = layer.map((id) => entries.get(id)).filter((entry): entry is Entry => entry !== undefined);
    const gaps = list.slice(1).map((entry, index) => gapBetween(list[index], entry));
    const tops = packColumn(
      list.map(desired),
      list.map((entry) => entry.height),
      gaps,
    );
    list.forEach((entry, index) => {
      entry.top = tops[index] ?? entry.top;
    });
  };
  for (const layer of layers) {
    let top = 0;
    let previous: Entry | undefined;
    for (const id of layer) {
      const entry = entries.get(id);
      if (!entry) continue;
      if (previous) top += gapBetween(previous, entry);
      entry.top = top;
      top += entry.height;
      previous = entry;
    }
  }
  const topOf = (id: string) => entries.get(id)?.top ?? 0;
  const alignDown = (entry: Entry) => {
    const links = incoming.get(entry.id) ?? [];
    if (links.length === 0) return entry.top;
    return links.reduce((sum, segment) => sum + topOf(segment.upper) + segment.upperOffset - segment.lowerOffset, 0) / links.length;
  };
  const alignUp = (entry: Entry) => {
    const links = outgoing.get(entry.id) ?? [];
    if (links.length === 0) return entry.top;
    return links.reduce((sum, segment) => sum + topOf(segment.lower) + segment.lowerOffset - segment.upperOffset, 0) / links.length;
  };
  for (let pass = 0; pass < ALIGN_PASSES; pass += 1) {
    for (let index = 1; index < layers.length; index += 1) pack(layers[index] ?? [], alignDown);
    for (let index = layers.length - 2; index >= 0; index -= 1) pack(layers[index] ?? [], alignUp);
  }
  for (let index = 1; index < layers.length; index += 1) pack(layers[index] ?? [], alignDown);
  // 對齊整數像素（文字清晰）；高度與間距都是整數，四捨五入不會破壞最小間距。
  for (const entry of entries.values()) entry.top = Math.round(entry.top);

  // 節點方塊與接點。
  const boxes = new Map<string, NodeBox>();
  const anchors = new Map<string, Point>();
  layers.forEach((layer, layerIndex) => {
    let rank = 0;
    for (const id of layer) {
      const entry = entries.get(id);
      if (!entry?.node) continue;
      const node = entry.node;
      const x = layerX(layerIndex);
      boxes.set(node.key, { key: node.key, x, y: entry.top, width: G.nodeWidth, height: entry.height, layer: layerIndex, rank, metaRows: metaRowsOf(node), portRows: portRows(node) });
      rank += 1;
      node.inputs.forEach((port, index) => void anchors.set(anchorKey(node.key, "in", port.name), { x, y: entry.top + portOffsetY(node, index) }));
      node.outputs.forEach((port, index) => void anchors.set(anchorKey(node.key, "out", port.name), { x: x + G.nodeWidth, y: entry.top + portOffsetY(node, index) }));
    }
  });

  // 流程輸出徽章：接點右側、壓在連線起點上（寬度上限不超過欄距）。
  const exportBoxes: ExportBox[] = [];
  for (const node of model.nodes) {
    for (const port of node.outputs) {
      if (port.exports.length === 0) continue;
      const anchor = anchors.get(anchorKey(node.key, "out", port.name));
      if (!anchor) continue;
      exportBoxes.push({
        key: `export:${node.key}␟${port.name}`,
        nodeKey: node.key,
        port: port.name,
        x: anchor.x + G.exportOffset,
        y: anchor.y - G.exportHeight / 2,
        width: G.exportMaxWidth,
        height: G.exportHeight,
      });
    }
  }

  // 連線：相鄰欄一段貝茲；跨欄經過虛擬點（欄內水平直線）；回頭線從兩個節點下方繞回。
  const routes: { key: string; commands: Command[]; backward: boolean; from: Point; to: Point }[] = [];
  for (const edge of model.edges) {
    const from = anchors.get(anchorKey(edge.from.node, "out", edge.from.port));
    const to = anchors.get(anchorKey(edge.to.node, "in", edge.to.port));
    const fromBox = boxes.get(edge.from.node);
    const toBox = boxes.get(edge.to.node);
    if (!from || !to || !fromBox || !toBox) continue;
    const commands: Command[] = [{ op: "M", p: from }];
    const backward = toBox.layer <= fromBox.layer;
    if (backward) {
      const below = Math.max(fromBox.y + fromBox.height, toBox.y + toBox.height) + G.rowGap / 2;
      commands.push(
        { op: "C", c1: { x: from.x + G.loop, y: from.y }, c2: { x: from.x + G.loop, y: below }, p: { x: from.x, y: below } },
        { op: "L", p: { x: to.x, y: below } },
        { op: "C", c1: { x: to.x - G.loop, y: below }, c2: { x: to.x - G.loop, y: to.y }, p: to },
      );
    } else {
      let cursor = from;
      for (const id of chains.get(edge.key) ?? []) {
        const entry = entries.get(id);
        if (!entry) continue;
        const x = layerX(layerOf.get(id) ?? 0);
        const y = entry.top + DUMMY_HEIGHT / 2;
        commands.push(curve(cursor, { x, y }), { op: "L", p: { x: x + G.nodeWidth, y } });
        cursor = { x: x + G.nodeWidth, y };
      }
      commands.push(curve(cursor, to));
    }
    routes.push({ key: edge.key, commands, backward, from, to });
  }

  // 正規化：所有內容（含回頭線外繞）移到 padding 內。
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const extend = (point: Point) => {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  };
  for (const box of [...boxes.values(), ...exportBoxes]) {
    extend(box);
    extend({ x: box.x + box.width, y: box.y + box.height });
  }
  for (const route of routes) {
    for (const command of route.commands) {
      extend(command.p);
      if (command.op === "C") {
        extend(command.c1);
        extend(command.c2);
      }
    }
  }
  if (!Number.isFinite(minX)) return { boxes, exports: [], anchors, edges: [], layers: [], cyclicLayer: null, width: G.padding * 2, height: G.padding * 2 };
  const dx = G.padding - minX;
  const dy = G.padding - minY;
  const shift = (point: Point): Point => ({ x: point.x + dx, y: point.y + dy });
  for (const box of [...boxes.values(), ...exportBoxes]) {
    box.x += dx;
    box.y += dy;
  }
  for (const [key, point] of anchors) anchors.set(key, shift(point));
  const edges: EdgePath[] = routes.map((route) => ({
    key: route.key,
    backward: route.backward,
    from: shift(route.from),
    to: shift(route.to),
    d: stringify(
      route.commands.map((command): Command =>
        command.op === "C" ? { op: "C", c1: shift(command.c1), c2: shift(command.c2), p: shift(command.p) } : { op: command.op, p: shift(command.p) },
      ),
    ),
  }));

  const realLayers = layers.map((layer) => layer.filter((id) => entries.get(id)?.node));
  const cyclicNode = model.nodes.find((node) => node.cyclic);
  return {
    boxes,
    exports: exportBoxes,
    anchors,
    edges,
    layers: realLayers,
    cyclicLayer: cyclicNode ? (boxes.get(cyclicNode.key)?.layer ?? null) : null,
    width: maxX - minX + G.padding * 2,
    height: maxY - minY + G.padding * 2,
  };
}
