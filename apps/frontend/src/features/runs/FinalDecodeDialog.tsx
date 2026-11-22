import { ExternalLink, Film } from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "react-router";
import { useCatalog, useProviderIndex } from "@/api/catalog";
import type { FileRef, Origin } from "@/api/generated/contracts";
import { useCreateRun } from "@/api/runs";
import type { RunRequestBody } from "@/api/types";
import { ActionButton } from "@/components/common/ActionButton";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { ParametersEditor } from "@/components/common/ParametersEditor";
import { StatusBadge } from "@/components/common/StatusBadge";
import { IdText } from "@/components/common/values";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Textarea } from "@/components/ui/controls";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/variants";
import { hasErrorCode } from "@/lib/errors";
import { cn } from "@/lib/cn";
import { isRecord } from "@/lib/json";
import { validateValue } from "@/lib/schema";
import { buildFromTemplate, type ComponentOption, componentOptions, readinessText, slotCandidates } from "@/features/pipelines";
import { latentFacts } from "./runModel";
import { PATHS, runPath } from "@/app/paths";
import { t } from "@/i18n";
import { T } from "@/i18n/T";
import { formatList } from "@/i18n/format";

export interface FinalDecodeSeed {
  /** final latent 的 manifest FileRef（video.final-latent.v1）。 */
  latent: FileRef;
  sourceRunId: string;
  /** 由草稿 asset 發起時帶入（origin.preview_asset_id）。 */
  previewAssetId: string | null;
  mode: "from-preview" | "direct";
}

const LATENT_TYPE = "video.final-latent.v1";

function compatible(option: ComponentOption): boolean {
  return option.descriptor.inputs.some((port) => port.type_id === LATENT_TYPE);
}

