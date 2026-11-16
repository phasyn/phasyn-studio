import { useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DockBody, DockHeader, DockPanel } from "./DockPanel";
import { OutlinerSlotContext } from "./outlinerContext";

/** 頁面提供的左下「大綱」面板（Bridge 的 Outliner）：資源群組、步驟大綱等。左欄收合時不顯示；出現時淡入。 */
export function Outliner({ title, icon, count, actions, children }: { title: string; icon?: ReactNode; count?: number | null; actions?: ReactNode; children: ReactNode }) {
  const slot = useContext(OutlinerSlotContext);
  if (!slot) return null;
  return createPortal(
    <DockPanel aria-label={title} className="h-full animate-fade-in">
      <DockHeader icon={icon} title={title} count={count} actions={actions} />
      <DockBody>{children}</DockBody>
    </DockPanel>,
    slot,
  );
}
