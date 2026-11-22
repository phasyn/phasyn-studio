// The tools of the timeline as a vertical strip (44 px wide, 36 px buttons): the tool decides what dragging a clip or
// an edge does. Tooltips read "名稱（鍵）"; the current tool carries the brand fill. In a short window the strip scrolls
// inside itself (every tool also has its key) instead of making the timeline row taller than the window.
import { ArrowLeftRight, MousePointer2, MoveHorizontal, Scissors, SplitSquareHorizontal, StretchHorizontal, Type, type LucideIcon } from "lucide-react";
import { TOOL_BUTTON, TOOL_BUTTON_ON } from "@/components/ui/look";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { useEditor } from "../editorContext";
import { chordOf, type EditorCommandId } from "../keymap";
import type { EditorTool } from "../useEditorState";

const TOOLS: readonly { id: EditorTool; label: string; icon: LucideIcon; command: EditorCommandId }[] = [
  { id: "select", label: t("選取工具"), icon: MousePointer2, command: "toolSelect" },
  { id: "ripple", label: t("波紋編輯工具"), icon: StretchHorizontal, command: "toolRipple" },
  { id: "roll", label: t("滾動編輯工具"), icon: SplitSquareHorizontal, command: "toolRoll" },
  { id: "razor", label: t("剃刀工具"), icon: Scissors, command: "toolRazor" },
  { id: "slip", label: t("外滑工具"), icon: MoveHorizontal, command: "toolSlip" },
  { id: "slide", label: t("內滑工具"), icon: ArrowLeftRight, command: "toolSlide" },
];

export function ToolsStrip({ className }: { className?: string }) {
  const editor = useEditor();
  return (
    <div role="toolbar" aria-orientation="vertical" aria-label={t("時間軸工具")} data-keep-focus="" className={cn(
        "flex min-h-0 w-11 shrink-0 flex-col items-center gap-1 overflow-y-auto overscroll-contain rounded-xl border border-line-subtle bg-surface py-1.5 shadow-edge [scrollbar-width:none]",
        className,
      )}>
      {TOOLS.map((tool) => (
        <button
          key={tool.id}
          type="button"
          aria-label={tool.label}
          aria-pressed={editor.tool === tool.id}
          title={t("{label}（{shortcut}）", { label: tool.label, shortcut: chordOf(tool.command) })}
          onClick={() => { editor.setTool(tool.id); }}
          className={cn(TOOL_BUTTON, "size-9 shrink-0 [&_svg]:size-4", editor.tool === tool.id && cn(TOOL_BUTTON_ON, "shadow-glow-sm"))}
        >
          <tool.icon aria-hidden />
        </button>
      ))}
      <span aria-hidden className="my-0.5 h-px w-6 shrink-0 bg-line-subtle" />
      <button type="button" aria-label={t("新增文字圖層")} title={t("{label}（{shortcut}）", { label: t("新增文字圖層"), shortcut: chordOf("addText") })} onClick={editor.addTextLayer} className={cn(TOOL_BUTTON, "size-9 shrink-0 [&_svg]:size-4")}>
        <Type aria-hidden />
      </button>
    </div>
  );
}
