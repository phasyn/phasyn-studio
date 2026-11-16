// 詳情「概覽」：狀態（已停用、不相容、無效的原因）、說明、事實（作者、授權、來源、相容性、大小、digest）與內容摘要。
import type { ReactNode } from "react";
import type { StudioPlugin } from "@/api/generated/contracts";
import { IdText, TimeText } from "@/components/common/values";
import { Callout } from "@/components/ui/callout";
import { t } from "@/i18n";
import { formatBytes } from "@/lib/format";
import { contributionSummary, sourceLabel } from "../../model/listing";
import { pluginText } from "../../model/text";
import { IssueList } from "../../parts/IssueList";
import { useManager } from "../managerContext";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-fg-tertiary">{label}</dt>
      <dd className="m-0 min-w-0 text-fg-secondary [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

/** 需要處理的狀態：說明現況與原因（不相容與無效時列出主控回報的問題）。 */
export function StatusCallout({ plugin, preview }: { plugin: StudioPlugin; preview: boolean }) {
  if (plugin.status === "ok") return null;
  if (plugin.status === "disabled") {
    return (
      <Callout tone="info" title={t("已停用")} className="animate-fade-in">
        <p>{t("所有專案都不能套用它的內容；選用它的專案在重新啟用之前不能渲染。")}</p>
      </Callout>
    );
  }
  const incompatible = plugin.status === "incompatible";
  const title = incompatible ? (preview ? t("安裝後的狀態是不相容") : t("不相容")) : t("無效：內容讀不到或不合規");
  return (
    <Callout tone={incompatible ? "warning" : "danger"} title={title} className="animate-fade-in">
      <p>{incompatible ? t("它的內容不能套用；選用它的專案不能渲染。") : t("它的內容不能套用；重新安裝或修正後才能使用。")}</p>
      <IssueList issues={plugin.problems} tone={incompatible ? "warning" : "danger"} label={t("原因")} className="mt-2 bg-transparent" />
    </Callout>
  );
}

export function OverviewTab({ plugin, preview }: { plugin: StudioPlugin; preview: boolean }) {
  const { registry } = useManager();
  const description = pluginText(plugin.description);
  const summary = contributionSummary(plugin);
  const host = registry.list?.host.version ?? null;
  return (
    <div className="grid content-start gap-4">
      <StatusCallout plugin={plugin} preview={preview} />
      {description ? <p className="text-body leading-6 text-fg-secondary [overflow-wrap:anywhere]">{description}</p> : null}
      <dl className="grid grid-cols-[minmax(5.5rem,auto)_minmax(0,1fr)] gap-x-5 gap-y-2 text-data">
        {summary ? <Fact label={t("內容")}>{summary}</Fact> : null}
        {plugin.author ? <Fact label={t("作者")}>{plugin.author.name}</Fact> : null}
        {plugin.author?.url ? (
          <Fact label={t("網站")}>
            <span className="machine">{plugin.author.url}</span>
          </Fact>
        ) : null}
        {plugin.license ? <Fact label={t("授權")}>{plugin.license}</Fact> : null}
        <Fact label={t("來源")}>{sourceLabel(plugin.source)}</Fact>
        {plugin.engines ? (
          <Fact label={t("相容版本")}>
            <span className="machine">{plugin.engines.phasyn}</span>
            {host ? <span className="text-fg-tertiary">{t("（這台主控 {host}）", { host })}</span> : null}
          </Fact>
        ) : null}
        {plugin.has_code ? (
          <Fact label={t("程式碼")}>
            {plugin.engines?.plugin_api != null ? t("有（plugin_api {version}）；這個版本不執行", { version: plugin.engines.plugin_api }) : t("有；這個版本不執行")}
          </Fact>
        ) : null}
        <Fact label={t("大小")}>
          <span className="machine">{t("{size}・{count} 個檔案", { size: formatBytes(plugin.size_bytes), count: plugin.file_count })}</span>
        </Fact>
        {!preview && plugin.installed_at ? (
          <Fact label={t("安裝時間")}>
            <TimeText iso={plugin.installed_at} />
          </Fact>
        ) : null}
        {!preview && plugin.updated_at && plugin.updated_at !== plugin.installed_at ? (
          <Fact label={t("更新時間")}>
            <TimeText iso={plugin.updated_at} />
          </Fact>
        ) : null}
        {plugin.digest ? (
          <Fact label="digest">
            <IdText value={plugin.digest} length={12} />
          </Fact>
        ) : null}
      </dl>
    </div>
  );
}
