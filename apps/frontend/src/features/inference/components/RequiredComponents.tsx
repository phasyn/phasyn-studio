import { CircleCheck, Power, TriangleAlert, X } from "lucide-react";
import { Fragment } from "react";
import { Link } from "react-router";
import { componentPath } from "@/app/paths";
import { ActionButton } from "@/components/common/ActionButton";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Table, TableScroll, Td, Th, Tr } from "@/components/ui/table";
import { providerKind } from "@/components/workbench/kinds";
import { TEXT_TONE } from "@/components/workbench/tones";
import { ToolButton } from "@/components/workbench/ToolStrip";
import { cn } from "@/lib/cn";
import { catalogUnknownText, needsStart, readiness, startBlock, type CatalogStatus, type RequiredComponent } from "../model/components";
import { ProgressTrack } from "@/components/flow/ProgressTrack";
import type { ControlFailure, ControlPhase } from "@/features/components";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

const COLUMNS = 6;

/** 動作欄永遠是同一顆按鈕（狀態改變時焦點不會掉）：不能啟動時保持可聚焦並說明原因。 */
function ActionCell({ item, phase, onStart }: { item: RequiredComponent; phase: ControlPhase | undefined; onStart: () => void }) {
  const block = startBlock(item);
  const state = item.descriptor?.state;
  const ready = state === "ready" || state === "busy";
  const label = phase === "queued" ? t("排隊中（同卡依序）") : phase === "starting" ? t("啟動中…") : ready ? t("已就緒") : state === "error" ? t("重新啟動") : t("啟動");
  const reason = phase
    ? null
    : (block ??
      (ready ? t("已就緒，不需要啟動") : needsStart(item) ? null : state === "loading" ? t("載入中，稍候") : state === "stopping" ? t("停止中，稍候") : t("目前狀態不能啟動")));
  return (
    <ActionButton
      size="sm"
      variant={ready && !phase ? "quiet" : "secondary"}
      icon={ready && !phase ? <CircleCheck aria-hidden className="text-success" /> : <Power aria-hidden />}
      pending={Boolean(phase)}
      disabledReason={reason}
      onClick={onStart}
      title={reason ?? t("只啟動這個元件（載入模型到顯示卡與主記憶體）")}
    >
      {label}
    </ActionButton>
  );
}

/**
 * 「需要的元件」：pipeline 每個步驟的元件、所在 Node、資源群組與狀態；可以只啟動單一元件，
 * 或一次啟動這個元件組合中所有已停止／錯誤的元件（同一張卡依序、不同卡並行）。不會自動重試。
 */
