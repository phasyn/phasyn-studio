import { useCatalog, useProviderIndex } from "@/api/catalog";
import type { ComponentDescriptor } from "@/api/generated/contracts";
import { StatusBadge } from "@/components/common/StatusBadge";
import { SyntheticBadge } from "@/components/common/SyntheticNotice";
import { Select } from "@/components/ui/controls";
import { placeLabel } from "@/lib/deviceTag";
import { componentOptions, optionsOfKind, readinessText } from "./catalogIndex";
import { tServer, t } from "@/i18n";

/** 依 provider kind 選元件（任何 Node）；沒有候選時說明原因。value 為 node_id::component_id。 */
export function KindComponentSelect({
  id,
  label,
  kind,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  kind: string;
  value: string | null;
  onChange: (value: string, descriptor: ComponentDescriptor) => void;
  disabled?: boolean;
}) {
  const catalog = useCatalog();
  const providers = useProviderIndex((catalog.data?.nodes ?? []).map((node) => node.node_id));
  const options = optionsOfKind(componentOptions(catalog.data, providers), kind);
  const selected = options.find((option) => option.value === value) ?? options[0] ?? null;
  const unavailable = [...providers.byRuntime.values()].filter((item) => item.kind === kind && !item.available);
  return (
    <div className="grid min-w-0 gap-1">
      <label htmlFor={id} className="text-data font-medium text-fg-secondary">
        {label}
      </label>
      {options.length === 0 ? (
        <p id={id} className="text-caption text-warning">
          {catalog.isPending || providers.loading ? t("讀取元件目錄…") : t("目錄中沒有 kind 為 {kind} 的元件；可到元件頁新建 instance。", { kind })}
          {unavailable.length > 0 ? t(" 不可用的 provider：{map}", { map: unavailable.map((item) => t("{provider_id}（{value}）", { provider_id: item.provider_id, value: tServer(item.reason) ?? t("未提供原因") })).join(t("；")) }) : ""}
        </p>
      ) : (
        <>
          <Select
            id={id}
            value={selected?.value ?? ""}
            disabled={disabled}
            onChange={(event) => {
              const option = options.find((item) => item.value === event.target.value);
              if (option) onChange(option.value, option.descriptor);
            }}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {t("{placeLabel} / {value}（{component_id}）· {option}", { placeLabel: placeLabel(option.descriptor.device, option.node.label), value: option.descriptor.label || option.descriptor.component_id, component_id: option.descriptor.component_id, option: readinessText(option) })}
              </option>
            ))}
          </Select>
          {selected ? (
            <p className="flex flex-wrap items-center gap-2 text-caption text-fg-tertiary">
              <StatusBadge kind="component" value={selected.descriptor.state} />
              <code className="machine">{selected.descriptor.provider_id}</code>
              {selected.provider?.synthetic ? <SyntheticBadge kind="test" /> : null}
              {selected.descriptor.state !== "ready" ? <span className="text-warning">{t("未就緒：run 會在此步回報錯誤，請先到元件頁啟動。")}</span> : null}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
