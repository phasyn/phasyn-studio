import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { contractJson } from "@/api/http";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { JsonView } from "@/components/common/JsonView";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/controls";
import { t } from "@/i18n";
import { isRecord } from "@/lib/json";

interface Resolved { revision: number; definition_sha256: string; files_checked: number; policy: unknown }
interface Receipt { run_id: string; actual_recipe: string }
interface Preview { id: string; body: { revision: number; inputs: Record<string, unknown> }; requestId: string; result: Resolved }

function parseObject(text: string) {
  const value: unknown = JSON.parse(text || "{}", (_key: string, entry: unknown) => {
    if (typeof entry === "number" && Number.isInteger(entry) && !Number.isSafeInteger(entry)) {
      throw new Error(t("此整數超出瀏覽器可精確儲存的範圍。"));
    }
    return entry;
  });
  if (!isRecord(value)) throw new Error(t("請輸入 JSON 物件。"));
  return value;
}

const endpoint = (id: string) => `/api/inference-presets/${encodeURIComponent(id)}`;

export function InferencePresetPanel({ runId, provider }: { runId: string; provider: string }) {
  const options = provider === "qimg.dit" ? ["t2i", "i2i"] : ["t2va", "fl2va", "ref2va"];
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [task, setTask] = useState(options[0] ?? "");
  const [parameters, setParameters] = useState("{}");
  const [inputs, setInputs] = useState("{}");
  const [revision, setRevision] = useState("");
  const [pin, setPin] = useState<Preview | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const catalog = useQuery({ queryKey: ["inference-presets"], queryFn: ({ signal }) => contractJson("InferencePresetList", "/api/inference-presets", { signal }) });
  const items = catalog.data?.items ?? [];
  const current = items.find((item) => item.id === id);
  const readRevision = revision === "" ? current?.revision : Number(revision);
  const validId = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(id);
  function clearPreview() { setPin(null); setReceipt(null); }
  const capture = useMutation({
    mutationFn: () => contractJson("InferencePresetRevision", endpoint(id), { method: "PUT", json: { source_run_id: runId,
      task, label: label.trim(), expected_revision: current?.revision ?? 0, parameters: parseObject(parameters) } }),
    onSuccess: (result) => { clearPreview(); setRevision(String(result.revision)); void catalog.refetch(); },
  });
  const preflight = useMutation({
    mutationFn: async (): Promise<Preview> => {
      const body = { revision: Number(readRevision), inputs: parseObject(inputs) };
      const result = await contractJson("InferencePresetPreflight", `${endpoint(id)}/preflight`, { method: "POST", json: body });
      return { id, body, result, requestId: crypto.randomUUID() };
    },
    onMutate: clearPreview,
    onSuccess: setPin,
  });
  const submit = useMutation({
    mutationFn: (p: Preview) => contractJson("InferencePresetReceipt", `${endpoint(p.id)}/submit`, { method: "POST", json: { ...p.body, request_id: p.requestId } }),
    onSuccess: setReceipt,
  });
  const busy = capture.isPending || preflight.isPending || submit.isPending;
  const error = submit.error ?? preflight.error ?? capture.error ?? catalog.error;
  function choose(value: string) {
    setId(value); setLabel(items.find((p) => p.id === value)?.label ?? ""); setRevision("");
    clearPreview(); capture.reset(); preflight.reset(); submit.reset();
  }
  return (
    <details className="panel min-w-0 p-3">
      <summary className="cursor-pointer text-data font-semibold text-fg">{t("保存與執行推論配方")}</summary>
      <fieldset disabled={busy} className="mt-3 grid min-w-0 gap-3 border-0 p-0">
        <label className="grid gap-1 text-caption">{t("已保存的推論配方")}
          <Select compact value={current?.id ?? ""} onChange={(event) => { choose(event.target.value); }}>
            <option value="">{t("建立新的推論配方")}</option>
            {items.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.id} · v{item.revision}</option>)}
          </Select>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-caption">{t("推論配方 ID")}<Input compact value={id} maxLength={160} onChange={(event) => { choose(event.target.value); }} /></label>
          <label className="grid gap-1 text-caption">{t("配方名稱")}<Input compact value={label} maxLength={200} onChange={(event) => { setLabel(event.target.value); }} /></label>
          <label className="grid gap-1 text-caption">{t("來源生成任務")}<Select compact value={task} onChange={(event) => { setTask(event.target.value); }}>
            {options.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
          </Select></label>
          <label className="grid gap-1 text-caption">{t("執行配方版本")}<Input compact type="number" min={1} max={current?.revision} value={revision} placeholder={String(current?.revision ?? "")} onChange={(event) => { setRevision(event.target.value); clearPreview(); }} /></label>
        </div>
        <details className="text-caption"><summary className="cursor-pointer">{t("調整取樣參數與素材")}</summary>
          <label className="mt-2 grid gap-1">{t("保存版本的取樣覆寫（JSON）")}<Textarea compact className="font-mono" value={parameters} onChange={(event) => { setParameters(event.target.value); }} /></label>
          <label className="mt-2 grid gap-1">{t("本次執行的素材覆寫（JSON）")}<Textarea compact className="font-mono" value={inputs} onChange={(event) => { setInputs(event.target.value); clearPreview(); }} /></label>
        </details>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={!validId || !label.trim() || catalog.isFetching || catalog.isError} pending={capture.isPending} onClick={() => { capture.mutate(); }}>{t("從本次執行保存新版本")}</Button>
          <Button size="sm" variant="secondary" disabled={!current || !Number.isInteger(readRevision) || Number(readRevision) < 1} pending={preflight.isPending} onClick={() => { preflight.mutate(); }}>{t("檢查配方與素材")}</Button>
          <Button size="sm" disabled={!pin || Boolean(receipt)} pending={submit.isPending} onClick={() => { if (pin) submit.mutate(pin); }}>{t("執行已檢查的版本")}</Button>
        </div>
      </fieldset>
      {error ? <ErrorCallout className="mt-3" error={error} title={t("推論配方操作未完成")} /> : null}
      {pin ? <details className="mt-3 break-all text-caption"><summary className="cursor-pointer">{t("已檢查 {count} 個檔案", { count: pin.result.files_checked })} · v{pin.body.revision}</summary>
        <JsonView value={pin.result.policy} label={t("解析後的取樣與模型設定")} />
      </details> : null}
      {receipt ? <a className="mt-3 block break-all text-data text-action-fg underline" href={receipt.actual_recipe} target="_blank" rel="noreferrer">{t("檢視執行配方")} · {receipt.run_id}</a> : null}
    </details>
  );
}
