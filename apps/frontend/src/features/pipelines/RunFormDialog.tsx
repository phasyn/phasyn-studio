import { ExternalLink, Play } from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "react-router";
import { useCatalog } from "@/api/catalog";
import type { Origin } from "@/api/generated/contracts";
import { useCreateRun } from "@/api/runs";
import type { RunRequestBody, WirePipeline, WireTypedValue } from "@/api/types";
import { ActionButton } from "@/components/common/ActionButton";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { StatusBadge } from "@/components/common/StatusBadge";
import { SyntheticNotice } from "@/components/common/SyntheticNotice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/controls";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/variants";
import { typeTone } from "@/components/workbench/kinds";
import { TEXT_TONE } from "@/components/workbench/tones";
import { cn } from "@/lib/cn";
import { hasErrorCode } from "@/lib/errors";
import { makeLookup } from "./catalogIndex";
import { runInputIssues, validatePipeline } from "./pipelineModel";
import { TypedValueInput } from "./TypedValueInput";
import { tServer, t } from "@/i18n";
import { T } from "@/i18n/T";

export interface RunFormSeed {
  pipeline: WirePipeline;
  inputs?: Record<string, WireTypedValue>;
  label?: string;
  origin?: Origin;
  title?: string;
}

function compactInputs(inputs: Record<string, WireTypedValue | null>): Record<string, WireTypedValue> {
  const out: Record<string, WireTypedValue> = {};
  for (const [name, value] of Object.entries(inputs)) if (value) out[name] = value;
  return out;
}

