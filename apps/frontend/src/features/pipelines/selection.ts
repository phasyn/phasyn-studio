// 流程編輯器的選取（URL `sel` 參數）：pipeline 輸入、步驟或輸出；圖、大綱與 Inspector 共用。
export interface PipelineSelection { kind: "input" | "step" | "output"; id: string }

export function parseSelection(value: string | null): PipelineSelection | null {
  if (!(value != null && value !== "")) return null;
  const at = value.indexOf(":");
  if (at <= 0) return null;
  const kind = value.slice(0, at);
  const id = value.slice(at + 1);
  if (!id || (kind !== "input" && kind !== "step" && kind !== "output")) return null;
  return { kind, id };
}

export function selectionValue(selection: PipelineSelection | null): string | null {
  return selection ? `${selection.kind}:${selection.id}` : null;
}
