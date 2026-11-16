import { BookmarkPlus, ClipboardPaste, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import type { InstanceSettings, Preset } from "@/api/generated/contracts";
import { useDeletePreset, usePresets, useSavePreset } from "@/api/presets";
import { ActionButton } from "@/components/common/ActionButton";
import { DiffTable } from "@/components/common/DiffTable";
import { EmptyState } from "@/components/common/EmptyState";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { JsonView } from "@/components/common/JsonView";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Checkbox, Input } from "@/components/ui/controls";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { diffDocuments } from "@/lib/diff";
import { localIdError, slugId } from "@/lib/ids";
import { cloneJson } from "@/lib/json";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";
import { T } from "@/i18n/T";
import { reveal } from "@/components/ui/motion";

export interface SavePresetTarget {
  componentId: string;
  providerId: string;
  settings: InstanceSettings;
}

function SavePresetForm({ target, onDone, onCancel }: { target: SavePresetTarget; onDone: (preset: Preset) => void; onCancel: () => void }) {
  const presets = usePresets();
  const save = useSavePreset();
  const [presetId, setPresetId] = useState(slugId(`${target.componentId}-preset`, "preset"));
  const [label, setLabel] = useState(t("{componentId} 設定", { componentId: target.componentId }));
  const [overwrite, setOverwrite] = useState(false);
  const idError = localIdError(presetId, "preset_id ");
  const existing = presets.data?.items.find((item) => item.preset_id === presetId) ?? null;
  const blockReason = idError ?? (existing && !overwrite ? t("已有同名 preset：勾選覆寫或改用其他 ID") : null);
  const submit = () => {
    if (blockReason || save.isPending) return;
    save.mutate({ preset_id: presetId, label: label || presetId, provider_id: target.providerId, settings: cloneJson(target.settings) }, { onSuccess: onDone });
  };
  return (
    <>
      <DialogBody className="grid gap-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Field id="preset-id" label="preset_id" error={idError}>
            {(describedBy) => (
              <Input id="preset-id" className="machine" value={presetId} aria-describedby={describedBy} aria-invalid={Boolean(idError) || undefined} onChange={(event) => setPresetId(event.target.value)} />
            )}
          </Field>
          <Field id="preset-label" label={t("名稱")}>
            {(describedBy) => <Input id="preset-label" value={label} aria-describedby={describedBy} onChange={(event) => setLabel(event.target.value)} />}
          </Field>
        </div>
        <p className="text-caption text-fg-tertiary">
          <T source={"provider：<0>{providerId}</0>。preset 是普通 JSON 副本：不是資格證書，也不會回寫正在跑的呼叫。"} values={{ providerId: target.providerId }} slots={[<code className="machine" />]} />
        </p>
        {existing ? (
          <Callout tone="warning" title={t("已有 preset「{label}」使用此 ID（provider {provider_id}）", { label: existing.label, provider_id: existing.provider_id })}>
            <Checkbox id="preset-overwrite" label={t("覆寫既有 preset")} checked={overwrite} onChange={(event) => setOverwrite(event.target.checked)} />
          </Callout>
        ) : null}
        <JsonView value={target.settings} label={t("將保存的設定（目前已保存的 stored）")} maxHeightClass="max-h-64" />
        {save.isError ? <ErrorCallout error={save.error} write title={t("保存 preset 失敗")} /> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="quiet" onClick={onCancel}>
          {t("取消")}
        </Button>
        <ActionButton variant="primary" icon={<BookmarkPlus aria-hidden />} pending={save.isPending} disabledReason={save.isPending ? null : blockReason} onClick={submit}>
          {t("保存 preset")}
        </ActionButton>
      </DialogFooter>
    </>
  );
}

export function SavePresetDialog({ target, onOpenChange, onDone }: { target: SavePresetTarget | null; onOpenChange: (open: boolean) => void; onDone: (preset: Preset) => void }) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{t("將已保存設定存為 preset")}</DialogTitle>
          <DialogDescription>{t("保存的是伺服器上已保存（stored）的設定，不含未儲存的草稿。")}</DialogDescription>
        </DialogHeader>
        {target ? <SavePresetForm target={target} onDone={onDone} onCancel={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

export interface ApplyPresetTarget {
  providerId: string;
  draft: InstanceSettings;
}

function applied(preset: Preset, current: InstanceSettings, keepDevice: boolean): InstanceSettings {
  const next = cloneJson(preset.settings);
  if (keepDevice) {
    next.load = { ...next.load, device: current.load.device };
    if (current.load.model_path !== undefined) next.load.model_path = current.load.model_path;
    else delete next.load.model_path;
  }
  return next;
}

/** Deleting one preset after confirmation: only the preset file goes; component settings it was applied to stay. */
function DeletePresetDialog({ preset, onOpenChange, onDeleted }: { preset: Preset; onOpenChange: (open: boolean) => void; onDeleted: (presetId: string) => void }) {
  const remove = useDeletePreset();
  const inFlight = useRef(false);
  const send = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    remove.mutate(preset.preset_id, {
      onSuccess: () => onDeleted(preset.preset_id),
      onSettled: () => {
        inFlight.current = false;
      },
    });
  };
  return (
    <Dialog open onOpenChange={(open) => (remove.isPending ? undefined : onOpenChange(open))}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("刪除 preset「{label}」？", { label: preset.label || preset.preset_id })}</DialogTitle>
          <DialogDescription>{t("只刪除這個 preset 檔；已套用過它的元件設定不受影響。刪除後無法復原。")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-2">
          <code className="machine text-caption text-fg-tertiary">
            {preset.preset_id} · provider {preset.provider_id}
          </code>
          {remove.isError ? <ErrorCallout error={remove.error} write title={t("preset 沒有刪除")} /> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="quiet" disabled={remove.isPending} onClick={() => onOpenChange(false)}>
            {t("取消")}
          </Button>
          <Button variant="danger" icon={<Trash2 aria-hidden />} pending={remove.isPending} onClick={send}>
            {t("刪除 preset")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ApplyPresetForm({ target, onApply, onCancel }: { target: ApplyPresetTarget; onApply: (next: InstanceSettings) => void; onCancel: () => void }) {
  const presets = usePresets();
  const [selected, setSelected] = useState<string | null>(null);
  const [keepDevice, setKeepDevice] = useState(true);
  const [deleting, setDeleting] = useState<Preset | null>(null);
  const items = presets.data?.items ?? [];
  const preset = items.find((item) => item.preset_id === selected) ?? null;
  const next = preset ? applied(preset, target.draft, keepDevice) : null;
  const changes = next ? diffDocuments(target.draft, next) : [];
  return (
    <>
      <DialogBody className="grid gap-4">
        {presets.isPending ? (
          <div role="status" className="grid gap-1.5">
            <p className="text-data text-fg-tertiary">{t("讀取 preset…")}</p>
            {[0, 1, 2].map((index) => (
              <div key={index} aria-hidden className="skeleton h-11 animate-shimmer" />
            ))}
          </div>
        ) : null}
        {presets.isError ? <ErrorCallout error={presets.error} title={t("無法讀取 preset")} onRetry={() => void presets.refetch()} /> : null}
        {presets.isSuccess && items.length === 0 ? (
          <EmptyState icon={<BookmarkPlus />} title={t("還沒有 preset")} description={t("可在檢視器按「存為 preset」建立。")} size="compact" />
        ) : null}
        {items.length > 0 ? (
          <fieldset className="grid gap-1">
            <legend className="mb-1 text-data font-semibold text-fg">{t("選擇 preset")}</legend>
            {items.map((item, index) => {
              const mismatch = item.provider_id !== target.providerId;
              const chosen = selected === item.preset_id;
              return (
                <div key={item.preset_id} ref={reveal(index)} className="flex items-start gap-1">
                  <label
                    className={cn(
                      "flex min-h-11 min-w-0 flex-1 items-start gap-3 rounded-lg border px-3 py-2",
                      "transition-[translate,background-color,border-color,box-shadow] duration-(--duration-spring-snappy) ease-spring-snappy",
                      "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus",
                      mismatch
                        ? "cursor-not-allowed border-line-subtle text-fg-disabled"
                        : chosen
                          ? "cursor-pointer border-brand-blue/60 bg-brand-gradient-soft"
                          : "pressable cursor-pointer border-line-subtle hover:-translate-y-px hover:border-line-strong hover:bg-raised/60 hover:shadow-raised",
                    )}
                  >
                    <input
                      type="radio"
                      name="preset"
                      className="mt-1 accent-action"
                      value={item.preset_id}
                      checked={selected === item.preset_id}
                      disabled={mismatch}
                      onChange={() => setSelected(item.preset_id)}
                    />
                    <span className="min-w-0">
                      <span className="block text-body">{item.label}</span>
                      <code className="machine text-caption text-fg-tertiary">
                        {item.preset_id} · provider {item.provider_id}
                      </code>
                      {mismatch ? <span className="block text-caption text-warning">{t("provider 不同（需要 {providerId}）：不可套用", { providerId: target.providerId })}</span> : null}
                    </span>
                  </label>
                  <Button
                    size="icon-sm"
                    variant="quiet"
                    className="mt-2 size-7 text-fg-tertiary hover:text-danger"
                    icon={<Trash2 aria-hidden />}
                    aria-label={t("刪除 preset「{label}」", { label: item.label || item.preset_id })}
                    title={t("刪除 preset（已套用過它的元件設定不受影響）")}
                    onClick={() => setDeleting(item)}
                  />
                </div>
              );
            })}
          </fieldset>
        ) : null}
        {preset ? (
          <>
            <Checkbox
              id="preset-keep-device"
              label={t("保留本 instance 的 device 與 model_path")}
              description={t("preset 可能來自其他 Node／裝置；取消勾選則一併套用 preset 的 device 與路徑。")}
              checked={keepDevice}
              onChange={(event) => setKeepDevice(event.target.checked)}
            />
            <section className="grid gap-2">
              <h3 className="text-data font-semibold text-fg">{t("套用後與目前草稿的差異（{changesCount}）", { changesCount: changes.length })}</h3>
              <DiffTable
                entries={changes}
                beforeLabel={t("目前草稿")}
                afterLabel={t("套用 preset 後")}
                label={t("preset 差異")}
                highlight={(path) => (path.startsWith("load.device") || path === "load.model_path" ? t("device／路徑差異：請確認此 Node 上確實存在") : null)}
              />
            </section>
          </>
        ) : null}
      </DialogBody>
      {deleting ? (
        <DeletePresetDialog
          key={deleting.preset_id}
          preset={deleting}
          onOpenChange={(open) => (open ? undefined : setDeleting(null))}
          onDeleted={(presetId) => {
            if (selected === presetId) setSelected(null);
            setDeleting(null);
          }}
        />
      ) : null}
      <DialogFooter>
        <Button variant="quiet" onClick={onCancel}>
          {t("取消")}
        </Button>
        <ActionButton variant="primary" icon={<ClipboardPaste aria-hidden />} disabledReason={next ? null : t("請先選擇 preset")} onClick={() => next && onApply(next)}>
          {t("套用到草稿（尚未儲存）")}
        </ActionButton>
      </DialogFooter>
    </>
  );
}

/** 套用 preset：只複製到草稿並顯示差異；provider 必須相同；之後由使用者按儲存。 */
export function ApplyPresetDialog({
  target,
  onOpenChange,
  onApply,
}: {
  target: ApplyPresetTarget | null;
  onOpenChange: (open: boolean) => void;
  onApply: (next: InstanceSettings) => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{t("套用 preset 到草稿")}</DialogTitle>
          <DialogDescription>{t("套用不會觸碰進行中的呼叫，也不會自動儲存或重新載入。")}</DialogDescription>
        </DialogHeader>
        {target ? <ApplyPresetForm target={target} onApply={onApply} onCancel={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}
