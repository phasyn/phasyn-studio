// The Effects group: the clip's effect stack, applied from top to bottom. An effect is added from a menu; each one
// is a small section of its own that can be collapsed, switched off (its settings stay), put back to its defaults
// (asked first when that removes keyframes), moved up or down and removed. Its numeric parameters are animatable rows.
import { ArrowDown, ArrowUp, ChevronRight, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useContext, useId, useState } from "react";
import type { TimelineClip } from "@/api/generated/contracts";
import { ActionMenu, MenuTriggerButton } from "@/components/ui/action-menu";
import { SPRING_SNAPPY } from "@/components/ui/look";
import type { MenuItem } from "@/components/ui/menuModel";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { localId } from "../../../../model/ids";
import { EFFECT_LIMIT, EFFECT_NAMES, newEffect, type ClipEffect } from "../../../compositing";
import { FieldLockContext, GroupsContext } from "../controlsContext";
import { ColorField } from "../fields";
import { Group } from "../Group";
import { InlineConfirm } from "../InlineConfirm";
import { useClipPanel } from "../panelContext";
import { effectKey, effectParameters, effectTitle, type ClipProperty } from "../properties";
import { PropertyRow } from "../PropertyRow";
import { ActionRow, IconButton, Row, RowFrame } from "../rows";

const KINDS: readonly ClipEffect["kind"][] = ["color", "blur", "directional_blur", "sharpen", "glow", "rgb_split", "vignette", "grain", "chroma_key"];
/** The "add effect" button inside the group, drawn as a labelled row button. */
const ADD_BUTTON = "h-6 gap-1 border border-line-strong bg-raised px-2 text-caption font-medium text-fg hover:border-action/60 hover:bg-overlay [&_svg]:size-3.5";

/** Which of the two "add effect" buttons opened the menu, and the button itself (the menu's anchor). */
interface OpenMenu {
  from: "header" | "body";
  anchor: HTMLButtonElement;
}

interface EffectSectionProps {
  clip: TimelineClip;
  effect: ClipEffect;
  /** Its place in the stack, and whether it is the last one. */
  index: number;
  last: boolean;
  open: boolean;
  /** The clip's animatable properties by channel key. */
  properties: ReadonlyMap<string, ClipProperty>;
  onToggle: () => void;
  /** The effect with other settings (what a button of its header changed). */
  onChange: (effect: ClipEffect) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}

function EffectSection({ clip, effect, index, last, open, properties, onToggle, onChange, onMove, onRemove }: EffectSectionProps) {
  const panel = useClipPanel();
  const locked = useContext(FieldLockContext);
  const [confirming, setConfirming] = useState(false);
  const name = effectTitle(effect, index);
  const keys = Object.values(effect.keyframes ?? {}).reduce((count, list) => count + (list?.length ?? 0), 0);
  const reset = () => onChange({ ...newEffect(effect.kind, effect.effect_id), enabled: effect.enabled });
  const enableTitle = effect.enabled ? t("「{name}」已啟用；按一下停用（設定會保留）", { name }) : t("「{name}」已停用；按一下啟用", { name });
  const withColor = (color: string): TimelineClip => ({
    ...clip,
    effect_stack: clip.effect_stack?.map((item) => (item.effect_id === effect.effect_id && item.kind === "chroma_key" ? { ...item, color } : item)),
  });
  return (
    <div role="group" aria-label={name}>
      <RowFrame variant="sub">
        <IconButton label={open ? t("收合「{name}」", { name }) : t("展開「{name}」", { name })} onClick={onToggle}>
          <ChevronRight aria-hidden className={cn("transition-[rotate]", SPRING_SNAPPY, open && "rotate-90")} />
        </IconButton>
        {confirming ? (
          <InlineConfirm
            question={t("重設「{name}」會移除 {count} 個關鍵影格？", { name, count: keys })}
            action={t("重設")}
            onConfirm={() => {
              setConfirming(false);
              reset();
            }}
            onCancel={() => setConfirming(false)}
          />
        ) : (
          <>
            <IconButton
              label={t("啟用「{name}」", { name })}
              title={enableTitle}
              pressed={effect.enabled}
              disabledReason={locked}
              onClick={() => onChange({ ...effect, enabled: !effect.enabled })}
            >
              <span aria-hidden className={cn("font-mono text-[11px] leading-none font-semibold italic", !effect.enabled && "line-through")}>
                fx
              </span>
            </IconButton>
            <span className={cn("min-w-0 flex-1 truncate text-data", effect.enabled ? "text-fg" : "text-fg-tertiary")} title={name}>
              {name}
            </span>
            <IconButton label={t("重設「{name}」", { name })} disabledReason={locked} onClick={() => (keys > 0 ? setConfirming(true) : reset())}>
              <RotateCcw aria-hidden />
            </IconButton>
            <IconButton
              label={t("上移「{name}」", { name })}
              disabledReason={locked ?? (index === 0 ? t("已經是第一個效果") : null)}
              onClick={() => onMove(-1)}
            >
              <ArrowUp aria-hidden />
            </IconButton>
            <IconButton
              label={t("下移「{name}」", { name })}
              disabledReason={locked ?? (last ? t("已經是最後一個效果") : null)}
              onClick={() => onMove(1)}
            >
              <ArrowDown aria-hidden />
            </IconButton>
            <IconButton label={t("刪除「{name}」", { name })} disabledReason={locked} onClick={onRemove} className="hover:text-danger">
              <Trash2 aria-hidden />
            </IconButton>
          </>
        )}
      </RowFrame>
      {open && effect.kind === "chroma_key" ? (
        <Row label={t("去背色彩")}>
          <ColorField label={t("去背色彩")} value={effect.color} onCommit={(color) => panel.apply(withColor(color))} />
        </Row>
      ) : null}
      {open
        ? effectParameters(effect.kind).map((param) => {
            const property = properties.get(effectKey(effect.effect_id, param));
            return property ? <PropertyRow key={param} property={property} owner={clip} /> : null;
          })
        : null}
    </div>
  );
}

