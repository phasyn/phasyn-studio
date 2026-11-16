// 部件：summary.part_totals 可排序表格。host 是 inclusive host span（含子部件）；gpu_event 是 CUDA event 區間並附 coverage。
// 選取一列 → 右側檢視器顯示該 part 的搬運、step 與設定細節。
import { ArrowDown, ArrowUp, ArrowUpDown, Puzzle, Search } from "lucide-react";
import { useId, useMemo, useState, type ReactNode } from "react";
import type { Recording } from "@/api/generated/contracts";
import { EmptyState } from "@/components/common/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/controls";
import { Table, TableScroll, Td, Th, Tr } from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { formatBytes, formatCount, formatMs } from "@/lib/format";
import { partRows, sortPartRows, type PartSortKey, type SortDirection } from "../model/parts";
import { t, tServer } from "@/i18n";
import { T } from "@/i18n/T";

const SORT_LABEL: Record<PartSortKey, string> = {
  part: "part",
  calls: t("呼叫次數"),
  host: t("host（inclusive）"),
  gpu: "GPU event",
  bytes: "weight_h2d bytes",
};

function SortHeader({
  sortKey,
  current,
  direction,
  onSort,
  children,
}: {
  sortKey: PartSortKey;
  current: PartSortKey;
  direction: SortDirection;
  onSort: (key: PartSortKey) => void;
  children: ReactNode;
}) {
  const active = current === sortKey;
  const Icon = !active ? ArrowUpDown : direction === "asc" ? ArrowUp : ArrowDown;
  return (
    <Th scope="col" aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex min-h-8 items-center gap-1 rounded-sm text-left transition-colors duration-(--duration-fast) pointer-coarse:min-h-11",
          active ? "text-fg" : "text-fg-tertiary hover:text-fg",
        )}
      >
        {children}
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="sr-only">{t("，依{sortKey}排序", { sortKey: SORT_LABEL[sortKey] })}</span>
      </button>
    </Th>
  );
}

