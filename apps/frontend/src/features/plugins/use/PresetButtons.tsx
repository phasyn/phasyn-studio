// 推薦組合：一鍵把專案的規則換成一組實測過的組合（已選用的生成設定保留）。目前的規則正好等於某個組合時，它顯示為套用中。
import { ListChecks } from "lucide-react";
import type { StudioPluginRef } from "@/api/generated/contracts";
import { ActionButton } from "@/components/common/ActionButton";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { pluginUsable, type PluginRegistry } from "../model/registry";
import { presetActive, presetPlan } from "../model/selection";
import { pluginText } from "../model/text";

export function PresetButtons({
  registry,
  refs,
  onChange,
  onApplied,
  className,
}: {
  registry: PluginRegistry;
  refs: readonly StudioPluginRef[];
  onChange: (refs: StudioPluginRef[]) => void;
  /** After a set was applied (its label), for a caller that confirms it with a message. */
  onApplied?: (label: string) => void;
  className?: string;
}) {
  const presets = registry.presets.filter((preset) => pluginUsable(preset.plugin));
  if (presets.length === 0) return null;
  return (
    <div role="group" aria-label={t("推薦組合")} className={cn("flex min-w-0 flex-wrap gap-1.5", className)}>
      {presets.map((preset) => {
        const label = pluginText(preset.preset.label, preset.preset.id);
        const active = presetActive(registry, refs, preset);
        const plan = presetPlan(registry, refs, preset);
        return (
          <ActionButton
            key={preset.key}
            size="sm"
            variant="secondary"
            icon={<ListChecks aria-hidden />}
            aria-pressed={active}
            disabledReason={plan.reason}
            title={[label, pluginText(preset.preset.description)].filter(Boolean).join("\n")}
            onClick={() => {
              onChange(plan.refs);
              onApplied?.(label);
            }}
            className={cn("max-w-full min-w-0 shrink-0 rounded-full", active && "border-brand-blue/60 bg-brand-gradient-soft text-fg [&_svg]:text-brand-cyan")}
          >
            <span className="truncate">{label}</span>
          </ActionButton>
        );
      })}
    </div>
  );
}
