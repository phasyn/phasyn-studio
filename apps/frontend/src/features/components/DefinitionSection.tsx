import type { ComponentDescriptor, Port } from "@/api/generated/contracts";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { KeyValueList } from "@/components/ui/kv";
import { Table, TableScroll, Td, Th } from "@/components/ui/table";
import { typeTone } from "@/components/workbench/kinds";
import { TEXT_TONE } from "@/components/workbench/tones";
import { cn } from "@/lib/cn";
import { tServer, t } from "@/i18n";

function PortTable({ ports, label }: { ports: readonly Port[]; label: string }) {
  if (ports.length === 0) return <p className="text-caption text-fg-tertiary">{t("{label}：無", { label })}</p>;
  return (
    <TableScroll label={label}>
      <Table>
        <caption className="px-1 pb-1 text-left text-caption text-fg-tertiary">{label}</caption>
        <thead>
          <tr>
            <Th scope="col">{t("名稱")}</Th>
            <Th scope="col">type_id</Th>
            <Th scope="col">{t("傳輸")}</Th>
            <Th scope="col">{t("說明")}</Th>
          </tr>
        </thead>
        <tbody>
          {ports.map((port) => (
            <tr key={port.name}>
              <Td className="machine text-fg">
                {port.name}
                {port.required ? <Badge className="ml-2">{t("必填")}</Badge> : <Badge className="ml-2">{t("選填")}</Badge>}
              </Td>
              <Td className={cn("machine", TEXT_TONE[typeTone(port.type_id)])}>{port.type_id}</Td>
              <Td className="machine text-fg-secondary">{port.transport}</Td>
              <Td className="text-caption text-fg-secondary">{tServer(port.description) || "—"}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </TableScroll>
  );
}

/** 元件定義：provider／runtime、裝置、API 路徑、連接埠與最近錯誤。 */
export function DefinitionSection({ descriptor }: { descriptor: ComponentDescriptor }) {
  return (
    <div className="grid min-w-0 gap-4">
      <KeyValueList
        dense
        items={[
          { key: "provider", label: "provider", value: descriptor.provider_id, mono: true },
          { key: "runtime", label: "runtime", value: descriptor.runtime_id, mono: true },
          { key: "device", label: "device", value: `${descriptor.device.kind}:${descriptor.device.id}`, mono: true },
          { key: "group", label: "resource_group", value: descriptor.device.resource_group, mono: true },
          { key: "api", label: "api_path", value: descriptor.api_path, mono: true },
          { key: "recorder", label: "recorder", value: <StatusBadge kind="recorder" value={descriptor.recorder_state} /> },
          { key: "parts", label: t("子部件"), value: t("{partsCount} 個", { partsCount: descriptor.parts.length }) },
        ]}
      />
      <PortTable ports={descriptor.inputs} label={t("輸入連接埠")} />
      <PortTable ports={descriptor.outputs} label={t("輸出連接埠")} />
      {descriptor.last_error ? <ErrorCallout error={descriptor.last_error} title={t("最近錯誤（last_error）")} /> : null}
    </div>
  );
}
