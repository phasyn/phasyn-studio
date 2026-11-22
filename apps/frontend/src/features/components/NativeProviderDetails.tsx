import type { NativeProviderInfo } from "@/api/generated/contracts";
import { Disclosure } from "@/components/common/Disclosure";
import { Callout } from "@/components/ui/callout";
import { t, tServer } from "@/i18n";
import { formatList } from "@/i18n/format";
import { formatBytes } from "@/lib/format";

export function NativeProviderDetails({ provider }: { provider: NativeProviderInfo }) {
  const manifest = provider.manifest;
  const source = [provider.distribution.name, provider.distribution.version].filter(Boolean).join(" ");
  const reason = (provider.reason?.startsWith("Required Python modules are absent: ") === true)
    ? t("缺少 Python 模組：{modules}", { modules: provider.reason.slice("Required Python modules are absent: ".length) })
    : tServer(provider.reason) ?? provider.reason;
  if (!manifest) {
    return (
      <Callout tone={provider.status === "invalid" ? "warning" : "info"} title={t("原生元件能力")}>
        <p>{provider.status === "invalid" ? t("宣告驗證失敗，原因代碼為 {code}。", { code: provider.issue ?? "unknown" }) : t("這個版本尚未提供靜態能力宣告。")}</p>
        {source && <p className="machine break-all">{source}</p>}
        {!provider.available && (reason != null && reason !== "") && reason !== provider.issue && <p className="break-words">{reason}</p>}
      </Callout>
    );
  }
  return (
    <section aria-label={t("原生元件能力")} className="grid min-w-0 gap-2 rounded-md border border-line-subtle bg-sunken p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-body font-semibold text-fg">{t("原生元件能力")}</h3>
        <span className="machine text-caption text-fg-tertiary">{t("宣告版本 {version}", { version: manifest.capability_version })}</span>
      </div>
      <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1 text-caption">
        <dt className="text-fg-tertiary">{t("執行裝置")}</dt>
        <dd className="text-fg">{formatList(manifest.resources.devices.map((device) => device.toUpperCase()))}</dd>
        <dt className="text-fg-tertiary">{t("GPU 記憶體")}</dt>
        <dd>{manifest.resources.vram_bytes === null ? t("依模型與設定估算") : formatBytes(manifest.resources.vram_bytes)}</dd>
        <dt className="text-fg-tertiary">{t("套件來源")}</dt>
        <dd className="machine break-all">{source || t("未記錄套件版本")}</dd>
        <dt className="text-fg-tertiary">{t("程式授權")}</dt>
        <dd className="machine break-all">{manifest.license}</dd>
        {manifest.models.length > 0 && <><dt className="text-fg-tertiary">{t("模型與授權")}</dt><dd className="grid min-w-0 gap-1">{manifest.models.map((model) => <span className="machine break-all" key={model.id}>{model.id} · {model.license}</span>)}</dd></>}
      </dl>
      {!provider.available && (reason != null && reason !== "") && <p className="break-words text-caption text-warning">{reason}</p>}
      <Disclosure summary={t("查看輸出型別與宣告雜湊")}>
        <dl className="grid min-w-0 gap-1 text-caption">
          <dt className="text-fg-tertiary">{t("輸出型別")}</dt><dd className="machine break-all">{formatList(manifest.outputs.map((port) => port.type_id))}</dd>
          <dt className="text-fg-tertiary">SHA-256</dt><dd className="machine break-all">{provider.sha256}</dd>
        </dl>
      </Disclosure>
    </section>
  );
}
