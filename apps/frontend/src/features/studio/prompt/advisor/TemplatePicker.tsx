// 範本清單：格式與分鏡骨架（依任務、片長與參考素材預先填好）與指南範例。名稱與說明是白話（會得到什麼、適合哪種鏡頭）；
// 依據的官方名稱（任務代號、段落名稱、指南章節）在提示文字與預覽裡，用比較淡的字。先預覽，再插入或複製。
// 外觀：面板內的群組卡（展開時 reveal）；清單列 hover 只改底色；「適合這個鏡頭」是 success 色的膠囊小籤。
import { focusOpenedControl } from "@/lib/dom";
import { ChevronLeft, Copy, FileText, FlaskConical, TextCursorInput } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { EXAMPLE_LABEL, EXAMPLE_NOTE } from "./examples";
import { templateHint, type PromptTemplate } from "./templates";
import type { PromptMode } from "./types";
import { MODE_FIT } from "./words";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

export interface TemplatePickerProps {
  id: string;
  templates: readonly PromptTemplate[];
  mode: PromptMode | null;
  /** 可以插入時的回呼；undefined＝只能複製。 */
  onInsert?: (template: PromptTemplate) => void;
  /** 編輯器停用等原因；null＝可以插入。 */
  insertBlockedReason: string | null;
  /** 複製範本文字；沒有提供時預覽不顯示「複製」（工具列的範本選單只插入）。 */
  onCopy?: (template: PromptTemplate) => void;
  /** 外框的 class（放進浮層時去掉卡片的邊框與底色）。 */
  className?: string;
}

/** 列的第二行：適合哪種鏡頭（符合目前鏡頭時是小籤）。 */
function FitLine({ template, mode }: { template: PromptTemplate; mode: PromptMode | null }) {
  const matches = mode !== null && template.modes?.includes(mode) === true;
  return (
    <span className="flex flex-wrap items-center gap-x-2 pl-5 text-caption text-fg-tertiary">
      {matches ? (
        <span className="rounded-full border border-success/35 bg-success/10 px-1.5 text-[11px] leading-4 text-success">{t("適合這個鏡頭")}</span>
      ) : (
        <span>{template.modes ? formatList(template.modes.map((item) => MODE_FIT[item]), { type: "disjunction", separator: "／" }) : t("任何鏡頭都適用")}</span>
      )}
      {(template.unavailable != null && template.unavailable !== "") ? <span>{template.unavailable}</span> : null}
    </span>
  );
}

