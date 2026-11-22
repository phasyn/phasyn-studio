// 含行內元素的整句，例如「顯示 <0>{shown}</0>／<1>{total}</1> 個 instance」：
//   <n>…</n> → slots[n] 套上內容（cloneElement，保留原本的 className、onClick…）
//   <n/>     → slots[n] 原樣（icon、換行等沒有內容的元素）
//   {name}   → values[name]（文字、數字或 React 節點；false／null 與原本 JSX 一樣不顯示）
// 譯文可以調整標籤順序，但編號與配對要和原文一致；譯文解析失敗時改用原文，原文也失敗就顯示純文字（不讓畫面崩潰）。
import { cloneElement, createElement, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { translateRaw } from "./index";

export type RichNode = { kind: "text"; text: string } | { kind: "value"; name: string } | { kind: "slot"; index: number; children: RichNode[] | null };

const TOKEN = /<(\d+)\/>|<(\d+)>|<\/(\d+)>|\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

interface Frame {
  index: number;
  children: RichNode[];
  parent: RichNode[];
}

/** 解析訊息；標籤不成對、交錯或多出結尾標籤時回傳 null。 */
export function parseRich(message: string): RichNode[] | null {
  const root: RichNode[] = [];
  const stack: Frame[] = [];
  let current = root;
  let last = 0;
  for (const match of message.matchAll(TOKEN)) {
    const at = match.index;
    if (at > last) current.push({ kind: "text", text: message.slice(last, at) });
    last = at + match[0].length;
    const [, self, open, close, name] = match;
    if (self !== undefined) {
      current.push({ kind: "slot", index: Number(self), children: null });
    } else if (open !== undefined) {
      const frame: Frame = { index: Number(open), children: [], parent: current };
      stack.push(frame);
      current = frame.children;
    } else if (close !== undefined) {
      const frame = stack.pop();
      if (frame?.index !== Number(close)) return null;
      frame.parent.push({ kind: "slot", index: frame.index, children: frame.children });
      current = frame.parent;
    } else if (name !== undefined) {
      current.push({ kind: "value", name });
    }
  }
  if (stack.length > 0) return null;
  if (last < message.length) current.push({ kind: "text", text: message.slice(last) });
  return root;
}

type Values = Readonly<Record<string, ReactNode>>;

function renderNodes(nodes: readonly RichNode[], values: Values, slots: readonly ReactElement[]): ReactNode[] {
  return nodes.map((node) => {
    if (node.kind === "text") return node.text;
    if (node.kind === "value") return Object.hasOwn(values, node.name) ? values[node.name] : `{${node.name}}`;
    const slot = slots[node.index];
    const children = node.children ? renderNodes(node.children, values, slots) : [];
    if (!isValidElement(slot)) return children.length > 0 ? createElement(Fragment, null, ...children) : null;
    // eslint-disable-next-line @eslint-react/no-clone-element -- The translator supplies children for an existing caller-owned slot while keeping its type, props, ref and key.
    return node.children ? cloneElement(slot, undefined, ...children) : slot;
  });
}

/** 依目前語言翻譯並組成 React 節點（<T> 的本體；也可在 .ts 檔直接使用）。 */
export function renderRich(source: string, values: Values = {}, slots: readonly ReactElement[] = [], context?: string): ReactNode {
  const message = translateRaw(source, values, { ...(context === undefined ? {} : { context }) });
  const tree = parseRich(message) ?? parseRich(source);
  if (!tree) return message;
  return createElement(Fragment, null, ...renderNodes(tree, values, slots));
}
