// 「Prompt 修正與建議」面板（放在專業 Prompt 編輯器的側欄分頁）：依嚴重度分組列出發現（FindingRow），每項用白話說哪裡有問題、
// 要怎麼做，出處收在「完整說明與依據」；「跳到」選取原文，修正與會留下空段的改寫都先預覽差異再套用；範本與「複製改寫指令」。
// 不連網、不自動改字；「沒有發現問題」只代表規則沒有偵測到，不代表 prompt 一定能生成預期畫面。
// 面板本身不捲動：由外層容器（編輯器側欄）負責捲動。
// 外觀：嚴重度是膠囊小籤（顏色只表示嚴重度，一律配圖示與文字）；清單俐落、不發光；展開的範本與預覽以 reveal 出現。
import { ClipboardCopy, LayoutTemplate, ListChecks, LoaderCircle } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { StudioLibraryItem, StudioReference } from "@/api/generated/contracts";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common/EmptyState";
import { cn } from "@/lib/cn";
import { TOOL_BUTTON_ON } from "@/components/ui/look";
import { analyzePrompt, countBySeverity, keyFindings, type KeyedFinding } from "./analyze";
import { copyText } from "./clipboard";
import { FindingRow, type ChangeKind } from "./FindingRow";
import { buildRewriteRequest } from "./rewrite";
import { SEVERITY_STYLE } from "./severity";
import { TemplatePicker } from "./TemplatePicker";
import { promptTemplates, type PromptTemplate } from "./templates";
import { clipTiming, explainClip, formatShortSeconds } from "./timing";
import { MODE_LABEL, MODE_OFFICIAL, SEVERITY_LABEL, SEVERITY_ORDER, type Finding, type PromptMode } from "./types";
import { useAdvisorFindings } from "./useAdvisorFindings";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

export interface PromptAdvisorPanelProps {
  /** 目前的 prompt 全文。 */
  text: string;
  /** 鏡頭的 H3 任務（運算路由的 capability）；undefined／null＝未知，只做與任務無關的檢查。 */
  mode?: PromptMode | null;
  /** 鏡頭影格數（24 fps）；0＝未知。 */
  frames: number;
  references: readonly StudioReference[];
  library: readonly StudioLibraryItem[];
  /** 有首幀（I2VA）；省略時 fl2va 視為有首幀。 */
  firstFrame?: boolean;
  /** 套用修正或改寫：以新的全文取代（呼叫端負責儲存與復原提示）；label 是改了什麼。 */
  onApplyFix: (nextText: string, label: string) => void;
  /** 在編輯器選取並捲動到 [start, end)。 */
  onRevealRange?: (start: number, end: number) => void;
  /** 插入範本；沒有提供時範本只能複製。 */
  onInsertTemplate?: (text: string) => void;
  /** 編輯器停用：可以看，不能套用或插入。 */
  disabled?: boolean;
}

const DISABLED_REASON = t("編輯器目前停用");
const CLIPBOARD_REFUSED = t("瀏覽器不允許寫入剪貼簿：已選取下面的文字，請按 Ctrl+C（macOS：⌘C）複製。");

/** 標題下的一行事實：方式、片長、參考數（正式名稱與精確片長在提示文字）。 */
function ShotFacts({ mode, frames, references }: { mode: PromptMode | null; frames: number; references: number }) {
  const timing = clipTiming(frames);
  return (
    <dl className="flex flex-wrap gap-x-3 gap-y-0.5 text-caption text-fg-tertiary">
      <div className="flex gap-1">
        <dt>{t("方式")}</dt>
        <dd className="text-fg-secondary" title={mode ? MODE_OFFICIAL[mode] : undefined}>
          {mode ? MODE_LABEL[mode] : t("未知")}
        </dd>
      </div>
      <div className="flex gap-1">
        <dt>{t("片長")}</dt>
        <dd className="machine text-fg-secondary" title={timing ? explainClip(timing) : undefined}>
          {timing ? t("{seconds} 秒", { seconds: formatShortSeconds(timing.seconds) }) : t("未知")}
        </dd>
      </div>
      <div className="flex gap-1">
        <dt>{t("參考")}</dt>
        <dd className="machine text-fg-secondary">{references}</dd>
      </div>
    </dl>
  );
}

