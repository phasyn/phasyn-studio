import type { FrozenRunSubmission } from "@/api/runs";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import type { PlacementAlternative } from "@/api/generated/contracts";
import { usePipelines } from "@/api/pipelines";
import { useRunList } from "@/api/runs";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { JsonView } from "@/components/common/JsonView";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/controls";
import { t } from "@/i18n";
import { formatBytes } from "@/lib/format";
import { isRecord } from "@/lib/json";
import { deviceKeys, entry, explain, makeRow, preview, type Inputs, type Row } from "./model";

interface Props { pipelineId: string; inputs: Inputs; sourceRun?: string | null; blocked: boolean; submitting: boolean; onApproved: (body: FrozenRunSubmission) => void }
interface BudgetObservation { options: PlacementAlternative[]; inputs: Inputs; pipelines: string }

function CandidateResult({ item, selected }: { item: PlacementAlternative; selected: boolean }) {
  const state = { ready: t("可執行"), waiting: t("等待中"), rejected: t("不符合配置") }[item.state];
  return <article className="grid gap-1 rounded-md border border-line p-2.5 text-caption">
    <p className="flex flex-wrap gap-2"><strong className="break-all">{item.pipeline_id}</strong><span>{state}</span>{selected ? <span className="text-action-fg">{t("已選配置")}</span> : null}</p>
    {(item.envelope_basis != null && item.envelope_basis !== "") ? <p className="break-words text-fg-secondary">{item.envelope_basis}</p> : null}
    {item.reasons.map((reason) => <p key={reason} className="text-warning [overflow-wrap:anywhere]">{explain(reason)}</p>)}
    {Object.entries(item.physical_pools).map(([name, raw]) => {
      const pool = isRecord(raw) ? raw : {};
      const need = typeof pool["required_bytes"] === "number" ? formatBytes(pool["required_bytes"]) : "—";
      const free = typeof pool["available_bytes"] === "number" ? formatBytes(pool["available_bytes"]) : "—";
      return <p key={name} className="break-all">{name} · {t("需求 {need}，可用 {free}", { need, free })}</p>;
    })}
    <details><summary className="cursor-pointer text-fg-secondary">{t("檢視節點、精度與卸載設定")}</summary><JsonView value={item} label={item.pipeline_id} /></details>
  </article>;
}

