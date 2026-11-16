// Which view (graph／steps／JSON) and which selection the pipeline editor shows. A saved pipeline keeps them in the URL
// (restorable); a new draft lives only in location.state and changing the URL would rebuild it, so it keeps them locally.
import { useState } from "react";
import { useSearchParams } from "react-router";
import { parseSelection, selectionValue, type PipelineSelection } from "./selection";
import { t } from "@/i18n";

export type ViewId = "graph" | "steps" | "json";

export const VIEWS: ReadonlyArray<{ id: ViewId; label: string }> = [
  { id: "graph", label: t("節點圖") },
  { id: "steps", label: t("步驟與接線") },
  { id: "json", label: "JSON" },
];

export function useEditorView(isNew: boolean) {
  const [params, setParams] = useSearchParams();
  const [local, setLocal] = useState<Record<string, string | null>>({});
  const get = (key: string) => (isNew ? (local[key] ?? null) : params.get(key));
  const set = (key: string, value: string | null) => {
    if (isNew) {
      setLocal((previous) => ({ ...previous, [key]: value }));
      return;
    }
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  };
  const requested = get("view");
  const view: ViewId = VIEWS.some((item) => item.id === requested) ? (requested as ViewId) : "graph";
  return {
    view,
    setView: (id: ViewId) => set("view", id === "graph" ? null : id),
    selection: parseSelection(get("sel")),
    select: (next: PipelineSelection | null) => set("sel", selectionValue(next)),
  };
}
