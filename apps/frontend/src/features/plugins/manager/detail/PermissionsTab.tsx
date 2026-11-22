// 詳情「權限」：包裡的程式碼要求的能力（介面上的說法＋manifest 的名稱）與安裝時的紀錄。權限限制的是程式碼，不是人；
// 這個版本不執行任何插件程式碼，所以這裡只供檢視。安裝預覽時，相對於目前安裝的版本多出來的權限會標示出來。
import { ShieldCheck } from "lucide-react";
import type { StudioPlugin, StudioPluginDetail } from "@/api/generated/contracts";
import { EmptyState } from "@/components/common/EmptyState";
import { IdText, TimeText } from "@/components/common/values";
import { Callout } from "@/components/ui/callout";
import { ICON_TILE } from "@/components/ui/look";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { permissionInfo } from "../../model/permissions";
import { useRevealRef } from "../../parts/motion";

function PermissionRow({ index, name, added }: { index: number; name: string; added: boolean }) {
  const enter = useRevealRef(index);
  const info = permissionInfo(name);
  const Icon = info.icon;
  return (
    <li ref={enter} className="flex min-w-0 items-start gap-3 px-3 py-2.5">
      <span aria-hidden className={cn(ICON_TILE, "mt-0.5 size-8 [&_svg]:size-4", !info.known && "border-warning/40 text-warning")}>
        <Icon />
      </span>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className={cn("text-body [overflow-wrap:anywhere]", info.known ? "text-fg" : "text-warning")}>{info.label}</p>
        <p className="flex flex-wrap items-baseline gap-x-2 text-caption text-fg-tertiary">
          <code className="machine">{info.name}</code>
          {(info.note != null && info.note !== "") ? <span>{info.note}</span> : null}
        </p>
      </div>
      {added ? <span className="shrink-0 rounded-full border border-warning/35 bg-warning/10 px-2 py-px text-caption font-medium text-warning">{t("這次新增")}</span> : null}
    </li>
  );
}

export function PermissionsTab({ plugin, consent, added }: { plugin: StudioPlugin; consent: StudioPluginDetail["consent"] | undefined; added: readonly string[] }) {
  if (plugin.permissions.length === 0) {
    return (
      <EmptyState
        size="compact"
        icon={<ShieldCheck />}
        title={t("不需要任何權限")}
        description={plugin.has_code ? t("這個包的程式碼沒有要求任何能力。") : t("這個包只有宣告式的內容（規則、推薦組合、生成設定），沒有程式碼。")}
      />
    );
  }
  return (
    <div className="grid content-start gap-3">
      <Callout tone="info" title={t("這個版本不執行插件程式碼；以下是它要求的能力")} />
      <ul aria-label={t("要求的權限")} className="grid divide-y divide-line-subtle rounded-lg border border-line-subtle bg-canvas/60">
        {plugin.permissions.map((name, index) => (
          <PermissionRow key={name} index={index} name={name} added={added.includes(name)} />
        ))}
      </ul>
      {consent ? (
        <dl className="grid grid-cols-[minmax(5.5rem,auto)_minmax(0,1fr)] gap-x-5 gap-y-2 text-data">
          <dt className="text-fg-tertiary">{t("安裝時記錄")}</dt>
          <dd className="m-0">
            <TimeText iso={consent.at} />
          </dd>
          <dt className="text-fg-tertiary">digest</dt>
          <dd className="m-0 min-w-0">
            <IdText value={consent.digest} length={12} />
          </dd>
        </dl>
      ) : null}
    </div>
  );
}