export function PlacementPanel({ pipelineId, inputs, sourceRun, blocked, submitting, onApproved }: Props) {
  const pipelines = usePipelines();
  const history = useRunList(50);
  const [rows, setRows] = useState<Row[]>(() => [makeRow(pipelineId, sourceRun ?? "")]);
  const [observed, setObserved] = useState<BudgetObservation | null>(null);
  const saved = pipelines.data?.items ?? [];
  const ids = JSON.stringify(rows.map((row) => row.pipeline));
  const options = observed?.inputs === inputs && observed.pipelines === ids ? observed.options : [];
  const scan = useMutation({
    mutationFn: async () => ({ inputs, pipelines: ids, options: (await preview(rows.map((row) => ({ pipeline_id: row.pipeline })), inputs)).data.alternatives }),
    onSuccess: setObserved,
  });
  const resolve = useMutation({
    mutationFn: async () => ({ inputs, rows, ...await preview(rows.map((row) => entry(row, options.find((op) => op.pipeline_id === row.pipeline))), inputs) }),
  });
  const result = resolve.data?.inputs === inputs && resolve.data.rows === rows ? resolve.data : null;
  const chosen = result?.data.alternatives.find((op) => op.pipeline_id === result.data.selected);
  const busy = scan.isPending || resolve.isPending || submitting;
  const used = new Set(rows.map((row) => row.pipeline));
  const unused = saved.find((pipe) => !used.has(pipe.pipeline_id));
  const runs = history.data?.pages.flatMap((page) => page.items) ?? [];
  function update(id: string, changes: Partial<Row>) { setRows((old) => old.map((r) => r.id === id ? { ...r, ...changes } : r)); resolve.reset(); }
  return <section className="grid min-w-0 gap-3 rounded-md border border-line p-3" aria-label={t("候選資源配置")}>
    <p className="text-caption text-fg-secondary">{t("依序比較已保存的管線與本次素材。提交時會再次核對實際可用資源。")}</p>
    <fieldset disabled={busy} className="grid min-w-0 gap-3 border-0 p-0">
      {rows.map((row, index) => {
        const obs = options.find((op) => op.pipeline_id === row.pipeline);
        const prior = runs.filter((run) => run.state === "succeeded" && run.request.pipeline.pipeline_id === row.pipeline);
        return <div key={row.id} className="grid min-w-0 gap-2 border-b border-line-subtle pb-3 text-caption">
          <div className="flex items-end gap-2"><label className="grid min-w-0 flex-1 gap-1">{t("候選管線 {index}", { index: index + 1 })}
            <Select compact value={row.pipeline} onChange={(e) => { update(row.id, { pipeline: e.target.value, run: "", basis: "", bytes: {} }); }}>
              {!saved.some((p) => p.pipeline_id === row.pipeline) ? <option value={row.pipeline}>{row.pipeline}</option> : null}
              {saved.map((p) => <option key={p.pipeline_id} value={p.pipeline_id} disabled={p.pipeline_id !== row.pipeline && used.has(p.pipeline_id)}>{p.label} · {p.pipeline_id}</option>)}
            </Select></label>
            {rows.length > 1 ? <Button variant="quiet" size="sm" onClick={() => { setRows(rows.filter((r) => r.id !== row.id)); resolve.reset(); }}>{t("移除候選")}</Button> : null}
          </div>
          <label className="grid gap-1">{t("資源估算方式")}<Select compact value={row.mode} onChange={(e) => { update(row.id, { mode: e.target.value === "budget" ? "budget" : "history" }); }}>
            <option value="history">{t("從已完成的執行量測")}</option><option value="budget">{t("指定增量記憶體預算")}</option>
          </Select></label>
          {row.mode === "history" ? <div className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(7rem,1fr)]">
            <label className="grid gap-1">{t("量測來源執行")}<Select compact value={row.run} onChange={(e) => { update(row.id, { run: e.target.value }); }}>
              <option value="">{t("選擇成功紀錄")}</option>
              {row.run && !prior.some((r) => r.run_id === row.run) ? <option value={row.run}>{row.run}</option> : null}
              {prior.map((r) => <option key={r.run_id} value={r.run_id}>{r.request.label ?? r.request.pipeline.label} · {r.run_id}</option>)}
            </Select></label>
            <label className="grid gap-1">{t("量測預留百分比")}<Input compact type="number" min={0} max={100} value={row.padding} onChange={(e) => { update(row.id, { padding: e.target.value }); }} /></label>
            {history.hasNextPage ? <Button size="sm" variant="quiet" onClick={() => void history.fetchNextPage()} pending={history.isFetchingNextPage}>{t("載入更多執行紀錄")}</Button> : null}
          </div> : <>
            <label className="grid gap-1">{t("預算依據及適用條件")}<Input compact value={row.basis} maxLength={500} onChange={(e) => { update(row.id, { basis: e.target.value }); }} /></label>
            {!(obs?.signature != null && obs.signature !== "") ? <p className="text-fg-secondary">{t("讀取節點配置後，可填寫各主機與裝置的預算。")}</p> : deviceKeys(obs).map(({ node, devices }) => <div key={node} className="grid min-w-0 gap-1">
              <code className="break-all text-fg-tertiary">{node}</code>
              {["host", ...devices].map((device) => <label key={device} className="grid gap-1">{t("{device} 增量預算（MiB）", { device })}
                <Input compact type="number" min={0} step="any" value={row.bytes[`${node}/${device}`] ?? ""} onChange={(e) => { update(row.id, { bytes: { ...row.bytes, [`${node}/${device}`]: e.target.value } }); }} />
              </label>)}
            </div>)}
            {obs?.reasons.filter((r) => r !== "missing_shape_envelope").map((r) => <p key={r} className="text-warning">{explain(r)}</p>)}
          </>}
        </div>;
      })}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="quiet" disabled={!unused || rows.length >= 4} onClick={() => { if (unused) setRows([...rows, makeRow(unused.pipeline_id)]); }}>{t("新增配置候選")}</Button>
        {rows.some((r) => r.mode === "budget") ? <Button size="sm" variant="secondary" disabled={blocked} pending={scan.isPending} onClick={() => { resolve.reset(); scan.mutate(); }}>{t("讀取節點配置")}</Button> : null}
        <Button size="sm" variant="secondary" disabled={blocked} pending={resolve.isPending} onClick={() => { resolve.mutate(); }}>{t("比較資源配置")}</Button>
      </div>
    </fieldset>
    {scan.error || resolve.error || pipelines.error || history.error ? <ErrorCallout error={resolve.error ?? scan.error ?? pipelines.error ?? history.error} title={t("無法完成資源配置預覽")} /> : null}
    {result ? <div className="grid gap-2" aria-live="polite">
      {result.data.alternatives.map((item) => <CandidateResult key={item.pipeline_id} item={item} selected={item.pipeline_id === chosen?.pipeline_id} />)}
      {result.unsupported ? <p className="text-caption text-warning">{t("瀏覽器須支援無損 JSON 數值才能提交核准配置。")}</p> : null}
      <Button size="sm" className="justify-self-start" pending={submitting} disabled={busy || !result.request || chosen?.state !== "ready"} onClick={() => { if (result.request && chosen?.state === "ready") onApproved(result.request); }}>{t("執行核准的配置")}</Button>
    </div> : null}
  </section>;
}
