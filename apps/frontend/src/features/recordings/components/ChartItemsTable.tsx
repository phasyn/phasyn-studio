// 時間軸的表格替代：同一份項目以表格列出（開始、長度、泳道），供鍵盤與螢幕閱讀器使用，也能看到被省略的項目。
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Table, TableScroll, Td, Th, Tr } from "@/components/ui/table";
import { formatMs } from "@/lib/format";
import type { ChartGroup, ChartItem } from "../model/timeline";
import { LoadMoreButton } from "./Feedback";
import { t } from "@/i18n";

const PAGE = 300;

export function ChartItemsTable({
  group,
  selectedKey,
  onSelect,
}: {
  group: ChartGroup;
  selectedKey: string | null;
  onSelect?: (item: ChartItem) => void;
}) {
  const [limit, setLimit] = useState(PAGE);
  const rows = useMemo(
    () =>
      group.lanes
        .flatMap((lane) => lane.items.map((item) => ({ lane: lane.label, item })))
        .sort((a, b) => a.item.startMs - b.item.startMs || a.lane.localeCompare(b.lane)),
    [group],
  );
  const visible = rows.slice(0, limit);
  return (
    <div className="grid gap-2">
      <TableScroll label={t("時間軸項目表格：{title}", { title: group.title })}>
        <Table>
          <thead>
            <tr>
              <Th scope="col">{t("開始（相對）")}</Th>
              <Th scope="col">{t("長度")}</Th>
              <Th scope="col">{t("泳道")}</Th>
              <Th scope="col">{t("項目")}</Th>
              <Th scope="col">part</Th>
              <Th scope="col">
                <span className="sr-only">{t("動作")}</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {visible.map(({ lane, item }) => (
              <Tr key={item.key} selected={item.key === selectedKey}>
                <Td className="machine whitespace-nowrap">{formatMs(item.startMs)}</Td>
                <Td className="machine whitespace-nowrap">{item.endMs === null ? <span className="text-fg-tertiary">{t("刻度（無起點）")}</span> : formatMs(item.endMs - item.startMs)}</Td>
                <Td className="text-fg-secondary">{lane}</Td>
                <Td className="min-w-[14rem] break-words">{item.label}</Td>
                <Td className="machine text-caption text-fg-tertiary">{item.part ?? "—"}</Td>
                <Td>
                  {onSelect ? (
                    <Button size="sm" variant="quiet" onClick={() => onSelect(item)} className="pointer-coarse:min-h-11" aria-label={t("在右側檢視器檢視：{label}", { label: item.label })}>
                      {t("檢視")}
                    </Button>
                  ) : null}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableScroll>
      <div className="flex flex-wrap items-center gap-2 text-caption text-fg-tertiary">
        <span>
          {t("顯示 {visibleCount} / {rowsCount} 項", { visibleCount: visible.length.toLocaleString("en-US"), rowsCount: rows.length.toLocaleString("en-US") })}
        </span>
        {rows.length > PAGE ? (
          <LoadMoreButton
            onLoad={() => setLimit((current) => current + PAGE)}
            pending={false}
            hasMore={rows.length > limit}
            label={t("再顯示 {min} 項", { min: Math.min(PAGE, Math.max(0, rows.length - limit)) })}
            doneLabel={t("已全部顯示")}
          />
        ) : null}
      </div>
    </div>
  );
}
