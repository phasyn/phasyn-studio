import { ChevronRight, Folder, FolderOpen, RefreshCcw, TriangleAlert } from "lucide-react";
import type { ComponentEntry } from "@/api/catalog";
import { StatusBadge } from "@/components/common/StatusBadge";
import { IdText } from "@/components/common/values";
import { Badge } from "@/components/ui/badge";
import { Table, TableScroll, Td, Th, Tr } from "@/components/ui/table";
import { ColumnResizer } from "@/components/workbench/ColumnResizer";
import { widthOf } from "@/components/workbench/columnWidths";
import { buildFolderTree, flattenFolderTree, folderOf, type FolderNode, folderDisplayName, folderDisplayPath } from "@/components/workbench/componentFolders";
import { providerKind } from "@/components/workbench/kinds";
import { TEXT_TONE } from "@/components/workbench/tones";
import { useColumnWidths } from "@/components/workbench/useColumnWidths";
import { cn } from "@/lib/cn";
import { usePersistentSet } from "@/lib/usePersistentSize";
import { COMPONENT_COLUMNS } from "./componentsModel";
import { t } from "@/i18n";
import { T } from "@/i18n/T";
import { failureText } from "@/lib/errors";

/** 每層資料夾縮排（px）；第一欄原本左內距 16 px。 */
const INDENT = 14;
const BASE_PAD = 16;
const COLUMN_COUNT = COMPONENT_COLUMNS.length + 1;

function RevisionCell({ entry }: { entry: ComponentEntry }) {
  const settings = entry.descriptor.settings;
  const loaded = settings.loaded_revision === null ? "—" : `#${String(settings.loaded_revision)}`;
  return (
    <span
      className="inline-flex max-w-full items-center gap-1.5 whitespace-nowrap"
      title={t("已保存 #{stored_revision} · 目前載入 {loaded}{value}", { stored_revision: settings.stored_revision, loaded, value: settings.restart_required ? t(" · 已保存的 load 設定與目前載入不同，需要明確 restart") : "" })}
    >
      <span className="machine truncate text-fg-secondary">
        <T source={"#{stored_revision}<0>／{loaded}</0>"} values={{ stored_revision: settings.stored_revision, loaded }} slots={[<span key="slot-0" className="text-fg-tertiary" />]} />
      </span>
      {settings.restart_required ? (
        <span className="inline-flex shrink-0 text-warning">
          <RefreshCcw aria-hidden className="size-3.5" />
          <span className="sr-only">{t("需 restart")}</span>
        </span>
      ) : null}
    </span>
  );
}

/** 表格只顯示錯誤碼（完整訊息在 title 與檢視器的「定義」頁籤），維持單行列高。 */
function LastErrorCell({ entry }: { entry: ComponentEntry }) {
  const error = entry.descriptor.last_error;
  if (!error) return <span className="text-fg-tertiary">—</span>;
  return (
    <span className="block truncate machine text-danger" title={failureText(error.code, error.message)}>
      {error.code}
    </span>
  );
}

function FolderRow({ node, expanded, filtering, onToggle }: { node: FolderNode<ComponentEntry>; expanded: boolean; filtering: boolean; onToggle: () => void }) {
  const Icon = expanded ? FolderOpen : Folder;
  const path = folderDisplayPath(node.path);
  return (
    <tr>
      <td colSpan={COLUMN_COUNT} className="border-b border-line-subtle bg-sunken/50 p-0">
        <button
          type="button"
          aria-expanded={expanded}
          aria-disabled={filtering || undefined}
          title={filtering ? t("{path}：篩選中，全部展開顯示", { path }) : t("{path}（{total} 個 instance）", { path, total: node.total })}
          onClick={filtering ? undefined : onToggle}
          className="group/folder flex h-8 w-full min-w-0 items-center gap-1.5 pr-3 text-left text-data font-semibold text-fg transition-colors duration-(--duration-fast) outline-none hover:bg-raised/60 focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset active:bg-sunken active:duration-0 aria-disabled:cursor-default aria-disabled:hover:bg-transparent aria-disabled:active:bg-transparent"
          style={{ paddingLeft: BASE_PAD - 4 + node.depth * INDENT }}
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-fg-tertiary transition-[rotate,color] duration-(--duration-spring-snappy) ease-spring-snappy group-hover/folder:text-fg-secondary",
              expanded && "rotate-90",
            )}
          />
          <Icon aria-hidden className="size-4 shrink-0 text-fg-tertiary transition-colors duration-(--duration-fast) group-hover/folder:text-fg-secondary" />
          <span className="min-w-0 truncate">{folderDisplayName(node.path)}</span>
          <span aria-hidden className="machine shrink-0 rounded-sm bg-raised px-1 text-caption font-normal text-fg-tertiary">
            {node.total}
          </span>
          {/* 螢幕閱讀器讀完整的一句（數字與單位一起翻譯，英文才有單複數） */}
          <span className="sr-only">{t("（{total} 個 instance）", { total: node.total })}</span>
        </button>
      </td>
    </tr>
  );
}

