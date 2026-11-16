// 紀錄表的視覺對照：等級色調與來源圖示。元件來源沿用 providerKind，讓資源樹、節點圖與紀錄來源同一組類型色。
import { ListVideo, Network, Server, type LucideIcon } from "lucide-react";
import { providerKind } from "@/components/workbench/kinds";
import type { Tone } from "@/components/workbench/tones";
import { SOURCE_KIND_LABEL, type LogLevel, type LogSource } from "./model";
import { t } from "@/i18n";

/** INFO＝info、WARN＝warning、ERROR＝danger、DEBUG＝中性、OK＝success（顏色永遠搭配文字標籤）。 */
export const LEVEL_TONE: Record<LogLevel, Tone> = {
  debug: "neutral",
  info: "info",
  warning: "warning",
  error: "danger",
  success: "success",
};

export interface SourceSpec {
  icon: LucideIcon;
  tone: Tone;
  /** 滑鼠提示：來源類型、名稱、provider。 */
  title: string;
}

export function sourceSpec(source: LogSource): SourceSpec {
  switch (source.kind) {
    case "component":
    case "step": {
      const kind = providerKind(source.providerId);
      const provider = source.providerId ? t("（{providerId}・{label}）", { providerId: source.providerId, label: kind.label }) : "";
      return { icon: kind.icon, tone: kind.tone, title: t("{kind}：{label}{provider}", { kind: SOURCE_KIND_LABEL[source.kind], label: source.label, provider }) };
    }
    case "run":
      return { icon: ListVideo, tone: "neutral", title: t("run：{label}", { label: source.label }) };
    case "node":
      return { icon: Server, tone: "neutral", title: t("Node：{label}", { label: source.label }) };
    case "controller":
      return { icon: Network, tone: "neutral", title: t("主控：{label}", { label: source.label }) };
  }
}
