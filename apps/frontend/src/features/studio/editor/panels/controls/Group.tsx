// A property group of Effect Controls: one section of the accordion. Its header (32 px) carries the chevron, the
// title, a dot while the group differs from its defaults, the group's own controls and a reset button where putting
// the group back makes sense. A reset that would remove keyframes asks first, in the header itself, and is then one
// step of the history. Which groups are open is remembered per kind of clip (GroupsContext); a group a command asked
// for is shown open whatever is remembered.
import { ChevronRight, RotateCcw } from "lucide-react";
import { use, useId, useState, type ReactNode } from "react";
import { SPRING_SNAPPY, TOOL_BUTTON } from "@/components/ui/look";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { FieldLockContext, GroupsContext, type GroupId } from "./controlsContext";
import { InlineConfirm } from "./InlineConfirm";
import { ChangedDot, IconButton, RowFrame } from "./rows";

export interface GroupProps {
  id: GroupId;
  title: string;
  /** The group differs from its defaults: the header shows a dot and the reset button can be used. */
  changed?: boolean;
  /** Puts the group back to its defaults; absent where that makes no sense. */
  onReset?: () => void;
  /** Keyframes the reset removes: when there are any, it asks first. */
  resetKeys?: number;
  /** Drawn as the chosen group (Motion while the Program monitor shows the transform box). */
  selected?: boolean;
  /** Called when the title is pressed; true means the press was used and the group stays open or closed as it is. */
  onChoose?: () => boolean;
  /** The group's own controls in the header, before the reset button. */
  actions?: ReactNode;
  children: ReactNode;
}

export function Group({ id, title, changed = false, onReset, resetKeys = 0, selected = false, onChoose, actions, children }: GroupProps) {
  const groups = use(GroupsContext);
  const locked = use(FieldLockContext);
  const bodyId = useId();
  const [confirming, setConfirming] = useState(false);
  const open = groups.open.includes(id) || groups.forced === id;
  const toggle = () => { groups.setOpen(id, !open); };
  const toggleLabel = open ? t("收合{label}", { label: title }) : t("展開{label}", { label: title });
  return (
    <section aria-label={title}>
      <RowFrame variant="header" selected={selected}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={toggle}
          className={cn(TOOL_BUTTON, "text-fg-tertiary")}
        >
          <ChevronRight aria-hidden className={cn("transition-[rotate]", SPRING_SNAPPY, open && "rotate-90")} />
        </button>
        {confirming && onReset ? (
          <InlineConfirm
            question={t("重設{label}會移除 {count} 個關鍵影格？", { label: title, count: resetKeys })}
            action={t("重設")}
            onConfirm={() => {
              setConfirming(false);
              onReset();
            }}
            onCancel={() => { setConfirming(false); }}
          />
        ) : (
          <>
            <h3 className="flex min-w-0 flex-1">
              <button
                type="button"
                aria-expanded={open}
                aria-controls={bodyId}
                title={title}
                onClick={() => {
                  if (!(onChoose?.() === true)) toggle();
                }}
                className="min-w-0 flex-1 truncate rounded-sm py-1 text-left text-data font-semibold text-fg"
              >
                {title}
              </button>
            </h3>
            {changed ? <ChangedDot className="mx-1" /> : null}
            {actions}
            {onReset ? (
              <IconButton
                label={t("重設{label}", { label: title })}
                disabledReason={locked ?? (changed ? null : t("已經是預設值"))}
                onClick={() => {
                  if (resetKeys > 0) setConfirming(true);
                  else onReset();
                }}
              >
                <RotateCcw aria-hidden />
              </IconButton>
            ) : null}
          </>
        )}
      </RowFrame>
      {open ? <div id={bodyId}>{children}</div> : null}
    </section>
  );
}