export function PartsTab({
  recording,
  selectedPart,
  onSelectPart,
}: {
  recording: Recording;
  selectedPart: string | null;
  onSelectPart: (part: string) => void;
}) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<PartSortKey>("host");
  const [direction, setDirection] = useState<SortDirection>("desc");
  const rows = useMemo(() => partRows(recording.summary), [recording.summary]);
  const hasExclusive = rows.some((row) => row.hostMsExclusive !== null);
  const sorted = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle ? rows.filter((row) => row.part.toLowerCase().includes(needle)) : rows;
    return sortPartRows(filtered, sortKey, direction);
  }, [rows, query, sortKey, direction]);

  const onSort = (key: PartSortKey) => {
    if (key === sortKey) setDirection((current) => (current === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setDirection(key === "part" ? "asc" : "desc");
    }
  };

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Puzzle />}
        title={t("此 recording 沒有部件彙整")}
        description={
          <p>
            <T source={"recorder 模式為 <0>{mode}</0>；summary／off 模式不保存每 part 細節，或此元件沒有回報 parts。這不代表各部件耗時為 0。"} values={{ mode: recording.context.recording.mode }} slots={[<code className="machine" />]} />
          </p>
        }
        className="rounded-lg border border-line-subtle bg-sunken"
      />
    );
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid w-full max-w-sm gap-1">
          <label htmlFor={searchId} className="text-caption text-fg-tertiary">
            {t("篩選 part（包含文字）")}
          </label>
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-tertiary" />
            <Input id={searchId} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("例如 blocks.12")} className="pl-9 machine" />
          </div>
        </div>
        <p className="text-caption text-fg-tertiary" aria-live="polite">
          {t("{sortedCount} / {rowsCount} 個 part", { sortedCount: sorted.length.toLocaleString("en-US"), rowsCount: rows.length.toLocaleString("en-US") })}
        </p>
      </div>
      <p className="text-caption text-fg-tertiary">
        {t("host 欄是 host span 的 inclusive 時間（含子部件，父子相加會重複）；exclusive 只有 summary 明確提供時才顯示，不由前端相減。GPU event 是 CUDA event 區間（可能含等待），coverage=partial 表示 compiled／fused 區域未被 hook 覆蓋。")}
      </p>
      <TableScroll label={t("部件彙整")}>
        <Table>
          <thead>
            <tr>
              <SortHeader sortKey="part" current={sortKey} direction={direction} onSort={onSort}>
                part
              </SortHeader>
              <SortHeader sortKey="calls" current={sortKey} direction={direction} onSort={onSort}>
                {t("呼叫次數")}
              </SortHeader>
              <SortHeader sortKey="host" current={sortKey} direction={direction} onSort={onSort}>
                {t("host（inclusive）")}
              </SortHeader>
              {hasExclusive ? <Th scope="col">{t("host（exclusive）")}</Th> : null}
              <SortHeader sortKey="gpu" current={sortKey} direction={direction} onSort={onSort}>
                GPU event · coverage
              </SortHeader>
              <SortHeader sortKey="bytes" current={sortKey} direction={direction} onSort={onSort}>
                {t("搬運（逐類別）")}
              </SortHeader>
              <Th scope="col">counters</Th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => {
              const selected = row.part === selectedPart;
              return (
                <Tr key={row.part} selected={selected}>
                  <Td className="min-w-[14rem]">
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={() => onSelectPart(row.part)}
                      className="machine min-h-8 rounded-sm text-left text-action-fg hover:underline pointer-coarse:min-h-11"
                      style={{ paddingInlineStart: `${Math.min(row.depth, 8) * 0.75}rem` }}
                    >
                      {row.part}
                    </button>
                  </Td>
                  <Td className="machine whitespace-nowrap">{row.calls === null ? <span className="text-warning">{t("未量測")}</span> : formatCount(row.calls)}</Td>
                  <Td className="machine whitespace-nowrap">
                    {row.hostMsInclusive === null ? <span className="text-warning">{t("未量測")}</span> : formatMs(row.hostMsInclusive)}
                  </Td>
                  {hasExclusive ? (
                    <Td className="machine whitespace-nowrap">{row.hostMsExclusive === null ? <span className="text-fg-tertiary">{t("未提供")}</span> : formatMs(row.hostMsExclusive)}</Td>
                  ) : null}
                  <Td className="whitespace-nowrap">
                    <span className="machine">{row.gpuEventMs === null ? <span className="text-warning">{t("未量測")}</span> : formatMs(row.gpuEventMs)}</span>
                    {row.gpuEventCoverage ? (
                      <Badge tone={row.gpuEventCoverage === "full" ? "neutral" : "warning"} className="ml-2">
                        {row.gpuEventCoverage}
                      </Badge>
                    ) : null}
                    {row.coverageReason ? <span className="block max-w-[18rem] text-caption whitespace-normal text-warning">{tServer(row.coverageReason)}</span> : null}
                  </Td>
                  <Td className="text-caption">
                    {row.transfers.length === 0 ? (
                      <span className="text-fg-tertiary">—</span>
                    ) : (
                      <ul className="grid gap-0.5">
                        {row.transfers.map((transfer) => (
                          <li key={transfer.category} className="machine whitespace-nowrap text-fg-secondary">
                            {t("{category} {value} 次 ·{text}{value2}", { category: transfer.category, value: transfer.count === null ? "?" : formatCount(transfer.count), text: " ", value2: transfer.bytes === null ? t("未確認") : formatBytes(transfer.bytes) })}
                          </li>
                        ))}
                      </ul>
                    )}
                  </Td>
                  <Td className="text-caption">
                    {row.counters.length === 0 ? (
                      <span className="text-fg-tertiary">—</span>
                    ) : (
                      <ul className="grid gap-0.5">
                        {row.counters.map(([name, value]) => (
                          <li key={name} className="machine whitespace-nowrap text-fg-secondary">
                            {name} {value === null ? <span className="text-warning">{t("未量測")}</span> : formatCount(value)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </TableScroll>
    </div>
  );
}
