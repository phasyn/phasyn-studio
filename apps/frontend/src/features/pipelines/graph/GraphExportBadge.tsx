// 流程輸出徽章（「↗ final」）：標在產生它的步驟輸出接點右側、壓在連線起點上；流程輸出不是獨立節點。
// 點選＝選取該流程輸出（Inspector 可改名、改來源、移除）。不在 Tab 順序中：鍵盤使用者從節點卡的說明、
// 流程大綱與步驟檢視器取得同樣資訊與操作。
import { ArrowUpRight, CircleCheck, CircleDashed } from "lucide-react";
import { memo } from "react";
import { BORDER_TONE, TEXT_TONE, type Tone } from "@/components/workbench/tones";
import { cn } from "@/lib/cn";
import { producedText } from "./graphModel";
import { SELECTED_EXPORT } from "./graphStyles";
import type { ExportBox, GraphPort } from "./graphTypes";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

export interface GraphExportBadgeProps {
  box: ExportBox;
  port: GraphPort;
  stepId: string;
  /** 目前選取的流程輸出名稱（沒有＝null）。 */
  selectedName: string | null;
  onSelect: (name: string) => void;
}

export const GraphExportBadge = memo(function GraphExportBadge({ box, port, stepId, selectedName, onSelect }: GraphExportBadgeProps) {
  const first = port.exports[0];
  if (!first) return null;
  const names = port.exports.map((item) => item.name);
  const runMode = port.exports.some((item) => item.produced !== null);
  const produced = runMode && port.exports.every((item) => item.produced === "yes");
  const tone: Tone = produced ? "success" : runMode ? "neutral" : port.tone;
  const Icon = !runMode ? ArrowUpRight : produced ? CircleCheck : CircleDashed;
  const selected = selectedName !== null && names.includes(selectedName);
  const lines = port.exports.map((item) => {
    const state = producedText(item.produced);
    return t("流程輸出 {name}{value}", { name: item.name, value: state ? t("（{state}）", { state }) : "" });
  });
  return (
    <button
      type="button"
      data-graph-node=""
      tabIndex={-1}
      aria-pressed={selected}
      aria-label={t("{lines}，來自 {stepId}.{name}", { lines: formatList(lines), stepId, name: port.name })}
      title={t("{lines}\n來自 {stepId}.{name}{value}\n點選可在檢視器修改", { lines: lines.join("\n"), stepId, name: port.name, value: port.typeId ? t("（{typeId}）", { typeId: port.typeId }) : "" })}
      onClick={() => onSelect(selectedName && names.includes(selectedName) ? selectedName : first.name)}
      // 選取＝品牌漸層邊＋低透明度品牌底（與選取的節點卡一致）；按下時輕微縮小（pressable）。
      // 顏色過場用全域 button 規則（不另寫 transition，避免蓋掉 pressable 的彈簧）。
      className={cn(
        "pressable absolute inline-flex min-w-0 cursor-pointer items-center gap-1 overflow-hidden rounded-full border bg-surface px-1.5 text-[11px] leading-4 whitespace-nowrap",
        BORDER_TONE[tone],
        tone === "neutral" ? "text-fg-secondary" : TEXT_TONE[tone],
        runMode && !produced && "border-dashed",
        selected ? SELECTED_EXPORT : "shadow-edge hover:bg-raised",
      )}
      style={{ left: box.x, top: box.y, height: box.height, maxWidth: box.width }}
    >
      <Icon aria-hidden className="size-3 shrink-0" />
      <span className="machine min-w-0 truncate">{first.name}</span>
      {names.length > 1 ? <span className="machine shrink-0">+{names.length - 1}</span> : null}
    </button>
  );
});
