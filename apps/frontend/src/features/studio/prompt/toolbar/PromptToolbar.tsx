// The inline prompt editor's toolbar (one 36 px row), left to right: 範本 ▾ (templates, one click from the tab),
// 固定 Prompt ▾ (fixed prompts), @ 參考 (starts an @ name at the caret), 逐鏡描述 (only while the prompt has [Shot N]
// lines: the per-shot description dialog), 建議 n (the advisor: a panel under the button with
// the findings, their one-click fixes and a way to 修正與建議 in the professional editor), the caller's status badges
// (the shot's plugin check), ⋯ (格式化…, 區塊檢視) and, at the right
// end, 展開 (the professional editor). Narrower than its tools, it drops the icons of the labelled buttons and then
// wraps onto a second row, keeping the words (fit.ts, measured, so it holds for any language); only a row narrower than
// one tool gives up words, which then stay in the accessible names and tooltips (逐鏡描述 gives up its words with
// 固定 Prompt's). The two dropdowns open a ToolPopover under their button; the ⋯ menu is the shared action menu.
import { AtSign, BookMarked, ChevronDown, Ellipsis, LayoutList, LayoutTemplate, ListVideo, Maximize2, RemoveFormatting } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";
import type { StudioPromptSnippet } from "@/api/generated/contracts";
import { ActionMenu, MenuTriggerButton } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import type { MenuItem } from "@/components/ui/menuModel";
import { getLocale, t } from "@/i18n";
import { cn } from "@/lib/cn";
import { useFitLevel } from "@/lib/useFitLevel";
import type { PromptTemplate } from "../advisor";
import { TemplatePicker } from "../advisor/TemplatePicker";
import { AdvisorBadgeSlot, type AdvisorBadgeSlotProps, type PromptTask } from "../advisorSlot";
import { SnippetPicker } from "../SnippetPicker";
import { TOOL, TOOLBAR_FIT_LEVELS, ToolbarFitContext, toolbarFit, toolPadding } from "./fit";
import { ToolPopover } from "./ToolPopover";

type OpenPanel = { kind: "templates" | "snippets"; anchor: HTMLButtonElement } | null;

/** Popover content keeps the popover's glass: no card frame of its own. */
const IN_POPOVER = "border-0 bg-transparent p-0.5";

export interface PromptToolbarProps {
  view: "text" | "blocks";
  disabled: boolean;
  /** The prompt is empty (nothing to format). */
  empty: boolean;
  templates: readonly PromptTemplate[];
  mode: PromptTask | undefined;
  advisor: AdvisorBadgeSlotProps;
  /** The caller's status badges, after the advisor's. */
  status?: ReactNode;
  /** Changes when the status badges change what they show (the toolbar then measures its room again). */
  statusKey?: string;
  onInsertTemplate: (template: PromptTemplate) => void;
  /** Inserts a fixed prompt; false = it was not inserted (the picker stays open, the reason is shown). */
  onPickSnippet: (snippet: StudioPromptSnippet) => boolean;
  onManageSnippets: () => void;
  onMention: () => void;
  /** [Shot N] lines in the prompt; the 逐鏡描述 button shows only when there are some. */
  shotCount?: number;
  /** Opens the per-shot description dialog. */
  onShotDescriptions?: () => void;
  onFormat: () => void;
  onToggleView: () => void;
  onExpand: () => void;
}

