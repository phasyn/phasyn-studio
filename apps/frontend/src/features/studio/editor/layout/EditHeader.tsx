// The header of the Edit workspace (one 48 px row): the task-layout switcher, the sequence and its format, undo and
// redo, the shortcut list and the primary Export button.
import { Keyboard, Redo2, Undo2 } from "lucide-react";
import { useRef } from "react";
import { ActiveIndicator } from "@/components/ui/active-indicator";
import { Button } from "@/components/ui/button";
import { TOOL_BUTTON } from "@/components/ui/look";
import { StableLabel } from "@/components/ui/stable-label";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { detectApplePlatform, modifierLabel } from "@/lib/keyboard";
import { ExportDialog } from "../../components/ExportDialog";
import { exportGeometry } from "../../model/project";
import { openShortcuts } from "../../model/shortcuts";
import { useEditor } from "../editorContext";
import { EDIT_LAYOUTS, type EditLayout, type EditLayoutId } from "./layouts";

function LayoutSwitcher({ layout, onChange }: { layout: EditLayout; onChange: (id: EditLayoutId) => void }) {
  const list = useRef<HTMLDivElement>(null);
  const pick = (index: number) => {
    const next = EDIT_LAYOUTS[(index + EDIT_LAYOUTS.length) % EDIT_LAYOUTS.length];
    if (!next) return;
    onChange(next.id);
    list.current?.querySelector<HTMLElement>(`[data-layout="${next.id}"]`)?.focus();
  };
  return (
    <div ref={list} role="radiogroup" aria-label={t("工作配置")} className="relative flex h-9 shrink-0 items-stretch gap-0.5 rounded-lg border border-line-subtle bg-sunken/60 p-0.5">
      {EDIT_LAYOUTS.map((item, index) => {
        const selected = item.id === layout.id;
        return (
          <button
            key={item.id}
            type="button"
            role="radio"
            data-layout={item.id}
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") pick(index + 1);
              else if (event.key === "ArrowLeft" || event.key === "ArrowUp") pick(index - 1);
              else return;
              event.preventDefault();
            }}
            className={cn(
              "pressable relative inline-flex items-center gap-1.5 rounded-md px-3 text-body whitespace-nowrap transition-colors duration-(--duration-fast) [&_svg]:size-4",
              selected ? "bg-brand-gradient-soft font-semibold text-fg ring-1 ring-brand-blue/45 ring-inset [&_svg]:text-brand-cyan" : "text-fg-secondary hover:bg-raised/80 hover:text-fg",
            )}
          >
            <item.icon aria-hidden />
            <StableLabel weight="semibold">{item.label}</StableLabel>
          </button>
        );
      })}
      <ActiveIndicator container={list} edge="bottom" inset={10} selector='[role="radio"][aria-checked="true"]' className="bg-brand-gradient forced-colors:bg-none" />
    </div>
  );
}

export function EditHeader({ layout, onLayout }: { layout: EditLayout; onLayout: (id: EditLayoutId) => void }) {
  const editor = useEditor();
  const { project, timeline, historyDepth } = editor;
  const geometry = exportGeometry(project);
  const fps = timeline.fps.num / timeline.fps.den;
  const mod = modifierLabel("Mod", detectApplePlatform());
  return (
    <div data-keep-focus="" className="flex h-12 shrink-0 items-center gap-3 px-2">
      <LayoutSwitcher layout={layout} onChange={onLayout} />
      {/* The sequence name takes the room between the switcher and the actions and shortens before it would overlap them */}
      <p className="hidden min-w-0 flex-1 items-center justify-center gap-2 text-data text-fg-tertiary min-[1400px]:flex">
        <span className="min-w-0 max-w-64 truncate text-fg-secondary" title={project.title}>
          {project.title}
        </span>
        <span className="machine shrink-0 text-caption">
          {t("{width}×{height}・{fps} fps", { width: geometry.width, height: geometry.height, fps: Number.isInteger(fps) ? fps : fps.toFixed(2) })}
        </span>
      </p>
      <div className="ml-auto flex shrink-0 items-center justify-end gap-1.5">
        <button type="button" className={cn(TOOL_BUTTON, "size-9 [&_svg]:size-4")} disabled={!editor.canUndo} aria-label={t("復原")} title={t("復原（{mod}+Z）・可復原 {steps} 步", { mod, steps: historyDepth.undo })} onClick={editor.undo}>
          <Undo2 aria-hidden />
        </button>
        <button type="button" className={cn(TOOL_BUTTON, "size-9 [&_svg]:size-4")} disabled={!editor.canRedo} aria-label={t("重做")} title={t("重做（{mod}+Shift+Z）・可重做 {steps} 步", { mod, steps: historyDepth.redo })} onClick={editor.redo}>
          <Redo2 aria-hidden />
        </button>
        <span aria-hidden className="mx-1 h-5 w-px bg-line-subtle" />
        <Button size="sm" variant="secondary" icon={<Keyboard aria-hidden />} onClick={openShortcuts} title={t("鍵盤快速鍵（?）")}>
          {t("快速鍵")}
        </Button>
        <ExportDialog primary />
      </div>
    </div>
  );
}