function TemplateList({
  title,
  items,
  mode,
  onSelect,
  registerItem,
}: {
  title: string;
  items: readonly PromptTemplate[];
  mode: PromptMode | null;
  onSelect: (id: string) => void;
  registerItem: (id: string, node: HTMLButtonElement | null) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="grid gap-1">
      <p className="text-caption font-medium text-fg-tertiary">{title}</p>
      <ul className="grid gap-0.5">
        {items.map((template) => (
          <li key={template.id}>
            <button
              ref={(node) => { registerItem(template.id, node); }}
              type="button"
              title={templateHint(template)}
              onClick={() => { onSelect(template.id); }}
              className="grid w-full gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-(--duration-fast) hover:bg-raised/70 active:bg-sunken"
            >
              <span className="flex items-start gap-1.5 text-data text-fg">
                {template.example ? <FlaskConical aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" /> : <FileText aria-hidden className="mt-0.5 size-3.5 shrink-0 text-fg-tertiary" />}
                <span className="min-w-0 [overflow-wrap:anywhere]">{template.title}</span>
              </span>
              <FitLine template={template} mode={mode} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TemplatePicker({ id, templates, mode, onInsert, insertBlockedReason, onCopy, className }: TemplatePickerProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const itemsRef = useRef(new Map<string, HTMLButtonElement>());
  const returnToRef = useRef<string | null>(null);
  const selected = templates.find((template) => template.id === selectedId) ?? null;
  // 從預覽回到清單時，焦點回到剛才選的範本
  useEffect(() => {
    if (selectedId !== null || returnToRef.current === null) return;
    itemsRef.current.get(returnToRef.current)?.focus();
    returnToRef.current = null;
  }, [selectedId]);
  const registerItem = (templateId: string, node: HTMLButtonElement | null) => {
    if (node) itemsRef.current.set(templateId, node);
    else itemsRef.current.delete(templateId);
  };
  const back = () => {
    returnToRef.current = selectedId;
    setSelectedId(null);
  };
  if (selected) {
    const blocked = selected.unavailable ?? insertBlockedReason;
    return (
      <div id={id} role="group" aria-label={t("範本預覽：{title}", { title: selected.title })} className={cn("grid gap-2 rounded-lg border border-line-subtle bg-canvas/60 p-2 animate-reveal", className)}>
        <div className="flex flex-wrap items-start gap-2">
          <p className="min-w-0 flex-1 text-data font-medium text-fg [overflow-wrap:anywhere]">{selected.title}</p>
          {selected.example ? <Badge tone="warning">{EXAMPLE_LABEL}</Badge> : null}
        </div>
        <p className="text-caption leading-5 text-fg-secondary">{selected.description}</p>
        {selected.example ? <p className="text-caption leading-5 text-fg-tertiary">{EXAMPLE_NOTE}</p> : null}
        {(selected.official != null && selected.official !== "") ? <p className="text-caption leading-5 text-fg-tertiary [overflow-wrap:anywhere]">{t("依據：{source}", { source: selected.official })}</p> : null}
        {selected.text ? (
          <pre role="region"  /* eslint-disable-line jsx-a11y-x/no-noninteractive-tabindex -- Keyboard users can focus this scrollable region and scroll its overflow. */ tabIndex={0} aria-label={t("範本內容")} className="max-h-64 overflow-auto rounded-md border border-line-subtle bg-sunken p-2 font-sans text-caption leading-5 whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">
            {selected.text}
          </pre>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* Focus lands on the first action that works: 插入, else 複製, else back to the list */}
          <Button size="sm" variant="quiet" icon={<ChevronLeft aria-hidden />} onClick={back} className="mr-auto" ref={focusOpenedControl} data-initial-focus={(!onInsert || Boolean(blocked)) && !onCopy}>
            {t("範本清單")}
          </Button>
          {onCopy ? (
            <Button size="sm" variant="secondary" icon={<Copy aria-hidden />} disabled={!selected.text} onClick={() => { onCopy(selected); }} ref={focusOpenedControl} data-initial-focus={!onInsert || Boolean(blocked)}>
              {t("複製")}
            </Button>
          ) : null}
          {onInsert ? (
            <Button size="sm" variant="primary" icon={<TextCursorInput aria-hidden />} disabled={Boolean(blocked)} title={blocked ?? t("插入到 prompt（有標題的區塊附加在選取的區塊後面）")} onClick={() => { onInsert(selected); }} ref={focusOpenedControl} data-initial-focus={!(blocked != null && blocked !== "")}>
              {t("插入")}
            </Button>
          ) : null}
        </div>
        {(blocked != null && blocked !== "") ? <p className="text-right text-caption text-fg-tertiary">{t("無法插入：{blocked}", { blocked })}</p> : null}
      </div>
    );
  }
  return (
    <div id={id} role="group" aria-label={t("範本")} className={cn("grid gap-2 rounded-lg border border-line-subtle bg-canvas/60 p-2 animate-reveal", className)}>
      <TemplateList title={t("格式與分鏡骨架")} items={templates.filter((template) => !template.example)} mode={mode} onSelect={setSelectedId} registerItem={registerItem} />
      <TemplateList title={t("照著改寫的範例")} items={templates.filter((template) => template.example)} mode={mode} onSelect={setSelectedId} registerItem={registerItem} />
    </div>
  );
}
