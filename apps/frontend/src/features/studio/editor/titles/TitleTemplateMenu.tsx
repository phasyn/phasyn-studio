// The title templates as a menu button, beside "add text layer": choosing one puts a styled, animated text layer at the
// playhead (on a free video track above the picture) as one step of the history, selects it and shows it in the
// Program monitor. `labelled` draws the button with its name (an empty Text dock); otherwise it is an icon (a header).
import { ChevronDown, LayoutTemplate } from "lucide-react";
import { useId, useState } from "react";
import { ActionMenu, MenuTriggerButton } from "@/components/ui/action-menu";
import type { MenuItem } from "@/components/ui/menuModel";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { exportGeometry, localId } from "../../model/project";
import { useEditor } from "../editorContext";
import { createTitleFromTemplate, TITLE_TEMPLATES, type TitleTemplate } from "./titleTemplates";

interface OpenMenu {
  anchor: HTMLButtonElement;
  focus: "first" | "last";
}

export function TitleTemplateMenu({ labelled = false }: { labelled?: boolean }) {
  const editor = useEditor();
  const menuId = useId();
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  // The visible name ("標題範本") is part of the accessible one
  const name = t("插入標題範本");

  const add = (template: TitleTemplate) => {
    const result = createTitleFromTemplate(editor.timeline, editor.playhead.getFrame(), template, exportGeometry(editor.project), localId);
    if (!result.ok) {
      editor.warn(result.error);
      return;
    }
    if (!editor.commit(result.value.timeline, t("新增標題「{name}」", { name: template.label }))) return;
    editor.setSelected([result.value.clipId]);
    editor.setMonitorMode("program");
  };
  const items: MenuItem[] = TITLE_TEMPLATES.map((template) => ({
    id: template.id,
    label: template.label,
    icon: template.icon,
    disabledReason: editor.problem,
    onSelect: () => { add(template); },
  }));

  return (
    <>
      <MenuTriggerButton
        menuId={menuId}
        open={menu !== null}
        label={name}
        onOpen={(anchor, focus) => { setMenu({ anchor, focus }); }}
        onClose={() => { setMenu(null); }}
        className={cn(
          "[&_svg]:size-4",
          labelled ? "min-h-8 gap-1.5 border border-line-strong bg-raised px-3 text-data font-medium text-fg hover:border-action/60 hover:bg-overlay" : "size-7 [&_svg]:size-3.5",
        )}
      >
        <LayoutTemplate aria-hidden />
        {labelled ? (
          <>
            {t("標題範本")}
            <ChevronDown aria-hidden className="text-fg-tertiary" />
          </>
        ) : null}
      </MenuTriggerButton>
      {menu ? (
        <ActionMenu
          id={menuId}
          label={t("標題範本")}
          items={items}
          anchor={{ kind: "element", element: menu.anchor }}
          returnFocus={menu.anchor}
          initialFocus={menu.focus}
          onClose={() => { setMenu(null); }}
        />
      ) : null}
    </>
  );
}