export function PromptAdvisorPanel({ text, mode = null, frames, references, library, firstFrame, onApplyFix, onRevealRange, onInsertTemplate, disabled = false }: PromptAdvisorPanelProps) {
  const id = useId();
  const { findings, stale } = useAdvisorFindings({ text, mode, frames, references, library, firstFrame });
  const keyed = useMemo(() => keyFindings(findings), [findings]);
  const counts = countBySeverity(findings);
  const templates = useMemo(() => promptTemplates({ mode, frames, references, library }), [mode, frames, references, library]);
  const [open, setOpen] = useState<{ key: string; kind: ChangeKind } | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [copyPending, setCopyPending] = useState(false);
  const [fallback, setFallback] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [focusStatus, setFocusStatus] = useState(0);
  const statusRef = useRef<HTMLParagraphElement>(null);

  // 套用或插入之後，原本的按鈕可能消失：焦點移到狀態訊息（commit 之後才移）
  useEffect(() => {
    if (focusStatus > 0) statusRef.current?.focus();
  }, [focusStatus]);

  const announce = (message: string, moveFocus = false) => {
    setStatus(message);
    if (moveFocus) setFocusStatus((value) => value + 1);
  };

  const apply = (item: Finding, kind: ChangeKind) => {
    const change = kind === "fix" ? item.fix : item.action;
    if (!change || disabled) return;
    const next = change.apply(text);
    setOpen(null);
    if (next === text) {
      announce(t("目前的文字已經符合，不需要修改。"), true);
      return;
    }
    onApplyFix(next, change.label);
    announce(t("已套用：{label}。可以在編輯器復原。", { label: change.label }), true);
  };

  const reveal = (item: Finding) => {
    if (!onRevealRange || !item.range) return;
    let range = item.range;
    if (stale) {
      // 分析的是前一版文字：重新找一次同一個發現的位置
      const fresh = analyzePrompt({ text, mode, frames, references, library, firstFrame }).filter((other) => other.id === item.id);
      const match = fresh.find((other) => other.title === item.title) ?? fresh[0];
      if (match?.range) range = match.range;
    }
    onRevealRange(Math.min(range.start, text.length), Math.min(range.end, text.length));
  };

  const copyRequest = async () => {
    if (copyPending) return;
    const request = buildRewriteRequest({ text, mode, frames, references, library, firstFrame });
    setCopyPending(true);
    const ok = await copyText(request);
    setCopyPending(false);
    setFallback(ok ? null : request);
    announce(ok ? t("已複製改寫指令（{requestCount} 字元）：貼到你慣用的 LLM，改寫的結果請自己看過再用。", { requestCount: request.length.toLocaleString("en-US") }) : CLIPBOARD_REFUSED);
  };

  const copyTemplate = async (template: PromptTemplate) => {
    const ok = await copyText(template.text);
    setFallback(ok ? null : template.text);
    announce(ok ? t("已複製範本「{title}」。", { title: template.title }) : CLIPBOARD_REFUSED);
  };

  const insertTemplate = (template: PromptTemplate) => {
    if (!onInsertTemplate || disabled || template.unavailable) return;
    onInsertTemplate(template.text);
    setTemplatesOpen(false);
    announce(t("已插入範本「{title}」。", { title: template.title }), true);
  };

  const issues = findings.filter((item) => item.severity !== "info").length;
  const renderRows = (items: readonly KeyedFinding[]) => (
    <ul className="grid">
      {items.map(({ key, item }) => (
        <FindingRow
          key={key}
          rowId={`${id}-${key.replace(/[^A-Za-z0-9-]/g, "-")}`}
          item={item}
          text={text}
          open={open?.key === key ? open.kind : null}
          blockedReason={disabled ? DISABLED_REASON : null}
          canReveal={Boolean(onRevealRange)}
          onToggle={(kind) => setOpen((current) => (current?.key === key && current.kind === kind ? null : { key, kind }))}
          onReveal={() => reveal(item)}
          onApply={(kind) => apply(item, kind)}
        />
      ))}
    </ul>
  );

  return (
    <section aria-labelledby={`${id}-title`} aria-busy={stale || undefined} className="grid min-w-0 gap-3 p-3">
      <header className="grid gap-2">
        <div className="flex items-center gap-2">
          <h2 id={`${id}-title`} className="text-data font-semibold text-fg">
            {t("Prompt 修正與建議")}
          </h2>
          {stale ? <LoaderCircle aria-hidden className="size-3.5 text-fg-tertiary animate-spin" /> : null}
          <span className="sr-only">{stale ? t("分析中") : ""}</span>
        </div>
        <ShotFacts mode={mode} frames={frames} references={references.length} />
        <p className="sr-only">{formatList(SEVERITY_ORDER.map((severity) => t("{severity} {counts} 項", { severity: SEVERITY_LABEL[severity], counts: counts[severity] })))}</p>
        <p aria-hidden className="flex flex-wrap gap-1.5 text-caption text-fg-secondary">
          {SEVERITY_ORDER.map((severity) => {
            const Icon = SEVERITY_STYLE[severity].icon;
            return (
              <span
                key={severity}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5",
                  counts[severity] > 0 ? "border-line bg-raised/60" : "border-line-subtle text-fg-tertiary",
                )}
              >
                <Icon className={cn("size-3.5", SEVERITY_STYLE[severity].tone)} />
                {SEVERITY_LABEL[severity]}
                <span className={cn("machine", counts[severity] > 0 ? "text-fg" : "text-fg-tertiary")}>{counts[severity]}</span>
              </span>
            );
          })}
        </p>
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="quiet"
            className={cn("min-h-7 px-2", templatesOpen && TOOL_BUTTON_ON)}
            icon={<LayoutTemplate aria-hidden />}
            aria-expanded={templatesOpen}
            aria-controls={templatesOpen ? `${id}-templates` : undefined}
            onClick={() => setTemplatesOpen((value) => !value)}
          >
            {t("範本")}
          </Button>
          <Button
            size="sm"
            variant="quiet"
            className="min-h-7 px-2"
            icon={<ClipboardCopy aria-hidden />}
            pending={copyPending}
            title={t("把整理成英文結構稿需要的說明、這個鏡頭的長度與參考素材，和目前的 prompt 一起複製，貼到你慣用的 LLM（這裡不會連網）")}
            onClick={() => void copyRequest()}
          >
            {t("複製改寫指令")}
          </Button>
        </div>
        {templatesOpen ? (
          <TemplatePicker
            id={`${id}-templates`}
            templates={templates}
            mode={mode}
            onInsert={onInsertTemplate ? insertTemplate : undefined}
            insertBlockedReason={disabled ? DISABLED_REASON : null}
            onCopy={(template) => void copyTemplate(template)}
          />
        ) : null}
        <p ref={statusRef} tabIndex={-1} role="status" aria-live="polite" className={cn("rounded-sm text-caption leading-5 text-fg-secondary", !status && "sr-only")}>
          {status}
        </p>
        {fallback !== null ? (
          <div className="grid gap-1.5">
            <textarea
              readOnly
              autoFocus
              rows={6}
              value={fallback}
              aria-label={t("要複製的文字")}
              onFocus={(event) => event.currentTarget.select()}
              className="w-full resize-y rounded-lg border border-line-control bg-sunken px-2 py-1.5 font-sans text-caption leading-5 text-fg"
            />
            <Button size="sm" variant="quiet" className="min-h-7 justify-self-end px-2" onClick={() => setFallback(null)}>
              {t("關閉")}
            </Button>
          </div>
        ) : null}
      </header>

      {issues === 0 ? (
        <EmptyState
          size="compact"
          icon={<ListChecks />}
          title={t("沒有發現問題")}
          description={t("規則沒有找到格式或寫法上的問題。這不保證畫面會如你所想：渲染後看看動作是不是一開場就動、碰撞清不清楚、切鏡和聲音有沒有對上。")}
          className="px-3"
        />
      ) : null}

      {SEVERITY_ORDER.map((severity) => {
        const items = keyed.filter(({ item }) => item.severity === severity);
        if (items.length === 0) return null;
        const Icon = SEVERITY_STYLE[severity].icon;
        const heading = (
          <span className="inline-flex items-center gap-1.5">
            <Icon aria-hidden className={cn("size-4", SEVERITY_STYLE[severity].tone)} />
            {SEVERITY_LABEL[severity]}
            <span className="machine text-fg-tertiary">{items.length}</span>
          </span>
        );
        if (severity === "info") {
          return (
            <details key={severity} className="group min-w-0 border-t border-line-subtle pt-2">
              <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-sm text-data font-semibold text-fg-secondary hover:text-fg [&::-webkit-details-marker]:hidden">
                {heading}
                <span className="text-caption font-normal text-fg-tertiary">{t("背景說明")}</span>
              </summary>
              {renderRows(items)}
            </details>
          );
        }
        return (
          <section key={severity} aria-labelledby={`${id}-${severity}`} className="grid min-w-0 gap-1 border-t border-line-subtle pt-2">
            <h3 id={`${id}-${severity}`} className="text-data font-semibold text-fg">
              {heading}
            </h3>
            {renderRows(items)}
          </section>
        );
      })}

      <footer className="border-t border-line-subtle pt-2 text-caption leading-5 text-fg-tertiary">
        {t("這些建議依據 MiniMax 官方的 prompt 寫法、這台機器上生成程式的實際行為，以及 Phasyn Studio 的寫作指南（指南的建議還沒有用生成結果驗證）；每一項的出處在「完整說明與依據」。檢查在瀏覽器裡進行，不連網，也不會自己改你的文字。")}
      </footer>
    </section>
  );
}