export function PromptToolbar({
  view,
  disabled,
  empty,
  templates,
  mode,
  advisor,
  status,
  statusKey = "",
  onInsertTemplate,
  onPickSnippet,
  onManageSnippets,
  onMention,
  shotCount = 0,
  onShotDescriptions,
  onFormat,
  onToggleView,
  onExpand,
}: PromptToolbarProps) {
  const id = useId();
  const rowRef = useRef<HTMLDivElement>(null);
  const shots = shotCount > 0 && onShotDescriptions !== undefined;
  const level = useFitLevel(rowRef, TOOLBAR_FIT_LEVELS, `${getLocale()}\u0000${statusKey}\u0000${shots ? "shots" : ""}`);
  const fit = toolbarFit(level);
  const pad = toolPadding(fit);
  const [open, setOpen] = useState<OpenPanel>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLButtonElement | null>(null);
  const close = (restoreFocus: boolean) => {
    if (restoreFocus && open?.anchor.isConnected) open.anchor.focus();
    setOpen(null);
  };
  const toggle = (kind: "templates" | "snippets", anchor: HTMLButtonElement) => setOpen((current) => (current?.kind === kind ? null : { kind, anchor }));
  const panelId = (kind: "templates" | "snippets") => `${id}-${kind}`;
  const popup = (kind: "templates" | "snippets") => ({
    "aria-haspopup": "dialog" as const,
    "aria-expanded": open?.kind === kind,
    "aria-controls": open?.kind === kind ? panelId(kind) : undefined,
  });
  const disabledReason = disabled ? t("編輯器目前停用") : null;
  const menuItems: MenuItem[] = [
    { id: "format", label: t("格式化…"), icon: RemoveFormatting, disabledReason: disabledReason ?? (empty ? t("prompt 是空的") : null), onSelect: onFormat },
    { id: "view", label: view === "blocks" ? t("切回文字檢視") : t("區塊檢視"), icon: LayoutList, onSelect: onToggleView },
  ];

  return (
    <ToolbarFitContext.Provider value={fit}>
      <div
        ref={rowRef}
        role="group"
        aria-label={t("Prompt 工具")}
        data-fit={level}
        className={cn("flex min-w-0 shrink-0 items-center", fit.wrap ? "min-h-9 flex-wrap py-0.5" : "h-9", fit.tight ? "gap-0.5" : "gap-1")}
      >
        <Button
          size="sm"
          variant="quiet"
          className={cn(TOOL, pad)}
          icon={fit.icons ? <LayoutTemplate aria-hidden /> : undefined}
          disabled={disabled}
          title={t("從範本開始：分段格式、分鏡骨架與範例")}
          onClick={(event) => toggle("templates", event.currentTarget)}
          {...popup("templates")}
        >
          {t("範本")}
          <ChevronDown aria-hidden className="opacity-70" />
        </Button>
        <Button
          size="sm"
          variant="quiet"
          className={cn(TOOL, pad)}
          icon={fit.icons || !fit.snippetLabel ? <BookMarked aria-hidden /> : undefined}
          disabled={disabled}
          title={view === "blocks" ? t("插入固定 Prompt（區塊檢視：附加到最後）") : t("插入固定 Prompt 到游標位置")}
          onClick={(event) => toggle("snippets", event.currentTarget)}
          {...popup("snippets")}
        >
          <span className={fit.snippetLabel ? undefined : "sr-only"}>{t("固定 Prompt")}</span>
          <ChevronDown aria-hidden className="opacity-70" />
        </Button>
        <Button size="sm" variant="quiet" className={cn(TOOL, pad)} icon={<AtSign aria-hidden />} disabled={disabled} title={t("插入參考素材（也可以直接輸入 @）")} onClick={onMention}>
          <span className={fit.mentionLabel ? undefined : "sr-only"}>{t("參考")}</span>
        </Button>
        {shots ? (
          <Button
            size="sm"
            variant="quiet"
            className={cn(TOOL, pad, "animate-fade-in")}
            icon={fit.icons || !fit.snippetLabel ? <ListVideo aria-hidden /> : undefined}
            disabled={disabled}
            aria-haspopup="dialog"
            title={t("逐一寫每個鏡頭的描述：景別、角色與特徵（{count} 個鏡頭）", { count: shotCount })}
            onClick={onShotDescriptions}
          >
            <span className={fit.snippetLabel ? undefined : "sr-only"}>{t("逐鏡描述")}</span>
          </Button>
        ) : null}
        <AdvisorBadgeSlot {...advisor} />
        {status ? <span className="flex shrink-0 items-center">{status}</span> : null}
        <MenuTriggerButton
          menuId={`${id}-more`}
          open={menuAnchor !== null}
          label={t("更多動作")}
          onOpen={(element) => setMenuAnchor(element)}
          onClose={() => setMenuAnchor(null)}
          className="size-7 [&_svg]:size-3.5"
        >
          <Ellipsis aria-hidden />
        </MenuTriggerButton>
        <Button
          size="sm"
          variant="secondary"
          className={cn("ml-auto min-h-7 gap-1.5 [&_svg]:size-3.5", pad)}
          icon={fit.icons ? <Maximize2 aria-hidden /> : undefined}
          disabled={disabled}
          aria-label={t("展開專業 Prompt 編輯器")}
          title={t("展開專業 Prompt 編輯器（區塊、片段庫、參考）")}
          onClick={onExpand}
        >
          {t("展開")}
        </Button>
      </div>
      {menuAnchor ? (
        <ActionMenu id={`${id}-more`} label={t("更多動作")} items={menuItems} anchor={{ kind: "element", element: menuAnchor }} returnFocus={menuAnchor} onClose={() => setMenuAnchor(null)} />
      ) : null}
      {open?.kind === "templates" ? (
        <ToolPopover id={panelId("templates")} anchor={open.anchor} label={t("範本")} width={340} onClose={close}>
          <TemplatePicker
            id={`${id}-template-list`}
            templates={templates}
            mode={mode ?? null}
            insertBlockedReason={disabledReason}
            onInsert={(template) => {
              setOpen(null);
              onInsertTemplate(template);
            }}
            className={IN_POPOVER}
          />
        </ToolPopover>
      ) : null}
      {open?.kind === "snippets" ? (
        <ToolPopover id={panelId("snippets")} anchor={open.anchor} label={t("插入固定 Prompt")} width={340} onClose={close}>
          <SnippetPicker
            id={`${id}-snippet-list`}
            hint={view === "blocks" ? t("點選後附加到最後一段") : t("點選後插入到游標位置")}
            onPick={(snippet) => {
              if (onPickSnippet(snippet)) setOpen(null);
            }}
            onManage={() => {
              // The picker closes as the professional editor opens: its button takes the focus first, so closing the
              // editor returns there
              close(true);
              onManageSnippets();
            }}
            onClose={() => close(true)}
            className={IN_POPOVER}
          />
        </ToolPopover>
      ) : null}
    </ToolbarFitContext.Provider>
  );
}
