// 儲存空間（紀錄區）：三個分頁。總覽＝主控與各 Node 的磁碟用量、各類別可回收的量與每個專案的媒體；清理＝選類別
// 與規則 → 試算列出會刪除的項目（可取消勾選）→ 一次確認 → 逐項結果；釘選＝清理永遠不回收的 run 與檔案。
// 刪除只送一次、不自動重試；伺服器在刪除前重新計算，只動列出且仍符合條件的項目。
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, HardDrive, Pin, RefreshCw, Search, Trash2, TriangleAlert } from "lucide-react";
import { useId, useRef, useState } from "react";
import type { StorageCategory, StorageCleanResult, StorageItem, StorageTotal, StorageUsage, StorageWork } from "@/api/generated/contracts";
import { cleanStorage, storageKeys, updateStoragePins, useStoragePins, useStorageUsage } from "@/api/storage";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { PageHeader } from "@/components/common/PageHeader";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Checkbox, Input } from "@/components/ui/controls";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableScroll, Td, Th, Tr } from "@/components/ui/table";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { t, tServer } from "@/i18n";
import {
  applyRequest,
  CATEGORY_SPECS,
  categorySpec,
  DEFAULT_FORM,
  isRunId,
  parseFileKey,
  planRequest,
  resultCounts,
  selectedItems,
  statusLabel,
  tallyByCategory,
  workCleanupText,
  type CleanForm,
} from "./storageModel";

type TabId = "overview" | "clean" | "pins";

function TotalCell({ total }: { total: StorageTotal | null }) {
  if (total === null) return <span className="text-fg-tertiary">—</span>;
  return (
    <span className="tabular-nums">
      {formatBytes(total.size_bytes)}
      <span className="ml-1.5 text-caption text-fg-tertiary">{t("{count} 項", { count: total.count })}</span>
    </span>
  );
}

function WorkCell({ work }: { work: StorageWork | null | undefined }) {
  if (!work) return <span className="text-fg-tertiary" title={t("這個 Node 版本沒有回報工作目錄")}>—</span>;
  return (
    <span title={workCleanupText(work)} className="inline-flex items-center gap-1.5">
      <TotalCell total={{ count: work.count, size_bytes: work.size_bytes }} />
      {!work.enabled ? <span className="text-caption text-warning">{t("不自動清理")}</span> : null}
    </span>
  );
}

function UsageBar({ value, max }: { value: number; max: number }) {
  const share = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <span aria-hidden className="block h-1.5 w-full overflow-hidden rounded-full bg-line-subtle">
      <span className="block h-full rounded-full bg-brand-gradient-soft transition-[width] duration-500" style={{ width: `${String(Math.round(share * 100))}%` }} />
    </span>
  );
}

