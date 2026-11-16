import { ChevronDown, type LucideIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { CopyButton } from "@/components/common/values";
import { cn } from "@/lib/cn";
import { TILE_TONE, type Tone } from "./tones";
import { t } from "@/i18n";

/** Inspector 的物件標頭：40 px 類型圖示磚、16 px 名稱＋狀態 chip、一行說明、ID＋複製，下方可放動作。 */
export function EntityHeader({
  icon: Icon,
  tone,
  art,
  title,
  status,
  description,
  id,
  actions,
  className,
}: {
  icon: LucideIcon;
  tone: Tone;
  /** 客製圖示（透明 PNG）；有值時取代 icon。 */
  art?: string;
  title: ReactNode;
  status?: ReactNode;
  description?: ReactNode;
  /** 原始 ID（mono＋複製）。 */
  id?: string | null;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid shrink-0 gap-2.5 border-b border-line-subtle px-3 py-3", className)}>
      <div className="flex min-w-0 gap-3">
        <span aria-hidden className={cn("grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg border", TILE_TONE[tone])}>
          {art ? <img src={art} alt="" className="size-8 object-contain" draggable={false} /> : <Icon className="size-5" />}
        </span>
        <div className="grid min-w-0 flex-1 content-start gap-0.5">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <h2 className="min-w-0 text-section font-semibold [overflow-wrap:anywhere] text-fg">{title}</h2>
            {status ? <span className="mt-0.5 shrink-0">{status}</span> : null}
          </div>
          {description ? <div className="text-caption text-fg-secondary">{description}</div> : null}
          {id ? (
            <div className="flex min-w-0 items-center gap-1 text-caption">
              <span className="machine truncate text-fg-tertiary" title={id}>
                {id}
              </span>
              <CopyButton value={id} label={t("複製 ID")} />
            </div>
          ) : null}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-1.5">{actions}</div> : null}
    </div>
  );
}

/**
 * 可收合的屬性區段（APG accordion：h3 內的按鈕＋aria-expanded）。高度以 grid-template-rows 0fr→1fr 的 smooth 彈簧展開／收合，
 * 箭頭以 snappy 彈簧旋轉；收合時內容立即 inert（不能聚焦、輔助技術讀不到），不等動畫。
 */
export function PropertySection({
  title,
  icon,
  count,
  defaultOpen = true,
  open: controlledOpen,
  onOpenChange,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title: ReactNode;
  icon?: ReactNode;
  count?: number | null;
  defaultOpen?: boolean;
  /** 受控模式（例如「跳到問題欄位」時需要展開）。 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean) => {
    setLocalOpen(next);
    onOpenChange?.(next);
  };
  const bodyId = useId();
  return (
    <section className={cn("border-b border-line-subtle last:border-b-0", className)}>
      <div className="flex h-9 items-center gap-1 px-1.5">
        <h3 className="min-w-0 flex-1">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen(!open)}
            className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left text-data font-semibold text-fg transition-colors duration-(--duration-fast) hover:bg-raised active:bg-sunken active:duration-0 [&_svg]:shrink-0"
          >
            <ChevronDown aria-hidden className={cn("size-3.5 text-fg-tertiary transition-[rotate] duration-(--duration-spring-snappy) ease-(--ease-spring-snappy)", !open && "-rotate-90")} />
            {icon ? <span className="flex text-fg-tertiary [&_svg]:size-3.5">{icon}</span> : null}
            <span className="truncate">{title}</span>
            {count !== undefined && count !== null ? <span className="machine text-caption font-normal text-fg-tertiary">{count}</span> : null}
          </button>
        </h3>
        {actions ? <div className="flex shrink-0 items-center gap-0.5">{actions}</div> : null}
      </div>
      <div
        id={bodyId}
        inert={!open}
        className={cn("grid transition-[grid-template-rows] duration-(--duration-spring-smooth) ease-(--ease-spring-smooth)", open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}
      >
        <div className="min-h-0 overflow-hidden">
          <div className={cn("px-3 pb-3", bodyClassName)}>{children}</div>
        </div>
      </div>
    </section>
  );
}

/** label／值兩欄的屬性格（label 欄 104–120 px）。 */
export function PropertyGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid grid-cols-[minmax(6.5rem,7.5rem)_minmax(0,1fr)] items-start gap-x-3 gap-y-1", className)}>{children}</div>;
}

/** 屬性列：控制項用 htmlFor 連到 label；純顯示值不需要。full＝值跨兩欄（長文字、表格）。 */
export function PropertyRow({
  label,
  htmlFor,
  hint,
  children,
  full = false,
  mono = false,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
  full?: boolean;
  mono?: boolean;
}) {
  const value = (
    <div className={cn("flex min-h-8 min-w-0 flex-col justify-center gap-0.5 text-data text-fg [overflow-wrap:anywhere]", mono && "machine", full && "col-span-2")}>
      {children}
      {hint ? <span className="font-sans text-caption text-fg-tertiary">{hint}</span> : null}
    </div>
  );
  return (
    <>
      <div className={cn("flex min-h-8 items-center text-data text-fg-tertiary", full && "col-span-2 min-h-6")}>
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
      </div>
      {value}
    </>
  );
}

/** 固定在 Inspector 底部的動作列（主要＋次要動作與一行狀態說明）。 */
export function InspectorFooter({ children, note, className }: { children: ReactNode; note?: ReactNode; className?: string }) {
  return (
    <div className={cn("grid shrink-0 gap-1.5 border-t border-line-subtle bg-surface px-3 py-2.5", className)}>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      {note ? <div className="text-caption text-fg-tertiary">{note}</div> : null}
    </div>
  );
}