function RunForm({ seed, onClose }: { seed: RunFormSeed; onClose: () => void }) {
  const catalog = useCatalog();
  const lookup = makeLookup(catalog.data);
  const create = useCreateRun();
  const inFlight = useRef(false);
  const [inputs, setInputs] = useState<Record<string, WireTypedValue | null>>(() => ({ ...(seed.inputs ?? {}) }));
  const [label, setLabel] = useState(seed.label ?? "");
  const issues = validatePipeline(seed.pipeline, lookup);
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const inputProblems = runInputIssues(seed.pipeline, inputs);
  const testRun = seed.pipeline.steps.some((step) => lookup(step.node_id, step.component_id)?.provider_id.startsWith("test.") ?? false);
  const blockReason = errors.length > 0 ? t("接線有 {errorsCount} 個錯誤（見下方）", { errorsCount: errors.length }) : (inputProblems[0] ?? null);
  const created = create.data ?? null;

  const submit = () => {
    if (blockReason || inFlight.current || created) return;
    inFlight.current = true;
    const body: RunRequestBody = { pipeline: seed.pipeline, inputs: compactInputs(inputs) };
    if (label.trim()) body.label = label.trim();
    if (seed.origin) body.origin = seed.origin;
    create.mutate(body, {
      onSettled: () => {
        inFlight.current = false;
      },
    });
  };

  if (created) {
    return (
      <>
        <DialogBody className="grid gap-3">
          <Callout tone="success" title={t("已建立 run（202 Accepted）")} className="animate-rise-in">
            <p>
              <T source={"run <0>{run_id}</0> 已送出；狀態 <1/>。 執行狀態請在 run 明細查看（會自動更新）。"} values={{ run_id: created.run_id }} slots={[<code className="machine" />, <StatusBadge kind="run" value={created.state} />]} />
            </p>
          </Callout>
        </DialogBody>
        <DialogFooter>
          <Button variant="quiet" onClick={onClose}>
            {t("關閉")}
          </Button>
          <Link to={`/records/runs/${encodeURIComponent(created.run_id)}`} className={buttonVariants({ variant: "primary" })} onClick={onClose}>
            <ExternalLink aria-hidden />
            {t("前往 run 明細")}
          </Link>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogBody className="grid gap-5">
        {testRun ? <SyntheticNotice kind="test" detail={t("此元件組合包含測試元件（test.*）：輸出只驗證流程，不是生成結果。")} /> : null}
        <section className="grid gap-2" aria-label={t("步驟就緒狀態")}>
          <h3 className="text-data font-semibold text-fg">{t("步驟（{stepsCount}）", { stepsCount: seed.pipeline.steps.length })}</h3>
          <ul className="grid gap-1">
            {seed.pipeline.steps.map((step) => {
              const descriptor = lookup(step.node_id, step.component_id);
              return (
                <li key={step.step_id} className="flex flex-wrap items-center gap-2 text-data">
                  <code className="machine text-fg">{step.step_id}</code>
                  <span className="text-fg-secondary">{descriptor?.label ?? step.component_id}</span>
                  {descriptor ? <StatusBadge kind="component" value={descriptor.state} /> : <Badge tone="warning">{t("不在目錄")}</Badge>}
                  {descriptor && descriptor.state !== "ready" ? (
                    <span className="text-caption text-warning">{t("未就緒：run 會在此步回報錯誤（不會自動啟動或重試），請先到元件頁啟動。")}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
        <section className="grid gap-4" aria-label={t("run 輸入")}>
          <h3 className="text-data font-semibold text-fg">{t("輸入")}</h3>
          {seed.pipeline.inputs.length === 0 ? <p className="text-data text-fg-tertiary">{t("這個元件組合沒有宣告輸入。")}</p> : null}
          {seed.pipeline.inputs.map((port) => (
            <div key={port.name} className="grid gap-2">
              <p className="flex flex-wrap items-center gap-2 text-data">
                <code className="machine text-fg">{port.name}</code>
                <code className={cn("machine text-caption", TEXT_TONE[typeTone(port.type_id)])}>{port.type_id}</code>
                <Badge>{port.required ? t("必填") : t("選填")}</Badge>
                <span className="text-caption text-fg-tertiary">{tServer(port.description)}</span>
              </p>
              <TypedValueInput
                id={`run-input-${port.name}`}
                label={port.name}
                typeId={port.type_id}
                transport={port.transport}
                required={port.required}
                value={inputs[port.name] ?? null}
                onChange={(next) => setInputs((previous) => ({ ...previous, [port.name]: next }))}
                disabled={create.isPending}
              />
            </div>
          ))}
        </section>
        <div className="grid gap-1">
          <label htmlFor="run-label" className="text-data font-medium text-fg-secondary">
            {t("run 名稱（選填）")}
          </label>
          <Input id="run-label" value={label} onChange={(event) => setLabel(event.target.value)} disabled={create.isPending} />
        </div>
        {seed.origin ? (
          <p className="text-caption text-fg-tertiary">
            <T source={"來源：run <0>{value}</0>{value2}{value3}"} values={{ value: seed.origin.source_run_id ?? "—", value2: seed.origin.preview_asset_id ? (
              <>
                <T source={"{text}· 草稿 asset <0>{preview_asset_id}</0>"} values={{ text: " ", preview_asset_id: seed.origin.preview_asset_id }} slots={[<code className="machine" />]} />
              </>
            ) : null, value3: seed.origin.note ? t(" · 備註：{note}", { note: seed.origin.note }) : null }} slots={[<code className="machine" />]} />
          </p>
        ) : null}
        {errors.length > 0 ? (
          <Callout tone="danger" title={t("接線錯誤（伺服器會以 422 拒絕）")}>
            <ul className="grid gap-1">
              {errors.map((issue, index) => (
                <li key={index}>
                  <span className="machine text-caption text-fg-tertiary">{issue.code}</span> {issue.message}
                </li>
              ))}
            </ul>
          </Callout>
        ) : null}
        {warnings.length > 0 ? (
          <Callout tone="warning" title={t("提醒")}>
            <ul className="grid gap-1">
              {warnings.map((issue, index) => (
                <li key={index}>{issue.message}</li>
              ))}
            </ul>
          </Callout>
        ) : null}
        {inputProblems.length > 0 ? (
          <ul className="grid gap-1 text-caption text-warning" aria-live="polite">
            {inputProblems.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        ) : null}
        {create.isError ? (
          <ErrorCallout error={create.error} write title={hasErrorCode(create.error, "RUN_ACTIVE") ? t("已有 run 正在執行：這次沒有送出") : t("建立 run 失敗；輸入內容保留")}>
            {hasErrorCode(create.error, "RUN_ACTIVE") ? (
              <Link to="/records/runs" className="text-data">
                {t("查看執行中的 run")}
              </Link>
            ) : null}
          </ErrorCallout>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="quiet" onClick={onClose}>
          {t("取消")}
        </Button>
        <ActionButton variant="primary" icon={<Play aria-hidden />} pending={create.isPending} disabledReason={create.isPending ? null : blockReason} onClick={submit}>
          {t("建立 run")}
        </ActionButton>
      </DialogFooter>
    </>
  );
}

/** 建立 run：提供輸入（文字、上傳檔案或挑選既有 FileRef）、名稱，送出 POST /api/runs；防重複點擊，RUN_ACTIVE 明確顯示。 */
export function RunFormDialog({ seed, onOpenChange }: { seed: RunFormSeed | null; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={seed !== null} onOpenChange={onOpenChange}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{seed?.title ?? t("建立 run")}</DialogTitle>
          <DialogDescription>
            <T source={"元件組合 <0>{pipeline_id}</0>（{label}）。送出時凍結本次接線與輸入；重新執行就是新的 run。"} values={{ pipeline_id: seed?.pipeline.pipeline_id, label: seed?.pipeline.label }} slots={[<code className="machine" />]} />
          </DialogDescription>
        </DialogHeader>
        {seed ? <RunForm seed={seed} onClose={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}