export interface EffectsGroupProps {
  clip: TimelineClip;
  /** The clip's animatable properties by channel key. */
  properties: ReadonlyMap<string, ClipProperty>;
}

export function EffectsGroup({ clip, properties }: EffectsGroupProps) {
  const panel = useClipPanel();
  const locked = useContext(FieldLockContext);
  const groups = useContext(GroupsContext);
  const menuId = useId();
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const effects = clip.effect_stack ?? [];
  const full = effects.length >= EFFECT_LIMIT ? t("每個片段最多 {count} 個效果", { count: EFFECT_LIMIT }) : null;

  const setEffects = (effect_stack: ClipEffect[]) => panel.perform({ ...clip, effect_stack });
  const add = (kind: ClipEffect["kind"]) => {
    if (setEffects([...effects, newEffect(kind, localId("fx"))])) groups.setOpen("effects", true);
  };
  const move = (index: number, by: -1 | 1) => {
    const next = [...effects];
    const effect = next[index];
    const other = next[index + by];
    if (!effect || !other) return;
    next[index] = other;
    next[index + by] = effect;
    setEffects(next);
  };
  const toggleCollapsed = (effectId: string) => {
    const next = new Set(collapsed);
    if (!next.delete(effectId)) next.add(effectId);
    setCollapsed(next);
  };
  const items: MenuItem[] = KINDS.map((kind) => ({ id: kind, label: EFFECT_NAMES[kind], disabledReason: locked ?? full, onSelect: () => add(kind) }));
  const trigger = (from: OpenMenu["from"]) => ({
    menuId,
    open: menu?.from === from,
    label: t("新增效果"),
    onOpen: (anchor: HTMLButtonElement) => setMenu({ from, anchor }),
    onClose: () => setMenu(null),
  });

  return (
    <Group
      id="effects"
      title={t("效果")}
      changed={effects.length > 0}
      actions={
        <>
          <MenuTriggerButton {...trigger("header")} className="size-7 [&_svg]:size-3.5">
            <Plus aria-hidden />
          </MenuTriggerButton>
          {menu ? (
            <ActionMenu
              id={menuId}
              label={t("新增效果")}
              items={items}
              anchor={{ kind: "element", element: menu.anchor }}
              returnFocus={menu.anchor}
              onClose={() => setMenu(null)}
            />
          ) : null}
        </>
      }
    >
      {effects.length === 0 ? (
        <ActionRow>
          <MenuTriggerButton {...trigger("body")} className={ADD_BUTTON}>
            <Plus aria-hidden />
            {t("新增效果")}
          </MenuTriggerButton>
        </ActionRow>
      ) : null}
      {effects.map((effect, index) => (
        <EffectSection
          key={effect.effect_id}
          clip={clip}
          effect={effect}
          index={index}
          last={index === effects.length - 1}
          open={!collapsed.has(effect.effect_id)}
          properties={properties}
          onToggle={() => toggleCollapsed(effect.effect_id)}
          onChange={(next) => setEffects(effects.map((item) => (item.effect_id === next.effect_id ? next : item)))}
          onMove={(by) => move(index, by)}
          onRemove={() => setEffects(effects.filter((item) => item.effect_id !== effect.effect_id))}
        />
      ))}
    </Group>
  );
}
