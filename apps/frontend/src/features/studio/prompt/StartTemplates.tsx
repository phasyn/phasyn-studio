// The empty editor's start: the most relevant templates (templateInsert.startTemplates, at most three) as big buttons in
// the middle of the field; one click fills the prompt. Each says in plain words what it gives and when to use it (two
// lines at most; the tooltip has the whole description and the official names it is based on). They lie over the empty
// textarea without taking its clicks (the space around them still puts the caret in the field), follow it in the tab
// order and leave as soon as there is text.
// Motion: the buttons rise in one after another (motion.reveal); a press is the shared pressable spring.
import { LayoutTemplate } from "lucide-react";
import { CHOICE_BASE, CHOICE_IDLE } from "@/components/ui/look";
import { reveal } from "@/components/ui/motion";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { templateHint, type PromptTemplate } from "./advisor";

export function StartTemplates({ templates, disabled, onPick }: { templates: readonly PromptTemplate[]; disabled: boolean; onPick: (template: PromptTemplate) => void }) {
  if (templates.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-[2] grid place-items-center overflow-hidden p-4">
      <div role="group" aria-label={t("從範本開始")} className="pointer-events-auto grid w-full max-w-96 gap-1.5">
        <p className="flex items-center justify-center gap-1.5 text-caption text-fg-tertiary">
          <LayoutTemplate aria-hidden className="size-3.5" />
          {t("從範本開始")}
        </p>
        {templates.map((template, index) => (
          <button
            key={template.id}
            ref={reveal(index)}
            type="button"
            disabled={disabled}
            title={templateHint(template)}
            onClick={() => onPick(template)}
            className={cn(
              CHOICE_BASE,
              CHOICE_IDLE,
              "grid min-h-12 w-full min-w-0 content-center gap-0.5 rounded-lg px-3 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-60",
            )}
          >
            <span className="truncate text-data font-medium text-fg">{template.title}</span>
            <span className="line-clamp-2 text-caption text-fg-tertiary">{template.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