function InstanceRow({ entry, depth, selected, onSelect }: { entry: ComponentEntry; depth: number; selected: boolean; onSelect: (entry: ComponentEntry) => void }) {
  const d = entry.descriptor;
  const name = d.label || d.component_id;
  const kind = providerKind(d.provider_id);
  const stale = entry.node.stale;
  return (
    <Tr selected={selected} className={cn("cursor-pointer [&>td]:align-middle", stale && "opacity-80")} onClick={() => { onSelect(entry); }}>
      <Td className="py-1" style={{ paddingLeft: BASE_PAD + depth * INDENT }}>
        <button
          type="button"
          aria-pressed={selected}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(entry);
          }}
          title={t("{name}（{component_id}）\n資料夾：{d}", { name, component_id: d.component_id, d: folderDisplayPath(folderOf(d)) })}
          className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-sm text-left"
        >
          <kind.icon aria-hidden className={cn("size-4 shrink-0", TEXT_TONE[kind.tone])} />
          {/* Name over id: each gets the column's whole width instead of sharing one line */}
          <span className="grid min-w-0 flex-1">
            <span className="truncate leading-5 font-medium text-fg">{name}</span>
            {d.label && d.label !== d.component_id ? <code className="truncate machine text-caption leading-4 text-fg-tertiary">{d.component_id}</code> : null}
          </span>
          {stale ? (
            <Badge tone="warning" className="shrink-0 px-1.5">
              {t("過時")}
            </Badge>
          ) : null}
        </button>
      </Td>
      <Td>
        <code className="block truncate machine text-fg-secondary" title={`${d.provider_id} · runtime ${d.runtime_id}`}>
          {d.provider_id}
        </code>
      </Td>
      <Td>
        <code className="block truncate machine text-fg-secondary" title={`${d.device.kind}:${d.device.id} · resource_group ${d.device.resource_group}`}>
          {d.device.kind}:{d.device.id}
        </code>
      </Td>
      <Td>
        <span className="inline-flex max-w-full items-center gap-1">
          <StatusBadge kind="component" value={d.state} />
          {d.recorder_state === "degraded" ? (
            <span className="inline-flex text-warning" title={t("紀錄降級（recorder_state=degraded）")}>
              <TriangleAlert aria-hidden className="size-3.5" />
              <span className="sr-only">{t("紀錄降級")}</span>
            </span>
          ) : null}
        </span>
      </Td>
      <Td>
        <RevisionCell entry={entry} />
      </Td>
      <Td onClick={(event) => { event.stopPropagation(); }}>
        <IdText value={d.active_call_id} copy={false} />
      </Td>
      <Td>
        <LastErrorCell entry={entry} />
      </Td>
      <td aria-hidden className="border-b border-line-subtle p-0" />
    </Tr>
  );
}

/**
 * 一個 Node 的元件表：依資料夾分組（標題列可收合，收合狀態依 Node 記在這台瀏覽器；篩選中全部展開），
 * 單行列（約 36 px）；欄寬可拖曳、鍵盤或雙擊調整，依表格保存。多出的寬度留在最右側的空白欄。
 * 以 Node 為 key 重建（收合狀態依 Node 讀取）。
 */
export function ComponentTable({
  nodeId,
  entries,
  filtering,
  selectedKey,
  onSelect,
}: {
  nodeId: string;
  /** 這個 Node 篩選後的 instance。 */
  entries: readonly ComponentEntry[];
  filtering: boolean;
  selectedKey: string | null;
  onSelect: (entry: ComponentEntry) => void;
}) {
  const columns = useColumnWidths("admin.components", COMPONENT_COLUMNS);
  const [collapsed, setCollapsed] = usePersistentSet(`admin.components.collapsed.${nodeId}`, []);
  const tree = buildFolderTree(entries, (entry) => folderOf(entry.descriptor));
  const rows = flattenFolderTree(tree, filtering ? new Set<string>() : collapsed);
  const toggle = (path: string) => {
    const next = new Set(collapsed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setCollapsed(next);
  };

  return (
    <TableScroll label={t("元件清單")} className="min-h-0 flex-1 overflow-auto">
      <Table className="table-fixed [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-[1]" style={{ minWidth: columns.total }}>
        <caption className="sr-only">{t("這個 Node 的元件 instance，依資料夾分組；選擇一列開啟右側檢視器。欄寬可用表頭右緣的把手調整。")}</caption>
        <colgroup>
          {COMPONENT_COLUMNS.map((spec) => (
            <col key={spec.id} style={{ width: widthOf(columns.widths, spec) }} />
          ))}
          <col />
        </colgroup>
        <thead>
          <tr>
            {COMPONENT_COLUMNS.map((spec) => (
              <Th key={spec.id} scope="col" title={spec.id === "revision" ? t("已保存 revision／目前載入的 revision") : undefined} className="pr-4">
                <span className="block truncate">{spec.label}</span>
                <ColumnResizer
                  spec={spec}
                  width={widthOf(columns.widths, spec)}
                  onPreview={(width) => { columns.preview(spec.id, width); }}
                  onCommit={(width) => { columns.commit(spec.id, width); }}
                  onReset={() => { columns.reset(spec.id); }}
                />
              </Th>
            ))}
            <th aria-hidden className="border-b border-line-subtle bg-sunken p-0" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) =>
            row.kind === "folder" ? (
              <FolderRow key={`folder:${row.node.path}`} node={row.node} expanded={row.expanded} filtering={filtering} onToggle={() => { toggle(row.node.path); }} />
            ) : (
              <InstanceRow key={row.item.key} entry={row.item} depth={row.depth} selected={row.item.key === selectedKey} onSelect={onSelect} />
            ),
          )}
        </tbody>
      </Table>
    </TableScroll>
  );
}
