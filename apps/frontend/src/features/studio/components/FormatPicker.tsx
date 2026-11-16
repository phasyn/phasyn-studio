// 影片專案的畫面格式選擇（新專案表單、專案設定與「畫質」分頁共用）：推薦尺寸的下拉，加上「自訂…」展開寬×高兩個
// 數字欄。自訂值依 StudioProject.format 的規則（32–4096、32 的倍數）檢查，不合法時說明原因並給最接近的合法值讓使用者
// 自己按，不默默改值；合法時在 Enter 或離開欄位時才套用（專案設定每次套用都會標示已渲染的鏡頭需要重新渲染）。
import { ArrowLeftRight } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/controls";
import { cn } from "@/lib/cn";
import { FORMAT_PRESETS, FORMAT_SIDE, formatPresetOf, formatProblem, formatSideProblem, snapFormatSide } from "../model/project";
import { t } from "@/i18n";

const CUSTOM = "custom";

export function FormatPicker({
  id,
  width,
  height,
  onChange,
  compact = true,
  className,
}: {
  id: string;
  width: number;
  height: number;
  /** 只會收到合法的尺寸。 */
  onChange: (width: number, height: number) => void;
  compact?: boolean;
  className?: string;
}) {
  const preset = formatPresetOf(width, height);
  const [customOpen, setCustomOpen] = useState(false);
  const [draft, setDraft] = useState({ width: String(width), height: String(height) });
  // 外部尺寸改變（選了預設、專案重新載入）時，欄位跟著換成新值（render 時調整 state，React 允許）
  const [shown, setShown] = useState(`${width}x${height}`);
  if (shown !== `${width}x${height}`) {
    setShown(`${width}x${height}`);
    setDraft({ width: String(width), height: String(height) });
  }
  const custom = customOpen || preset === null;
  const draftWidth = Number(draft.width.trim() || Number.NaN);
  const draftHeight = Number(draft.height.trim() || Number.NaN);
  const problem = formatProblem(draftWidth, draftHeight);
  const dirty = draftWidth !== width || draftHeight !== height;

  const apply = (nextWidth: number, nextHeight: number) => {
    if (formatProblem(nextWidth, nextHeight) !== null) return;
    if (nextWidth !== width || nextHeight !== height) onChange(nextWidth, nextHeight);
  };
  const commitDraft = () => apply(draftWidth, draftHeight);

  const sideInput = (side: "width" | "height", label: string) => {
    // 只把有問題的那一邊標成不合法（原因在下方的訊息）
    const invalid = dirty && formatSideProblem(side === "width" ? draftWidth : draftHeight, label) !== null;
    return (
    <label className="grid min-w-0 gap-1 text-caption font-medium text-fg-secondary">
      {label}
      <Input
        id={`${id}-${side}`}
        compact
        inputMode="numeric"
        value={draft[side]}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={`${id}-rule${invalid ? ` ${id}-problem` : ""}`}
        onChange={(event) => setDraft({ ...draft, [side]: event.target.value })}
        onBlur={commitDraft}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commitDraft();
          }
        }}
        className="machine"
      />
    </label>
    );
  };

  return (
    <div className={cn("grid min-w-0 gap-1.5", className)}>
      <Select
        id={id}
        compact={compact}
        value={custom ? CUSTOM : (preset?.id ?? CUSTOM)}
        onChange={(event) => {
          if (event.target.value === CUSTOM) {
            setCustomOpen(true);
            return;
          }
          const next = FORMAT_PRESETS.find((item) => item.id === event.target.value);
          if (!next) return;
          setCustomOpen(false);
          apply(next.width, next.height);
        }}
      >
        {FORMAT_PRESETS.map((item) => (
          <option key={item.id} value={item.id}>
            {item.label}
          </option>
        ))}
        <option value={CUSTOM}>{preset === null ? t("自訂 {width}×{height}", { width, height }) : t("自訂…")}</option>
      </Select>
      {custom ? (
        <div className="grid min-w-0 gap-1.5 animate-fade-in">
          <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-1.5">
            {sideInput("width", t("寬度 px"))}
            <Button
              size="icon-sm"
              variant="quiet"
              aria-label={t("交換寬度與高度")}
              title={t("交換寬度與高度")}
              onClick={() => {
                setDraft({ width: draft.height, height: draft.width });
                apply(draftHeight, draftWidth);
              }}
              className="mb-px"
            >
              <ArrowLeftRight aria-hidden />
            </Button>
            {sideInput("height", t("高度 px"))}
          </div>
          <p id={`${id}-rule`} className="text-caption text-fg-tertiary">
            {t("寬高都必須是 {multiple} 的倍數、介於 {min}–{max}；按 Enter 或離開欄位後套用。", { multiple: FORMAT_SIDE.multiple, min: FORMAT_SIDE.min, max: FORMAT_SIDE.max })}
          </p>
          {dirty && problem ? (
            <p id={`${id}-problem`} role="alert" className="flex flex-wrap items-center gap-2 text-caption text-danger">
              {problem}
              <Button
                size="sm"
                variant="secondary"
                className="min-h-7 px-2"
                onClick={() => {
                  const next = { width: snapFormatSide(draftWidth), height: snapFormatSide(draftHeight) };
                  setDraft({ width: String(next.width), height: String(next.height) });
                  apply(next.width, next.height);
                }}
              >
                {t("改成 {width}×{height}", { width: snapFormatSide(draftWidth), height: snapFormatSide(draftHeight) })}
              </Button>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
