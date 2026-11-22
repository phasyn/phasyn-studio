// 詳情「內容」：這個包提供的貢獻，一次看一類（規則、推薦組合、生成設定、指令與面板）。規則與生成設定可以展開看可讀的
// 預覽（擋下的寫法、必要的寫法、加進 prompt 的文字；預設值與要求），並逐項決定這個專案要不要使用；推薦組合一鍵套用。
// 指令與面板是程式碼貢獻：這個版本只列出，不執行。
import { ChevronRight, ListChecks, PanelsTopLeft, ShieldCheck, SlidersHorizontal, SquareTerminal, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { StudioPlugin, StudioPluginRef } from "@/api/generated/contracts";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";
import { cn } from "@/lib/cn";
import { contributionKindLabel } from "../../model/contributions";
import { addCheck, presetActive, presetPlan, replaceNote, withoutRef, withRef } from "../../model/selection";
import { pluginText } from "../../model/text";
import { ContributionIcon } from "../../parts/kinds";
import { useRevealRef } from "../../parts/motion";
import { GenerationPreview, RulePreview } from "../../parts/RulePreview";
import { ToggleSwitch } from "../../parts/ToggleSwitch";
import { useManager, type PluginProjectBinding } from "../managerContext";
import type { PluginRegistry, RegistryPreset } from "../../model/registry";

type Section = "rules" | "presets" | "generation" | "code";

interface SectionSpec {
  id: Section;
  label: string;
  icon: LucideIcon;
  count: number;
}

function sections(plugin: StudioPlugin): SectionSpec[] {
  const { rules, presets, generation, commands, panels } = plugin.contributes;
  const all: SectionSpec[] = [
    { id: "rules", label: t("規則"), icon: ShieldCheck, count: rules.length },
    { id: "presets", label: t("推薦組合"), icon: ListChecks, count: presets.length },
    { id: "generation", label: t("生成設定"), icon: SlidersHorizontal, count: generation.length },
    { id: "code", label: t("指令與面板"), icon: SquareTerminal, count: commands.length + panels.length },
  ];
  return all.filter((section) => section.count > 0);
}

function SectionSwitch({ items, value, onChange }: { items: readonly SectionSpec[]; value: Section; onChange: (next: Section) => void }) {
  return (
    <div role="group" aria-label={t("內容的種類")} className="flex shrink-0 flex-wrap items-center gap-1 rounded-lg border border-line-subtle bg-sunken/60 p-1">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-pressed={value === item.id}
          onClick={() => { onChange(item.id); }}
          className={cn(
            "pressable inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-data [&_svg]:size-3.5",
            value === item.id ? "bg-brand-gradient-soft font-semibold text-fg ring-1 ring-brand-blue/45 ring-inset [&_svg]:text-brand-cyan" : "text-fg-secondary hover:bg-raised hover:text-fg",
          )}
        >
          <item.icon aria-hidden />
          {item.label}
          <span className="machine text-caption font-normal text-fg-tertiary">{item.count}</span>
        </button>
      ))}
    </div>
  );
}

/** 這個專案要不要使用一個貢獻的開關；不能加入時（包停用、超過上限）說明原因。 */
function ProjectSwitch({ registry, project, contribution, label }: { registry: PluginRegistry; project: PluginProjectBinding; contribution: StudioPluginRef; label: string }) {
  const on = project.refs.includes(contribution);
  const check = on ? { reason: null, replaces: null } : addCheck(registry, project.refs, contribution);
  const name = on ? t("這個專案正在使用「{label}」", { label }) : t("在這個專案使用「{label}」", { label });
  return (
    <ToggleSwitch
      checked={on}
      label={(check.replaces != null && check.replaces !== "") ? `${name}\n${replaceNote(registry, check.replaces)}` : name}
      disabledReason={check.reason}
      onChange={(next) => { project.onRefsChange(next ? withRef(registry, project.refs, contribution) : withoutRef(project.refs, contribution)); }}
    />
  );
}

function ExpandableRow({
  index,
  open,
  onToggle,
  icon,
  label,
  aside,
  action,
  children,
}: {
  index: number;
  open: boolean;
  onToggle: () => void;
  icon: ReactNode;
  label: string;
  aside: string;
  action: ReactNode;
  children: ReactNode;
}) {
  const enter = useRevealRef(index);
  return (
    <li ref={enter} className={cn("rounded-lg border transition-colors duration-(--duration-fast)", open ? "border-line bg-canvas/60" : "border-transparent hover:bg-raised/50")}>
      <div className="flex min-h-11 items-center gap-1 pr-1">
        <button type="button" aria-expanded={open} onClick={onToggle} title={label} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg py-1.5 pl-2 text-left">
          <ChevronRight
            aria-hidden
            className={cn("size-3.5 shrink-0 text-fg-tertiary transition-[rotate] duration-(--duration-spring-snappy) ease-(--ease-spring-snappy)", open && "rotate-90")}
          />
          {icon}
          <span className="truncate text-body text-fg">{label}</span>
          <span className="ml-auto shrink-0 pl-2 text-caption text-fg-tertiary">{aside}</span>
        </button>
        {action}
      </div>
      {open ? <div className="animate-reveal px-3 pt-1 pb-3 pl-9">{children}</div> : null}
    </li>
  );
}