function Overview({ usage }: { usage: StorageUsage }) {
  const reclaim = CATEGORY_SPECS.map((spec) => ({ spec, total: usage.reclaimable[spec.id] }));
  const largest = Math.max(1, ...reclaim.map((row) => row.total.size_bytes));
  const projects = usage.projects.slice(0, 50);
  const biggest = Math.max(1, ...projects.map((row) => row.size_bytes));
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section aria-labelledby="storage-disks" className="grid content-start gap-2">
        <h3 id="storage-disks" className="text-section font-semibold text-fg">{t("磁碟用量")}</h3>
        <TableScroll label={t("磁碟用量")}>
          <Table>
            <thead>
              <tr>
                <Th>{t("位置")}</Th>
                <Th>{t("檔案")}</Th>
                <Th>{t("下載副本")}</Th>
                <Th>{t("run")}</Th>
                <Th>{t("效能紀錄")}</Th>
                <Th>{t("工作暫存")}</Th>
              </tr>
            </thead>
            <tbody>
              <Tr>
                <Td className="text-fg">{t("主控")}</Td>
                <Td><TotalCell total={usage.controller.files} /></Td>
                <Td><span className="text-fg-tertiary">—</span></Td>
                <Td><TotalCell total={usage.controller.runs} /></Td>
                <Td><TotalCell total={usage.controller.recordings} /></Td>
                <Td><span className="text-fg-tertiary">—</span></Td>
              </Tr>
              {usage.nodes.map((node) => (
                <Tr key={node.node_id}>
                  <Td className="text-fg" title={node.message === undefined ? node.node_id : tServer(node.message)}>
                    {node.label}
                    {node.state !== "ok" ? <span className="ml-2 text-caption text-warning">{node.state === "unsupported" ? t("需更新 Node") : t("讀不到")}</span> : null}
                  </Td>
                  <Td><TotalCell total={node.files} /></Td>
                  <Td><TotalCell total={node.remote_cache} /></Td>
                  <Td><span className="text-fg-tertiary">—</span></Td>
                  <Td><TotalCell total={node.recordings} /></Td>
                  <Td><WorkCell work={node.work} /></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableScroll>
        <h3 className="mt-2 text-section font-semibold text-fg">{t("可回收（預設規則）")}</h3>
        <ul className="grid gap-2" aria-label={t("各類別可回收的空間")}>
          {reclaim.map(({ spec, total }) => (
            <li key={spec.id} className="grid gap-1 rounded-lg border border-line-subtle bg-sunken/40 px-3 py-2" title={spec.description}>
              <span className="flex items-baseline justify-between gap-3 text-data">
                <span className="text-fg">{spec.label}</span>
                <TotalCell total={total} />
              </span>
              <UsageBar value={total.size_bytes} max={largest} />
            </li>
          ))}
        </ul>
        {usage.standalone_runs.count > 0 ? (
          <p className="text-caption text-fg-tertiary" title={t("phasynctl 或實驗直接建立的 run；在「清理」勾選「也包含不屬於任何專案的 run」才會列出")}>
            {t("另有 {count} 個不屬於任何專案的 run（{size}）", { count: usage.standalone_runs.count, size: formatBytes(usage.standalone_runs.size_bytes) })}
          </p>
        ) : null}
      </section>
      <section aria-labelledby="storage-projects" className="grid min-w-0 content-start gap-2">
        <h3 id="storage-projects" className="text-section font-semibold text-fg">{t("各專案的媒體")}</h3>
        <TableScroll label={t("各專案的媒體")} className="max-h-[32rem]">
          <Table>
            <thead>
              <tr>
                <Th>{t("專案")}</Th>
                <Th title={t("專案與它的 run 引用的影片、圖片與上傳檔")}>{t("媒體")}</Th>
                <Th title={t("只有這個專案用到的部分：刪除專案時可一併清除")}>{t("專屬")}</Th>
                <Th>{t("run")}</Th>
              </tr>
            </thead>
            <tbody>
              {projects.map((row) => (
                <Tr key={row.project_id}>
                  <Td className="max-w-56 truncate text-fg" title={`${row.title}\n${row.project_id}`}>{row.title}</Td>
                  <Td className="min-w-32">
                    <span className="grid gap-1">
                      <span className="tabular-nums">{formatBytes(row.size_bytes)}</span>
                      <UsageBar value={row.size_bytes} max={biggest} />
                    </span>
                  </Td>
                  <Td className="tabular-nums">{formatBytes(row.exclusive_bytes)}</Td>
                  <Td className="tabular-nums">{row.runs}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableScroll>
        <p className="text-caption text-fg-tertiary">{t("釘選的 run 與檔案：{pins} 個", { pins: usage.pins })}</p>
      </section>
    </div>
  );
}

function StatusIcon({ status }: { status: StorageItem["status"] }) {
  if (status === "deleted" || status === "missing") return <CircleCheck aria-hidden className="size-4 text-success" />;
  if (status === "failed") return <CircleAlert aria-hidden className="size-4 text-danger" />;
  if (status === "planned") return <Trash2 aria-hidden className="size-4 text-fg-tertiary" />;
  return <TriangleAlert aria-hidden className="size-4 text-warning" />;
}

function ItemTable({ items, selected, onToggle }: { items: readonly StorageItem[]; selected?: ReadonlySet<string>; onToggle?: (id: string) => void }) {
  return (
    <TableScroll label={t("項目")} className="max-h-[28rem]">
      <Table>
        <thead>
          <tr>
            {onToggle ? <Th className="w-10"><span className="sr-only">{t("選取")}</span></Th> : null}
            <Th>{t("狀態")}</Th>
            <Th>{t("類別")}</Th>
            <Th>{t("項目")}</Th>
            <Th>{t("大小")}</Th>
            <Th>{t("說明")}</Th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <Tr key={item.item_id}>
              {onToggle && selected ? (
                <Td>
                  <input
                    type="checkbox"
                    className="size-4 cursor-pointer accent-action"
                    aria-label={t("刪除「{label}」", { label: item.label })}
                    checked={selected.has(item.item_id)}
                    onChange={() => { onToggle(item.item_id); }}
                  />
                </Td>
              ) : null}
              <Td><span className="inline-flex items-center gap-1.5"><StatusIcon status={item.status} />{statusLabel(item.status)}</span></Td>
              <Td className="whitespace-nowrap">{categorySpec(item.category).label}</Td>
              <Td className="max-w-72 truncate text-fg" title={`${item.label}\n${item.item_id}`}>{item.label}</Td>
              <Td className="tabular-nums whitespace-nowrap">{formatBytes(item.size_bytes)}</Td>
              <Td className={cn("max-w-80 truncate", item.status === "failed" ? "text-danger" : "text-fg-tertiary")} title={tServer(item.message ?? item.reason ?? "")}>
                {tServer(item.message ?? item.reason ?? "")}
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </TableScroll>
  );
}

export function CleanPanel() {
  const client = useQueryClient();
  const formId = useId();
  const [form, setForm] = useState<CleanForm>(DEFAULT_FORM);
  const [plan, setPlan] = useState<StorageCleanResult | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [result, setResult] = useState<StorageCleanResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<"plan" | "apply" | null>(null);
  const [confirming, setConfirming] = useState(false);
  // One deletion per confirmation, however fast the button is pressed (never retried)
  const sentRef = useRef(false);

  const toggleCategory = (id: StorageCategory, on: boolean) => {
    setForm((previous) => ({ ...previous, categories: on ? [...previous.categories, id] : previous.categories.filter((c) => c !== id) }));
    setPlan(null);
    setResult(null);
  };
  const runPlan = async () => {
    if (busy !== null || form.categories.length === 0) return;
    setBusy("plan");
    setError(null);
    setResult(null);
    try {
      const found = await cleanStorage(planRequest(form));
      setPlan(found);
      setSelected(new Set(found.items.map((item) => item.item_id)));
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  };
  const runApply = async () => {
    const body = plan ? applyRequest(plan, selected) : null;
    if (body === null || sentRef.current) return;
    sentRef.current = true;
    setBusy("apply");
    setError(null);
    try {
      setResult(await cleanStorage(body));
      setPlan(null);
      setConfirming(false);
    } catch (cause) {
      setError(cause);
      setConfirming(false);
    } finally {
      sentRef.current = false;
      setBusy(null);
      void client.invalidateQueries({ queryKey: storageKeys.all() });
      void client.invalidateQueries({ queryKey: ["runs"] });
      void client.invalidateQueries({ queryKey: ["recordings"] });
    }
  };
  const chosen = plan ? selectedItems(plan, selected) : [];
  const tally = tallyByCategory(chosen);
  const chosenBytes = chosen.reduce((sum, item) => sum + (item.size_bytes ?? 0), 0);
  const warnings = CATEGORY_SPECS.filter((spec) => spec.warning !== undefined && (tally.get(spec.id)?.count ?? 0) > 0);
  const counts = result ? resultCounts(result) : null;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)]">
      <fieldset className="grid content-start gap-1 rounded-xl border border-line-subtle bg-sunken/30 p-3" aria-describedby={`${formId}-rules`}>
        <legend className="px-1 text-section font-semibold text-fg">{t("要清理的類別")}</legend>
        {CATEGORY_SPECS.map((spec) => (
          <Checkbox
            key={spec.id}
            id={`${formId}-${spec.id}`}
            label={spec.label}
            description={spec.description}
            checked={form.categories.includes(spec.id)}
            onChange={(event) => { toggleCategory(spec.id, event.target.checked); }}
          />
        ))}
        <div id={`${formId}-rules`} className="mt-2 grid gap-3 border-t border-line-subtle pt-3">
          <label className="grid gap-1 text-data text-fg-secondary">
            {t("run 與檔案至少多舊（小時）")}
            <Input type="number" min={1} max={87600} compact value={form.minAgeHours} title={t("保護剛上傳、還沒存進專案的檔案")} onChange={(event) => { setForm({ ...form, minAgeHours: Number(event.target.value) }); setPlan(null); }} />
          </label>
          {form.categories.includes("recordings") ? (
            <label className="grid gap-1 text-data text-fg-secondary">
              {t("效能紀錄超過幾天")}
              <Input type="number" min={1} max={3650} compact value={form.recordingsDays} onChange={(event) => { setForm({ ...form, recordingsDays: Number(event.target.value) }); setPlan(null); }} />
            </label>
          ) : null}
          {form.categories.includes("runs") ? (
            <Checkbox
              id={`${formId}-standalone`}
              label={t("也包含不屬於任何專案的 run")}
              title={t("phasynctl 或實驗直接建立的 run；實驗要保留的證據請先釘選")}
              checked={form.includeStandalone}
              onChange={(event) => { setForm({ ...form, includeStandalone: event.target.checked }); setPlan(null); }}
            />
          ) : null}
        </div>
        <Button variant="primary" className="mt-3" icon={<Search aria-hidden />} pending={busy === "plan"} disabled={form.categories.length === 0} onClick={() => void runPlan()}>
          {t("試算可回收的空間")}
        </Button>
      </fieldset>
      <section aria-label={t("清理計畫與結果")} aria-live="polite" className="grid min-w-0 content-start gap-3">
        {error !== null ? <ErrorCallout error={error} write={busy === "apply"} title={t("清理沒有完成")} /> : null}
        {result && counts ? (
          <>
            <Callout tone={counts.failed > 0 ? "warning" : "success"} title={t("已釋放 {bytes}", { bytes: formatBytes(counts.bytes) })}>
              {t("已刪除 {gone} 項，保留 {kept} 項，未變更 {skipped} 項，失敗 {failed} 項。", counts)}
            </Callout>
            <ItemTable items={result.items} />
          </>
        ) : plan ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-data text-fg-secondary">
                {plan.items.length === 0
                  ? t("目前沒有可回收的項目。")
                  : t("勾選 {count} 項，約 {bytes}", { count: chosen.length, bytes: formatBytes(chosenBytes) })}
                {plan.truncated ? t("（每個類別最多列出 2000 項，清理後再試算一次可看到其餘的）") : ""}
              </p>
              <div className="flex gap-2">
                {plan.items.length > 0 ? (
                  <Button size="sm" variant="quiet" onClick={() => { setSelected(selected.size === plan.items.length ? new Set() : new Set(plan.items.map((item) => item.item_id))); }}>
                    {selected.size === plan.items.length ? t("全部取消") : t("全選")}
                  </Button>
                ) : null}
                <Button size="sm" variant="danger-confirm" icon={<Trash2 aria-hidden />} disabled={chosen.length === 0} onClick={() => { setConfirming(true); }}>
                  {t("刪除 {count} 項", { count: chosen.length })}
                </Button>
              </div>
            </div>
            {plan.nodes.filter((node) => node.state !== "ok").map((node) => (
              <Callout key={node.node_id} tone="warning" title={t("Node {label} 的檔案沒有列入", { label: node.label })}>
                {tServer(node.message ?? "")}
              </Callout>
            ))}
            {plan.items.length > 0 ? (
              <ItemTable
                items={plan.items}
                selected={selected}
                onToggle={(id) => { setSelected((previous) => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }}
              />
            ) : null}
          </>
        ) : (
          <p className="rounded-xl border border-dashed border-line-subtle p-6 text-center text-data text-fg-tertiary">
            {t("選好類別後按「試算可回收的空間」：先列出會刪除的項目，確認後才會刪除。")}
          </p>
        )}
      </section>
      <Dialog open={confirming} onOpenChange={(open) => { if (busy !== "apply") setConfirming(open); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("永久刪除 {count} 項（{bytes}）？", { count: chosen.length, bytes: formatBytes(chosenBytes) })}</DialogTitle>
            <DialogDescription>{t("無法復原。刪除前會重新檢查每一項：此後被專案、執行中的 run 或釘選項目用到的會保留。")}</DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-2">
            <ul className="grid gap-1 text-data" aria-label={t("刪除範圍")}>
              {[...tally.entries()].map(([category, value]) => (
                <li key={category} className="flex justify-between gap-3">
                  <span className="text-fg">{categorySpec(category).label}</span>
                  <span className="tabular-nums text-fg-secondary">{t("{count} 項・{bytes}", { count: value.count, bytes: formatBytes(value.bytes) })}</span>
                </li>
              ))}
            </ul>
            {warnings.map((spec) => (
              <Callout key={spec.id} tone="warning" title={spec.label}>{spec.warning}</Callout>
            ))}
          </DialogBody>
          <DialogFooter>
            <Button size="sm" disabled={busy === "apply"} onClick={() => { setConfirming(false); }}>{t("取消")}</Button>
            <Button size="sm" variant="danger-confirm" icon={<Trash2 aria-hidden />} pending={busy === "apply"} onClick={() => void runApply()}>
              {t("永久刪除")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PinsPanel() {
  const client = useQueryClient();
  const pins = useStoragePins();
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const fileKey = parseFileKey(text);
  const valid = isRunId(text) || fileKey !== null;
  const send = async (body: Parameters<typeof updateStoragePins>[0]) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      client.setQueryData(storageKeys.pins(), await updateStoragePins(body));
      setText("");
      setNote("");
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
      void client.invalidateQueries({ queryKey: storageKeys.usage() });
    }
  };
  const add = () => {
    if (!valid) return;
    const pin = fileKey ? { kind: "file" as const, ...fileKey } : { kind: "run" as const, run_id: text.trim().toLowerCase() };
    void send({ add: [{ ...pin, ...(note.trim() ? { note: note.trim() } : {}) }] });
  };
  return (
    <div className="grid gap-3">
      <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); add(); }}>
        <label className="grid min-w-72 flex-1 gap-1 text-data text-fg-secondary">
          {t("run ID，或 NODE_ID/FILE_ID")}
          <Input compact value={text} onChange={(event) => { setText(event.target.value); }} aria-invalid={text !== "" && !valid} />
        </label>
        <label className="grid min-w-56 flex-1 gap-1 text-data text-fg-secondary">
          {t("備註")}
          <Input compact maxLength={500} value={note} onChange={(event) => { setNote(event.target.value); }} />
        </label>
        <Button type="submit" size="sm" variant="primary" icon={<Pin aria-hidden />} pending={pending} disabled={!valid}>{t("釘選")}</Button>
      </form>
      {error !== null ? <ErrorCallout error={error} write /> : null}
      {pins.isError ? <ErrorCallout error={pins.error} title={t("無法讀取釘選清單")} onRetry={() => void pins.refetch()} /> : null}
      <TableScroll label={t("釘選的 run 與檔案")} className="max-h-[30rem]">
        <Table>
          <thead>
            <tr>
              <Th>{t("類型")}</Th>
              <Th>{t("ID")}</Th>
              <Th>{t("備註")}</Th>
              <Th>{t("釘選時間")}</Th>
              <Th><span className="sr-only">{t("動作")}</span></Th>
            </tr>
          </thead>
          <tbody>
            {(pins.data?.items ?? []).map((pin) => {
              const id = pin.kind === "run" ? (pin.run_id ?? "") : `${pin.node_id ?? ""}/${pin.file_id ?? ""}`;
              return (
                <Tr key={`${pin.kind}:${id}`}>
                  <Td>{pin.kind === "run" ? t("run") : t("檔案")}</Td>
                  <Td className="machine max-w-80 truncate" title={id}>{id}</Td>
                  <Td className="max-w-64 truncate" title={pin.note ?? ""}>{pin.note ?? ""}</Td>
                  <Td className="whitespace-nowrap text-fg-tertiary">{pin.pinned_at ?? ""}</Td>
                  <Td>
                    <Button size="sm" variant="quiet" disabled={pending} onClick={() => void send({ remove: [pin] })}>{t("取消釘選")}</Button>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </TableScroll>
      {pins.data?.items.length === 0 ? <p className="text-data text-fg-tertiary">{t("還沒有釘選的項目。實驗要保留的 run 或檔案釘選在這裡，清理就不會回收它們。")}</p> : null}
    </div>
  );
}

export function StoragePage() {
  const usage = useStorageUsage();
  const [tab, setTab] = useState<TabId>("overview");
  const tabsId = useId();
  return (
    <div className="grid gap-4 p-4">
      <PageHeader
        title={t("儲存空間")}
        icon={<HardDrive aria-hidden className="size-5" />}
        description={t("磁碟用量與清理：只回收沒有任何專案、run、計畫或釘選項目引用的資料")}
        actions={
          <Button size="sm" icon={<RefreshCw aria-hidden />} pending={usage.isFetching} onClick={() => void usage.refetch()}>
            {t("重新整理")}
          </Button>
        }
      />
      <Tabs
        items={[
          { id: "overview", label: t("總覽") },
          { id: "clean", label: t("清理") },
          { id: "pins", label: t("釘選項目") },
        ]}
        value={tab}
        onChange={(id) => { setTab(id === "clean" || id === "pins" ? id : "overview"); }}
        idPrefix={tabsId}
        label={t("儲存空間分頁")}
      />
      <TabPanel idPrefix={tabsId} id={tab} className="min-w-0">
        {tab === "overview" ? (
          usage.isPending ? (
            <div role="status" className="grid gap-2">
              <p className="text-data text-fg-secondary">{t("正在統計主控與各 Node 的磁碟用量…")}</p>
              <span aria-hidden className="block h-1 overflow-hidden rounded-full bg-line-subtle">
                <span className="block h-full w-full rounded-full bg-brand-gradient-soft animate-shimmer" />
              </span>
            </div>
          ) : usage.isError ? (
            <ErrorCallout error={usage.error} title={t("無法讀取儲存空間")} onRetry={() => void usage.refetch()} retrying={usage.isFetching} />
          ) : (
            <Overview usage={usage.data} />
          )
        ) : tab === "clean" ? (
          <CleanPanel />
        ) : (
          <PinsPanel />
        )}
      </TabPanel>
    </div>
  );
}
