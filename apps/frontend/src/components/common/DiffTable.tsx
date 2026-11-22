import { Badge } from "@/components/ui/badge";
import { Table, TableScroll, Td, Th, Tr } from "@/components/ui/table";
import type { DiffEntry } from "@/lib/diff";
import { previewValue } from "@/lib/json";
import { t } from "@/i18n";

const KIND_LABEL = { added: t("新增"), removed: t("移除"), changed: t("變更") } as const;
const KIND_TONE = { added: "success", removed: "warning", changed: "info" } as const;

export function DiffTable({
  entries,
  beforeLabel: beforeLabelProp,
  afterLabel: afterLabelProp,
  label,
  highlight,
}: {
  entries: readonly DiffEntry[];
  beforeLabel?: string;
  afterLabel?: string;
  label: string;
  /** 需要特別提醒的路徑（例如 device／model_path 差異）。 */
  highlight?: (path: string) => string | null;
}) {
  const beforeLabel = beforeLabelProp ?? t("目前");
  const afterLabel = afterLabelProp ?? t("草稿");
  if (entries.length === 0) return <p className="text-data text-fg-tertiary">{t("沒有差異。")}</p>;
  return (
    <TableScroll label={label}>
      <Table>
        <thead>
          <tr>
            <Th>{t("欄位")}</Th>
            <Th>{t("類型")}</Th>
            <Th>{beforeLabel}</Th>
            <Th>{afterLabel}</Th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const note = highlight?.(entry.path) ?? null;
            return (
              <Tr key={entry.path}>
                <Td className="machine text-fg">
                  {entry.path || t("（根）")}
                  {(note != null && note !== "") ? <span className="mt-1 block font-sans text-caption text-warning">{note}</span> : null}
                </Td>
                <Td>
                  <Badge tone={KIND_TONE[entry.kind]}>{KIND_LABEL[entry.kind]}</Badge>
                </Td>
                <Td className="machine max-w-72 text-fg-tertiary [overflow-wrap:anywhere]">{previewValue(entry.before)}</Td>
                <Td className="machine max-w-72 text-fg [overflow-wrap:anywhere]">{previewValue(entry.after)}</Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </TableScroll>
  );
}
