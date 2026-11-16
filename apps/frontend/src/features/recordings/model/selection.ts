import { t } from "@/i18n";
// 右側檢視器的選取對象：part、搬運類別或單一事件（時間軸／表格上的項目）。
export type Selection =
  | { kind: "part"; part: string }
  | { kind: "category"; category: string }
  | { kind: "event"; streamId: string; seq: number };

export function selectionEventKey(selection: Selection | null): string | null {
  return selection?.kind === "event" ? `${selection.streamId}:${selection.seq}` : null;
}

export function selectionLabel(selection: Selection): string {
  switch (selection.kind) {
    case "part":
      return `part ${selection.part}`;
    case "category":
      return t("搬運類別 {category}", { category: selection.category });
    case "event":
      return t("事件 {streamId}#{seq}", { streamId: selection.streamId, seq: selection.seq });
  }
}
