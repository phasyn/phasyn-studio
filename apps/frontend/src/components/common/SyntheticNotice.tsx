import { FlaskConical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { t } from "@/i18n";

/** 合成示例／測試元件：整區標示，不讓 fixture 看起來像線上設備的成功結果。 */
export function SyntheticNotice({ kind = "synthetic", detail, className }: { kind?: "synthetic" | "test"; detail?: string; className?: string }) {
  return (
    <Callout tone="warning" icon={<FlaskConical />} title={kind === "test" ? t("測試元件／合成示例") : t("合成示例")} className={className}>
      <p>{detail ?? t("這是合成或測試資料：只驗證契約與流程，不代表模型生成結果或設備效能。")}</p>
    </Callout>
  );
}

export function SyntheticBadge({ kind = "synthetic" }: { kind?: "synthetic" | "test" }) {
  return (
    <Badge tone="warning">
      <FlaskConical aria-hidden />
      {kind === "test" ? t("測試元件／合成示例") : t("合成示例")}
    </Badge>
  );
}
