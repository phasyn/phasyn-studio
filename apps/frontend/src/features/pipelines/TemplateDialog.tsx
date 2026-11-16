import { LayoutTemplate } from "lucide-react";
import { useState } from "react";
import { useCatalog, useProviderIndex } from "@/api/catalog";
import type { WirePipeline } from "@/api/types";
import { ActionButton } from "@/components/common/ActionButton";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Select } from "@/components/ui/controls";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/cn";
import { componentVariant } from "@/lib/h3Variant";
import { localIdError, uniqueName } from "@/lib/ids";
import { componentOptions, readinessText, slotCandidates, type ComponentOption } from "./catalogIndex";
import { LIFT_CARD, SELECTED_ITEM } from "./presentation";
import { buildFromTemplate, TEMPLATES, templateById, type TemplateId, type TemplateSlot } from "./templates";
import { t } from "@/i18n";
import { T } from "@/i18n/T";
import { reveal } from "@/components/ui/motion";

/** 這一步找不到元件時補充原因：kind 之外還要求特定輸出埠，或沒有配置 preview decoder。 */
function missingHint(slot: TemplateSlot): string {
  if (slot.outputType) return t("（輸出需為 {outputType}）", { outputType: slot.outputType });
  return slot.kinds.includes("decode.preview") ? t("（未配置 preview decoder）") : "";
}