export function RequiredComponents({
  items,
  phase,
  failures,
  onStart,
  onDismiss,
  catalogStatus,
}: {
  items: readonly RequiredComponent[];
  phase: Readonly<Record<string, ControlPhase>>;
  failures: Readonly<Record<string, ControlFailure>>;
  onStart: (items: readonly RequiredComponent[]) => void;
  onDismiss: (key: string) => void;
  /** 目錄還沒讀到或讀取失敗時，元件狀態未知（不顯示成離線或不在目錄）。 */
  catalogStatus: CatalogStatus;
}) {
  const summary = readiness(items);
  const unknownText = catalogUnknownText(catalogStatus);
  const pendingStart = items.filter((item) => needsStart(item) && !phase[item.key]);
  const allReason =
    items.length === 0
      ? t("這個元件組合沒有步驟")
      : pendingStart.length === 0
        ? Object.keys(phase).length > 0
          ? t("啟動進行中")
          : unknownText
            ? t("{unknownText}：無法判斷要啟動哪些元件", { unknownText })
            : summary.ready === summary.total
              ? t("所有元件都已就緒")
              : t("沒有可以啟動的元件（不在目錄、Node 離線或正在載入）")
        : null;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <ActionButton
          size="sm"
          variant="secondary"
          icon={<Power aria-hidden />}
          disabledReason={allReason}
          onClick={() => onStart(pendingStart)}
          title={t("只啟動這個元件組合中已停止或錯誤的元件；同一張卡依序、不同卡並行")}
        >
          {pendingStart.length > 0 ? t("啟動全部需要的元件（{pendingStartCount}）", { pendingStartCount: pendingStart.length }) : t("啟動全部需要的元件")}
        </ActionButton>
        <span className="flex min-w-0 flex-wrap items-center gap-2 text-caption text-fg-tertiary" aria-live="polite">
          {unknownText ? (
            <span className={catalogStatus === "error" ? "text-warning" : undefined}>{`${unknownText}${catalogStatus === "loading" ? "…" : ""}`}</span>
          ) : (
            <>
              <ProgressTrack
                value={summary.ready}
                max={Math.max(1, summary.total)}
                tone={Object.keys(phase).length > 0 ? "running" : summary.ready === summary.total ? "done" : "idle"}
                label={t("需要的元件就緒數")}
                valueText={t("就緒 {ready}／{total}", { ready: summary.ready, total: summary.total })}
                size="sm"
                className="w-28"
              />
              <span className="machine">{t("就緒 {ready}／{total}{value}{value2}", { ready: summary.ready, total: summary.total, value: summary.unavailable > 0 ? t("・無法使用 {unavailable}", { unavailable: summary.unavailable }) : "", value2: catalogStatus === "stale" ? t("・目錄更新失敗，狀態可能過時") : "" })}</span>
            </>
          )}
        </span>
      </div>
      <p className="text-caption text-fg-tertiary">
        {t("GPU 元件預設不自動啟動；啟動會把模型載入顯示卡與主記憶體，耗時依模型大小與儲存裝置而定（各元件最近一次的實際載入耗時見元件頁的 load 效能紀錄）。GPU 或主記憶體正被其他工作佔用時，不要啟動大型模型。未就緒的元件會讓 run 在該步驟失敗（不會自動啟動或重試）。")}
      </p>
      <TableScroll label={t("需要的元件")} className="relative">
        <Table className="min-w-[50rem] table-fixed">
          <colgroup>
            <col />
            <col className="w-32" />
            <col className="w-40" />
            <col className="w-28" />
            <col className="w-24" />
            <col className="w-48" />
          </colgroup>
          <thead>
            <tr>
              <Th scope="col">{t("元件")}</Th>
              <Th scope="col">{t("步驟")}</Th>
              <Th scope="col">Node</Th>
              <Th scope="col">{t("資源群組")}</Th>
              <Th scope="col">{t("狀態")}</Th>
              <Th scope="col">{t("動作")}</Th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const kind = providerKind(item.descriptor?.provider_id);
              const failure = failures[item.key];
              return (
                <Fragment key={item.key}>
                  <Tr>
                    <Td className="py-1.5">
                      <Link to={componentPath(item.nodeId, item.componentId)} className="flex min-w-0 items-center gap-2 no-underline hover:underline" title={t("在元件頁開啟 {componentId}", { componentId: item.componentId })}>
                        <kind.icon aria-hidden className={cn("size-4 shrink-0", TEXT_TONE[kind.tone])} />
                        <span className="min-w-0 truncate text-fg">{item.descriptor?.label || item.componentId}</span>
                      </Link>
                      <code className="machine block truncate text-caption text-fg-tertiary">{item.componentId}</code>
                    </Td>
                    <Td className="machine text-caption text-fg-secondary">{formatList(item.stepIds)}</Td>
                    <Td>
                      <span className="block truncate text-fg-secondary" title={item.nodeLabel}>
                        {item.nodeLabel}
                      </span>
                      {item.nodeStale ? (
                        <span className="inline-flex items-center gap-1 text-caption text-warning">
                          <TriangleAlert aria-hidden className="size-3" />
                          {t("離線（狀態過時）")}
                        </span>
                      ) : null}
                    </Td>
                    <Td className="machine text-caption text-fg-secondary">
                      {item.descriptor ? (
                        <span title={`${item.descriptor.device.kind} · ${item.descriptor.device.id}`}>{item.descriptor.device.resource_group}</span>
                      ) : (
                        "—"
                      )}
                    </Td>
                    <Td>
                      {item.descriptor ? (
                        <StatusBadge kind="component" value={item.descriptor.state} />
                      ) : item.known ? (
                        <Badge tone="warning">{t("不在目錄")}</Badge>
                      ) : (
                        <Badge>{catalogStatus === "loading" ? t("讀取中") : t("狀態未知")}</Badge>
                      )}
                    </Td>
                    <Td className="py-1.5">
                      <ActionCell item={item} phase={phase[item.key]} onStart={() => onStart([item])} />
                    </Td>
                  </Tr>
                  {failure ? (
                    <tr className="bg-sunken/50">
                      <td colSpan={COLUMNS} className="border-b border-line-subtle px-4 py-1.5">
                        <span role="alert" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption">
                          <span className={cn("font-medium", failure.skipped ? "text-warning" : "text-danger")}>{failure.skipped ? t("沒有送出") : failure.unknown ? t("遠端結果未知") : t("啟動失敗")}</span>
                          <span className="min-w-0 text-fg-secondary [overflow-wrap:anywhere]">{failure.message}</span>
                          {failure.unknown ? <span className="text-warning">{t("Node 可能仍在載入：請看狀態欄，不會自動重送。")}</span> : null}
                          <ToolButton label={t("關閉這則訊息")} icon={<X aria-hidden />} onClick={() => onDismiss(item.key)} className="ml-auto" />
                        </span>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </Table>
      </TableScroll>
    </div>
  );
}