function PresetRow({ index, entry, registry, project }: { index: number; entry: RegistryPreset; registry: PluginRegistry; project: PluginProjectBinding | null }) {
  const enter = useRevealRef(index);
  const label = pluginText(entry.preset.label, entry.preset.id);
  const description = pluginText(entry.preset.description);
  const names = entry.refs.map((ref) => pluginText(registry.rules.get(ref)?.rule.label, ref));
  const active = project ? presetActive(registry, project.refs, entry) : false;
  const plan = project ? presetPlan(registry, project.refs, entry) : null;
  return (
    <li ref={enter} className="grid gap-1.5 rounded-lg border border-line-subtle bg-canvas/60 p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-body font-semibold text-fg" title={label}>
          {label}
        </span>
        {project && plan ? (
          <Button
            size="sm"
            variant={active ? "quiet" : "secondary"}
            aria-pressed={active}
            aria-disabled={plan.reason !== null || undefined}
            title={plan.reason ?? (active ? t("這個專案正在使用這個組合") : t("把這個專案的規則換成這個組合"))}
            onClick={() => { if (plan.reason === null) { project.onRefsChange(plan.refs); } }}
            className={cn(plan.reason !== null && "cursor-not-allowed text-fg-disabled")}
          >
            {active ? t("套用中") : t("套用")}
          </Button>
        ) : null}
      </div>
      {description ? <p className="text-data text-fg-secondary [overflow-wrap:anywhere]">{description}</p> : null}
      <p className="text-caption text-fg-tertiary [overflow-wrap:anywhere]">{formatList(names)}</p>
    </li>
  );
}

function CodeRow({ index, icon: Icon, title, aside }: { index: number; icon: LucideIcon; title: string; aside: string }) {
  const enter = useRevealRef(index);
  return (
    <li ref={enter} title={t("這個版本還不能執行程式碼")} className="flex min-h-11 items-center gap-2.5 rounded-lg px-2 text-fg-tertiary">
      <Icon aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-body">{title}</span>
      <span className="machine shrink-0 text-caption">{aside}</span>
    </li>
  );
}

const COMMAND_SCOPE: Record<string, () => string> = { project: () => t("專案"), shot: () => t("鏡頭"), clip: () => t("片段") };

export function ContentsTab({ plugin, preview }: { plugin: StudioPlugin; preview: boolean }) {
  const { registry, project } = useManager();
  const available = sections(plugin);
  const [picked, setPicked] = useState<Section>("rules");
  const [expanded, setExpanded] = useState<StudioPluginRef | null>(null);
  const section = available.some((item) => item.id === picked) ? picked : (available[0]?.id ?? "rules");
  // 預覽中的包還沒安裝：只看內容，不能在專案選用
  const binding = preview ? null : project;
  const toggle = (ref: StudioPluginRef) => { setExpanded((current) => (current === ref ? null : ref)); };
  if (available.length === 0) {
    return <EmptyState size="compact" icon={<ListChecks />} title={t("這個包沒有可以列出的內容")} />;
  }
  const { rules, presets, generation, commands, panels } = plugin.contributes;
  return (
    <div className="grid content-start gap-3">
      {available.length > 1 ? <SectionSwitch items={available} value={section} onChange={setPicked} /> : null}
      {section === "rules" ? (
        <ul aria-label={t("規則")} className="grid gap-0.5">
          {rules.map((entry, index) => {
            const label = pluginText(entry.rule.label, entry.ref);
            return (
              <ExpandableRow
                key={entry.ref}
                index={index}
                open={expanded === entry.ref}
                onToggle={() => { toggle(entry.ref); }}
                icon={<ContributionIcon kind={entry.rule.kind} />}
                label={label}
                aside={contributionKindLabel(entry.rule.kind)}
                action={binding ? <ProjectSwitch registry={registry} project={binding} contribution={entry.ref} label={label} /> : null}
              >
                <RulePreview rule={entry.rule} />
              </ExpandableRow>
            );
          })}
        </ul>
      ) : null}
      {section === "presets" ? (
        <ul aria-label={t("推薦組合")} className="grid gap-2">
          {presets.map((entry, index) => (
            <PresetRow
              key={entry.preset.id}
              index={index}
              entry={{ key: `${plugin.plugin_id}/${entry.preset.id}`, preset: entry.preset, refs: entry.refs, plugin }}
              registry={registry}
              project={binding}
            />
          ))}
        </ul>
      ) : null}
      {section === "generation" ? (
        <ul aria-label={t("生成設定")} className="grid gap-0.5">
          {generation.map((entry, index) => {
            const label = pluginText(entry.generation.label, entry.ref);
            return (
              <ExpandableRow
                key={entry.ref}
                index={index}
                open={expanded === entry.ref}
                onToggle={() => { toggle(entry.ref); }}
                icon={<ContributionIcon kind="generation" />}
                label={label}
                aside={contributionKindLabel("generation")}
                action={binding ? <ProjectSwitch registry={registry} project={binding} contribution={entry.ref} label={label} /> : null}
              >
                <GenerationPreview generation={entry.generation} />
              </ExpandableRow>
            );
          })}
        </ul>
      ) : null}
      {section === "code" ? (
        <ul aria-label={t("指令與面板")} className="grid gap-0.5">
          {commands.map((command, index) => (
            <CodeRow key={`command:${command.id}`} index={index} icon={SquareTerminal} title={pluginText(command.title, command.id)} aside={t("指令・{scope}", { scope: COMMAND_SCOPE[command.scope]?.() ?? command.scope })} />
          ))}
          {panels.map((panel, index) => (
            <CodeRow key={`panel:${panel.id}`} index={commands.length + index} icon={PanelsTopLeft} title={pluginText(panel.title, panel.id)} aside={t("面板・{location}", { location: panel.location })} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