function TemplateForm({
  existingIds,
  onCreate,
  onCancel,
}: {
  existingIds: ReadonlySet<string>;
  onCreate: (draft: WirePipeline, unresolved: string[]) => void;
  onCancel: () => void;
}) {
  const catalog = useCatalog();
  const nodeIds = (catalog.data?.nodes ?? []).map((node) => node.node_id);
  const providers = useProviderIndex(nodeIds);
  const options = componentOptions(catalog.data, providers);
  const [templateId, setTemplateId] = useState<TemplateId>("generation");
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [includeAudio, setIncludeAudio] = useState(false);
  const [ids, setIds] = useState<Partial<Record<TemplateId, string>>>({});
  const [labels, setLabels] = useState<Partial<Record<TemplateId, string>>>({});
  const spec = templateById(templateId);
  const pipelineId = ids[templateId] ?? uniqueName(spec.defaultPipelineId, existingIds);
  const label = labels[templateId] ?? spec.label;
  const activeSlots = spec.slots.filter((slot) => !slot.optional || includeAudio);

  const candidatesFor = (slot: TemplateSlot): ComponentOption[] => slotCandidates(options, slot.kinds, slot.outputType, slot.variant);
  const selectedFor = (slot: TemplateSlot): ComponentOption | null => {
    const candidates = candidatesFor(slot);
    const chosen = choices[`${templateId}:${slot.id}`];
    return candidates.find((option) => option.value === chosen) ?? candidates[0] ?? null;
  };
  const missing = activeSlots.filter((slot) => selectedFor(slot) === null);
  const idError = localIdError(pipelineId, "pipeline_id ");
  const blockReason = missing.length > 0 ? t("目錄中沒有可用於「{value}」的元件", { value: missing[0]?.label ?? "" }) : idError;

  const create = () => {
    if (blockReason) return;
    const chosen = activeSlots.flatMap((slot) => {
      const option = selectedFor(slot);
      return option ? [{ slot, descriptor: option.descriptor }] : [];
    });
    const build = buildFromTemplate(spec, chosen, pipelineId, label);
    onCreate(build.pipeline, build.unresolved);
  };

  return (
    <>
      <DialogBody className="grid gap-5">
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-data font-semibold text-fg">{t("範本")}</legend>
          {TEMPLATES.map((template, index) => (
            // 範本卡：選取＝品牌底＋左側漸層標記（單選鈕仍是狀態來源）；滑過抬升 1 px、按下縮小；依序淡入
            <label
              key={template.id}
              ref={reveal(index)}
              className={cn("relative flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border px-3 py-2", LIFT_CARD, template.id === templateId ? cn("border-brand-blue/55", SELECTED_ITEM) : "border-line hover:border-line-strong hover:bg-raised/60")}
            >
              <input type="radio" name="template" className="mt-1 accent-action" checked={template.id === templateId} onChange={() => setTemplateId(template.id)} />
              <span className="min-w-0">
                <span className="block text-body text-fg">{template.label}</span>
                <span className="block text-caption text-fg-tertiary">{template.description}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {spec.slots.some((slot) => slot.optional) ? (
          <Checkbox
            id="template-audio"
            label={t("包含音訊分支（audio.decode → media.mux）")}
            description={t("沒有音訊分支時不會自動產生音訊。")}
            checked={includeAudio}
            onChange={(event) => setIncludeAudio(event.target.checked)}
          />
        ) : null}
        <fieldset className="grid gap-3">
          <legend className="mb-1 text-data font-semibold text-fg">{t("每一步使用的元件（依 provider 的 kind 篩選；任何 Node 都可以）")}</legend>
          {activeSlots.map((slot) => {
            const candidates = candidatesFor(slot);
            const selected = selectedFor(slot);
            const id = `template-slot-${slot.id}`;
            return (
              <div key={slot.id} className="grid gap-1">
                <label htmlFor={id} className="text-caption text-fg-secondary">
                  <code className="machine text-fg">{slot.id}</code> · {slot.label}
                </label>
                {candidates.length === 0 ? (
                  <p id={id} className="text-caption text-warning">
                    {t("目錄中沒有 kind 為 {kinds} 的元件{value}。可先到元件頁新建 instance。", { kinds: slot.kinds.join(t(" 或 ")), value: missingHint(slot) })}
                  </p>
                ) : (
                  <Select id={id} value={selected?.value ?? ""} onChange={(event) => setChoices({ ...choices, [`${templateId}:${slot.id}`]: event.target.value })}>
                    {candidates.map((option) => (
                      <option key={option.value} value={option.value}>
                        <T source={"{label} / {value}（{component_id}）· {kind} · {option}"} values={{ label: option.node.label, value: option.descriptor.label || option.descriptor.component_id, component_id: option.descriptor.component_id, kind: option.kind, option: readinessText(option) }} />
                      </option>
                    ))}
                  </Select>
                )}
                {slot.variant && selected && componentVariant(selected.descriptor) !== slot.variant ? (
                  <p className="text-caption text-warning">
                    {t("這個元件載入的是 {actual} checkpoint，但這一步需要 {wanted}；用它建出的元件組合做不到這個範本的任務。", { actual: componentVariant(selected.descriptor), wanted: slot.variant })}
                  </p>
                ) : null}
              </div>
            );
          })}
          {providers.failedNodes.size > 0 ? (
            <p className="text-caption text-warning">{t("{failedNodesCount} 個 Node 無法取得 provider 清單（可能離線），其元件的 kind 無法判斷而未列出。", { failedNodesCount: providers.failedNodes.size })}</p>
          ) : null}
          {providers.loading ? <p className="text-caption text-fg-tertiary">{t("讀取各 Node 的 provider 清單…")}</p> : null}
        </fieldset>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="grid gap-1">
            <label htmlFor="template-pipeline-id" className="text-caption text-fg-secondary">
              pipeline_id
            </label>
            <Input
              id="template-pipeline-id"
              className="machine"
              value={pipelineId}
              aria-invalid={Boolean(idError) || undefined}
              onChange={(event) => setIds({ ...ids, [templateId]: event.target.value })}
            />
            {idError ? <p className="text-caption text-danger">{idError}</p> : null}
            {existingIds.has(pipelineId) ? <p className="text-caption text-warning">{t("已有同 ID 的元件組合：儲存會覆寫它。")}</p> : null}
          </div>
          <div className="grid gap-1">
            <label htmlFor="template-label" className="text-caption text-fg-secondary">
              {t("名稱")}
            </label>
            <Input id="template-label" value={label} onChange={(event) => setLabels({ ...labels, [templateId]: event.target.value })} />
          </div>
        </div>
        <p className="text-caption text-fg-tertiary">{t("建立的是可編輯草稿：接線依元件宣告的型別自動帶入，請在編輯器確認後再儲存或執行。")}</p>
      </DialogBody>
      <DialogFooter>
        <Button variant="quiet" onClick={onCancel}>
          {t("取消")}
        </Button>
        <ActionButton variant="primary" icon={<LayoutTemplate aria-hidden />} disabledReason={blockReason} onClick={create}>
          {t("建立草稿")}
        </ActionButton>
      </DialogFooter>
    </>
  );
}

/** 內建範本 → 預先填好的元件組合草稿（引用使用者選的目錄元件，不寫死主機）。 */
export function TemplateDialog({
  open,
  onOpenChange,
  existingIds,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingIds: ReadonlySet<string>;
  onCreate: (draft: WirePipeline, unresolved: string[]) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{t("從範本建立元件組合")}</DialogTitle>
          <DialogDescription>{t("每一步都可以放在任何 Node 的相容元件上；之後在編輯器中仍可更換。")}</DialogDescription>
        </DialogHeader>
        {open ? <TemplateForm existingIds={existingIds} onCreate={onCreate} onCancel={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}
