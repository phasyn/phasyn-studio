// 「修正與建議」面板的一列：嚴重度圖示、白話標題與依據類別，說明（長的先顯示三行）；「完整說明與依據」展開全文與出處，
// 「跳到」在編輯器選取原文。真的修正是「套用修正…」；會留下空段要填的改寫用它自己的名稱（例如「改成完整格式（會加上
// 要你填的空段）…」），兩者都先預覽差異，按「套用」才改字。
// 外觀：清單俐落、不發光；預覽以 reveal 出現；按鈕是共用的 pressable。
import { Crosshair, FilePenLine, WandSparkles } from "lucide-react";
import { useRef, useState, type ReactNode, type RefObject } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { FixPreview } from "./FixPreview";
import { SEVERITY_STYLE } from "./severity";
import { BASIS_DESCRIPTION, BASIS_LABEL, SEVERITY_LABEL, type Finding } from "./types";
import { t } from "@/i18n";

const BASIS_TONE = { official: "info", code: "file", guide: "neutral" } as const;

/** fix＝真的修正；action＝會留下空段的改寫。 */
export type ChangeKind = "fix" | "action";

export interface FindingRowProps {
  rowId: string;
  item: Finding;
  text: string;
  /** 正在預覽的改動；null＝沒有。 */
  open: ChangeKind | null;
  /** 不能套用的原因（編輯器停用）；null＝可以。 */
  blockedReason: string | null;
  canReveal: boolean;
  onToggle: (kind: ChangeKind) => void;
  onReveal: () => void;
  onApply: (kind: ChangeKind) => void;
}

function ChangeButton({
  rowId,
  buttonRef,
  open,
  label,
  title,
  icon,
  blockedReason,
  className,
  onClick,
}: {
  rowId: string;
  buttonRef: RefObject<HTMLButtonElement | null>;
  open: boolean;
  label: string;
  title: string;
  icon: ReactNode;
  blockedReason: string | null;
  className?: string;
  onClick: () => void;
}) {
  return (
    <Button
      ref={buttonRef}
      size="sm"
      variant={open ? "secondary" : "quiet"}
      className={cn("min-h-7 px-2", className)}
      icon={icon}
      aria-expanded={open}
      aria-controls={open ? `${rowId}-preview` : undefined}
      disabled={blockedReason !== null}
      title={blockedReason ?? t("先預覽：{label}", { label: title })}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}

export function FindingRow({ rowId, item, text, open, blockedReason, canReveal, onToggle, onReveal, onApply }: FindingRowProps) {
  const [expanded, setExpanded] = useState(false);
  const fixRef = useRef<HTMLButtonElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const style = SEVERITY_STYLE[item.severity];
  const Icon = style.icon;
  const long = item.detail.length > 90;
  const change = open === "fix" ? item.fix : open === "action" ? item.action : undefined;
  const after = change ? change.apply(text) : null;
  return (
    <li className="grid gap-1.5 border-t border-line-subtle py-2.5 first:border-t-0">
      <div className="flex items-start gap-2">
        <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", style.tone)} />
        <p className="min-w-0 flex-1 text-data leading-5 font-medium text-fg [overflow-wrap:anywhere]">
          <span className="sr-only">{t("{severity}：", { severity: SEVERITY_LABEL[item.severity] })}</span>
          {item.title}
        </p>
        <Badge tone={BASIS_TONE[item.basis]} title={BASIS_DESCRIPTION[item.basis]}>
          {BASIS_LABEL[item.basis]}
        </Badge>
      </div>
      <div className="grid gap-1 pl-6">
        <p id={`${rowId}-detail`} className={cn("text-caption leading-5 text-fg-secondary [overflow-wrap:anywhere]", long && !expanded && "line-clamp-3")}>
          {item.detail}
        </p>
        {expanded && item.source ? <p className="text-caption leading-5 text-fg-tertiary [overflow-wrap:anywhere] animate-reveal">{t("依據：{source}", { source: item.source })}</p> : null}
        <div className="flex flex-wrap items-center gap-1">
          {long || item.source ? (
            <Button size="sm" variant="quiet" className="min-h-7 px-2" aria-expanded={expanded} aria-controls={`${rowId}-detail`} onClick={() => setExpanded((value) => !value)}>
              {expanded ? t("收合說明") : t("完整說明與依據")}
            </Button>
          ) : null}
          {item.range && canReveal ? (
            <Button size="sm" variant="quiet" className="min-h-7 px-2" icon={<Crosshair aria-hidden />} onClick={onReveal} title={t("在編輯器選取這段文字")}>
              {t("跳到")}
            </Button>
          ) : null}
          {item.fix ? (
            <ChangeButton
              rowId={rowId}
              buttonRef={fixRef}
              open={open === "fix"}
              label={t("套用修正…")}
              title={item.fix.label}
              icon={<WandSparkles aria-hidden />}
              blockedReason={blockedReason}
              onClick={() => onToggle("fix")}
            />
          ) : null}
          {item.action ? (
            <ChangeButton
              rowId={rowId}
              buttonRef={actionRef}
              open={open === "action"}
              label={`${item.action.label}…`}
              title={item.action.label}
              icon={<FilePenLine aria-hidden />}
              blockedReason={blockedReason}
              className="h-auto max-w-full text-left whitespace-normal"
              onClick={() => onToggle("action")}
            />
          ) : null}
        </div>
        {change && open && after !== null ? (
          <FixPreview
            id={`${rowId}-preview`}
            label={change.label}
            before={text}
            after={after}
            blockedReason={blockedReason}
            onConfirm={() => onApply(open)}
            onCancel={() => {
              onToggle(open);
              (open === "fix" ? fixRef : actionRef).current?.focus();
            }}
          />
        ) : null}
      </div>
    </li>
  );
}