function FinalDecodeForm({ seed, onClose }: { seed: FinalDecodeSeed; onClose: () => void }) {
  const catalog = useCatalog();
  const providers = useProviderIndex((catalog.data?.nodes ?? []).map((node) => node.node_id));
  // 測試／合成解碼器不列出；就緒 → 在線 → 其他，第一個相容的是預設
  const options = slotCandidates(componentOptions(catalog.data, providers), ["decode.final"]);
  const [choice, setChoice] = useState<string | null>(null);
  const [parameters, setParameters] = useState<Record<string, unknown>>({});
  const [note, setNote] = useState("");
  const create = useCreateRun();
  const inFlightRef = useRef(false);
  const usable = options.filter(compatible);
  const selected = options.find((option) => option.value === choice) ?? usable[0] ?? null;
  const facts = latentFacts(seed.latent);
  const paramsSchema = selected?.descriptor.settings.parameters_schema ?? {};
  const paramIssues = selected ? validateValue(paramsSchema, parameters, isRecord(paramsSchema) ? paramsSchema : undefined) : [];
  const created = create.data ?? null;
  const otherRequired = selected ? selected.descriptor.inputs.filter((port) => port.required && port.type_id !== LATENT_TYPE).map((port) => port.name) : [];
  const blockReason = !selected
    ? t("目錄中沒有可用的 decode.final 元件")
    : !compatible(selected)
      ? t("此元件沒有 {latentType} 輸入", { latentType: LATENT_TYPE })
      : otherRequired.length > 0
        ? t("此元件還需要其他必填輸入（{otherRequired}）：請改在流程頁建立完整接線", { otherRequired: formatList(otherRequired) })
        : paramIssues.length > 0
          ? t("參數有 {paramIssuesCount} 個問題", { paramIssuesCount: paramIssues.length })
          : null;

  const submit = () => {
    if (!selected || (blockReason != null && blockReason !== "") || inFlightRef.current || created) return;
    // 單一 decode.final 步驟：latent 由 pipeline 輸入帶入（不是範本清單裡的範本）
    const build = buildFromTemplate({ inputNames: { [LATENT_TYPE]: "latent" } }, [{ slot: { id: "final" }, descriptor: selected.descriptor }], "same-source-final", t("從既有 final latent 正式解碼"));
    const latentInput = build.pipeline.inputs.find((port) => port.type_id === LATENT_TYPE);
    if (!latentInput) return;
    const pipeline = { ...build.pipeline, steps: build.pipeline.steps.map((step) => ({ ...step, parameters })) };
    const origin: Origin = { source_run_id: seed.sourceRunId };
    if (seed.previewAssetId != null && seed.previewAssetId !== "") origin.preview_asset_id = seed.previewAssetId;
    if (note.trim()) origin.note = note.trim();
    const body: RunRequestBody = {
      pipeline,
      inputs: { [latentInput.name]: { type_id: LATENT_TYPE, file: seed.latent } },
      label: seed.mode === "from-preview" ? t("從草稿來源正式解碼") : t("直接完整解碼"),
      origin,
    };
    inFlightRef.current = true;
    create.mutate(body, {
      onSettled: () => {
        inFlightRef.current = false;
      },
    });
  };

  if (created) {
    return (
      <>
        <DialogBody>
          <Callout tone="success" title={t("已建立正式解碼 run")}>
            <p>
              <T source={"run <0>{run_id}</0>（<1/>）讀取同一份 final latent；來源檔案不會被修改。"} values={{ run_id: created.run_id }} slots={[<code key="slot-0" className="machine" />, <StatusBadge key="slot-1" kind="run" value={created.state} />]} />
            </p>
          </Callout>
        </DialogBody>
        <DialogFooter>
          <Button variant="quiet" onClick={onClose}>
            {t("關閉")}
          </Button>
          <Link to={runPath(created.run_id)} className={buttonVariants({ variant: "primary" })} onClick={onClose}>
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
        <section className="grid gap-1 text-data" aria-label={t("來源 latent")}>
          <p className="text-fg-secondary">
            <T source={"來源 run <0/>{value}"} values={{ value: (seed.previewAssetId != null && seed.previewAssetId !== "") ? (
              <>
                {t("{text}· 草稿 asset", { text: " " })} <IdText value={seed.previewAssetId} />
              </>
            ) : null }} slots={[<IdText key="slot-0" value={seed.sourceRunId} />]} />
          </p>
          <p className="text-fg-secondary">
            latent_id <IdText value={facts.latentId} /> · latent_space <code className="machine">{facts.latentSpaceId ?? t("未知")}</code> · manifest SHA{" "}
            <IdText value={seed.latent.sha256} length={12} />
            {facts.blob ? (
              <>
                {" "}
                · blob SHA <IdText value={facts.blob.sha256} length={12} />
              </>
            ) : null}
          </p>
        </section>
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-data font-semibold text-fg">{t("正式解碼元件（任何 Node 上的 decode.final）")}</legend>
          {options.length === 0 ? (
            <Callout tone="warning" title={t("目錄中沒有 decode.final 元件")}>
              <p>{t("請先在元件頁新建正式解碼 instance。{value}", { value: providers.failedNodes.size > 0 ? t("另有 {failedNodesCount} 個 Node 無法取得 provider 清單。", { failedNodesCount: providers.failedNodes.size }) : "" })}</p>
            </Callout>
          ) : null}
          {options.map((option) => {
            const ok = compatible(option);
            return (
              <label
                key={option.value}
                className={cn(
                  "flex min-h-11 items-start gap-3 rounded-lg border border-line-subtle px-3 py-2 transition-[background-color,border-color] duration-(--duration-fast)",
                  ok ? "pressable cursor-pointer hover:border-line-strong hover:bg-raised/60" : "cursor-not-allowed text-fg-disabled",
                  selected?.value === option.value && "border-brand-blue/60 bg-brand-gradient-soft hover:border-brand-blue/60",
                )}
              >
                <input
                  type="radio"
                  name="final-decoder"
                  className="mt-1 accent-action"
                  checked={selected?.value === option.value}
                  disabled={!ok}
                  onChange={() => {
                    setChoice(option.value);
                    setParameters({});
                  }}
                />
                <span className="min-w-0">
                  <span className="block text-body">
                    {option.node.label} / {option.descriptor.label || option.descriptor.component_id}
                  </span>
                  <span className="block machine text-caption text-fg-tertiary">
                    {option.descriptor.component_id} · {option.descriptor.provider_id} · {readinessText(option)}
                  </span>
                  {!ok ? <span className="block text-caption text-warning">{t("不相容：沒有 {latentType} 輸入埠", { latentType: LATENT_TYPE })}</span> : null}
                  {ok && option.descriptor.state !== "ready" ? (
                    <span className="block text-caption text-warning">{t("目前未就緒：run 會在此步回報錯誤，請先到元件頁啟動。")}</span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </fieldset>
        {selected ? (
          <ParametersEditor
            schema={paramsSchema}
            value={parameters}
            onChange={setParameters}
            idPrefix="final-decode-params"
            issues={paramIssues}
            label={t("解碼參數（選填；未填沿用元件的 invoke 預設）")}
          />
        ) : null}
        <div className="grid gap-1">
          <label htmlFor="final-decode-note" className="text-data font-medium text-fg-secondary">
            {t("備註（選填，保存在 run 的 origin.note）")}
          </label>
          <Textarea id="final-decode-note" rows={2} value={note} onChange={(event) => { setNote(event.target.value); }} />
        </div>
        <p className="text-caption text-fg-tertiary">
          {t("這是普通的新 run：沒有核准、資格或勾選清單。latent 語意是否相容由解碼元件檢查（不符時回 LATENT_MISMATCH，不會胡亂 reshape）。")}
        </p>
        {create.isError ? (
          <ErrorCallout error={create.error} write title={hasErrorCode(create.error, "RUN_ACTIVE") ? t("已有 run 正在執行：這次沒有送出") : t("建立 run 失敗")}>
            {hasErrorCode(create.error, "RUN_ACTIVE") ? <Link to={PATHS.runs}>{t("查看執行中的 run")}</Link> : null}
          </ErrorCallout>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="quiet" onClick={onClose}>
          {t("取消")}
        </Button>
        <ActionButton variant="primary" icon={<Film aria-hidden />} pending={create.isPending} disabledReason={create.isPending ? null : blockReason} onClick={submit}>
          {t("建立正式解碼 run")}
        </ActionButton>
      </DialogFooter>
    </>
  );
}

/** 「從此來源正式解碼」／「直接完整解碼」：選任意相容的 decode.final、可選參數與備註，建立單步驟新 run。 */
export function FinalDecodeDialog({ seed, onOpenChange }: { seed: FinalDecodeSeed | null; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={seed !== null} onOpenChange={onOpenChange}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{seed?.mode === "from-preview" ? t("從此來源正式解碼") : t("直接完整解碼")}</DialogTitle>
          <DialogDescription>{t("讀取同一份 final latent 建立新的 run；不含 DiT，不修改來源。")}</DialogDescription>
        </DialogHeader>
        {seed ? <FinalDecodeForm seed={seed} onClose={() => { onOpenChange(false); }} /> : null}
      </DialogContent>
    </Dialog>
  );
}
