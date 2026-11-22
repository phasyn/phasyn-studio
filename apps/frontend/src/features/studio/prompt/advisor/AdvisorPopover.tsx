// 工具列「建議」浮層的內容：目前的發現（錯誤、警告、建議；背景說明不列），每列是嚴重度圖示、一行標題、說明的第一句，
// 有真的修正時一顆修正按鈕：一鍵套用，編輯器下方留下可以復原的提示。最多列 MAX_ROWS 項；底部「在專業編輯器中查看全部」
// 打開專業編輯器的「修正與建議」分頁（完整說明與依據、預覽、會留下空段的改寫、範本）。
// 焦點：打開時落在清單上（不直接落在修正按鈕）；套用後移到狀態訊息（commit 之後才移）；Esc、Tab 出去與點外面由 ToolPopover 處理。
// Motion：清單逐項進場（motion.reveal），一列消失時其他列補位（useFlipList）；狀態訊息改變時淡入（useChangeFade）；
// 按鈕是共用的 pressable。
import { CircleCheck, Lightbulb, Maximize2, WandSparkles } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { reveal, useChangeFade, useFlipList } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { keyFindings } from "./analyze";
import { SEVERITY_STYLE } from "./severity";
import { firstSentence } from "./text";
import { SEVERITY_LABEL, type Finding } from "./types";
import { t } from "@/i18n";

/** 浮層最多列幾項（依嚴重度排序，其餘在專業編輯器）：1512×982 時浮層不必捲動。 */
const MAX_ROWS = 4;

export interface AdvisorPopoverProps {
  /** 目前的 prompt 全文（修正從這份文字重新找問題）。 */
  text: string;
  /** prompt 還是空的：不列發現。 */
  empty: boolean;
  /** 要列的發現（不含背景說明），已依嚴重度排序。 */
  issues: readonly Finding[];
  /** 不能套用的原因（編輯器停用）；null＝可以。 */
  blockedReason: string | null;
  /** 套用修正；false＝沒有套用（例如結果超過字數上限，原因由編輯器顯示）。 */
  onApplyFix: (nextText: string, label: string) => boolean;
  onOpenAll: () => void;
}

function IssueRow({ index, item, blockedReason, onApply }: { index: number; item: Finding; blockedReason: string | null; onApply: () => void }) {
  const style = SEVERITY_STYLE[item.severity];
  const Icon = style.icon;
  const sentence = firstSentence(item.detail);
  return (
    <li ref={reveal(index)} className="flex min-w-0 items-start gap-2 px-2.5 py-2">
      <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", style.tone)} />
      {/* minmax(0,1fr): the fix button's one-line label must not widen the column past the popover */}
      <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-0.5">
        <p className="line-clamp-2 text-data font-semibold text-fg [overflow-wrap:anywhere]" title={item.title}>
          <span className="sr-only">{t("{severity}：", { severity: SEVERITY_LABEL[item.severity] })}</span>
          {item.title}
        </p>
        <p className="line-clamp-2 text-caption text-fg-secondary [overflow-wrap:anywhere]" title={sentence}>
          {sentence}
        </p>
        {item.fix ? (
          <Button
            size="sm"
            variant="quiet"
            icon={<WandSparkles aria-hidden />}
            disabled={blockedReason !== null}
            title={blockedReason ?? item.fix.label}
            onClick={onApply}
            className="mt-0.5 min-h-7 max-w-full justify-self-start px-2 text-action-fg [&_svg]:size-3.5"
          >
            <span className="truncate">{item.fix.label}</span>
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function NoIssues() {
  return (
    <div className="grid gap-1">
      <p className="flex min-h-10 items-center gap-2 rounded-lg border border-success/30 bg-success/8 px-2.5 text-data text-success">
        <CircleCheck aria-hidden className="size-4 shrink-0" />
        {t("沒有發現問題")}
      </p>
      <p className="px-1 text-caption text-fg-tertiary">{t("規則只檢查格式與寫法；畫面是否如你所想，要看渲染的結果。")}</p>
    </div>
  );
}

export function AdvisorPopover({ text, empty, issues, blockedReason, onApplyFix, onOpenAll }: AdvisorPopoverProps) {
  const [status, setStatus] = useState("");
  const [focusStatus, setFocusStatus] = useState(0);
  const statusRef = useChangeFade<HTMLParagraphElement>(status);
  const listRef = useRef<HTMLUListElement>(null);
  const shown = keyFindings(issues.slice(0, MAX_ROWS));
  const hidden = issues.length - shown.length;
  // 套用修正後那一列消失，其他列從原來的位置滑上來（snappy 彈簧）
  useFlipList(listRef, shown.map(({ key }) => key).join("|"));

  // 打開時焦點落在清單（讀得到有幾項），再按 Tab 才到第一個修正：按住 Enter 打開浮層不會順手套用修正。
  // 子元件的 layout effect 先跑，ToolPopover 看到焦點已在裡面就不再移動；沒有清單時由它移到第一個按鈕。
  useLayoutEffect(() => {
    listRef.current?.focus({ preventScroll: true });
  }, []);

  // 套用後那一列（和它的按鈕）會消失：焦點移到狀態訊息
  useEffect(() => {
    if (focusStatus > 0) statusRef.current?.focus();
  }, [focusStatus, statusRef]);

  const apply = (item: Finding) => {
    if (!item.fix || (blockedReason != null && blockedReason !== "")) return;
    const next = item.fix.apply(text);
    const message =
      next === text
        ? t("目前的文字已經符合，不需要修改。")
        : onApplyFix(next, item.fix.label)
          ? t("已套用：{label}。要還原，按編輯器下方的「復原」。", { label: item.fix.label })
          : t("沒有套用：結果會超過字數上限。");
    setStatus(message);
    setFocusStatus((value) => value + 1);
  };

  return (
    <div className="grid gap-2.5 p-1">
      <p className="flex items-center gap-2 px-1 text-data font-semibold text-fg">
        <Lightbulb aria-hidden className="size-4 text-brand-cyan" />
        {t("修正與建議")}
        {issues.length > 0 ? <span className="machine text-caption font-normal text-fg-tertiary">{issues.length}</span> : null}
      </p>
      <p ref={statusRef} tabIndex={-1} role="status" aria-live="polite" className={cn("rounded-sm px-1 text-caption leading-5 text-fg-secondary", !status && "sr-only")}>
        {status}
      </p>
      {empty ? (
        <p className="px-1 text-data text-fg-secondary">{t("prompt 還是空的：寫了以後才檢查。也可以先用「範本」開始。")}</p>
      ) : shown.length === 0 ? (
        <NoIssues />
      ) : (
        <ul ref={listRef} tabIndex={-1} aria-label={t("目前的問題")} className="grid divide-y divide-line-subtle rounded-lg border border-line-subtle bg-canvas/60">
          {shown.map(({ key, item }, index) => (
            <IssueRow key={key} index={index} item={item} blockedReason={blockedReason} onApply={() => { apply(item); }} />
          ))}
        </ul>
      )}
      <Button size="sm" variant="secondary" icon={<Maximize2 aria-hidden />} className="justify-self-start" onClick={onOpenAll}>
        {hidden > 0 ? t("在專業編輯器中查看全部（還有 {count} 項）", { count: hidden }) : t("在專業編輯器中查看全部")}
      </Button>
    </div>
  );
}
