import { FileUp, LoaderCircle, X } from "lucide-react";
import { useId, useState } from "react";
import { uploadFile } from "@/api/files";
import type { FileRef } from "@/api/generated/contracts";
import { useRunList } from "@/api/runs";
import type { WireTypedValue } from "@/api/types";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { FileRefView } from "@/components/common/FileRefView";
import { JsonEditor } from "@/components/common/JsonEditor";
import { Button } from "@/components/ui/button";
import { Select, Textarea } from "@/components/ui/controls";
import { cn } from "@/lib/cn";
import { formatBytes, formatTimestamp, shortId } from "@/lib/format";
import { acceptFor, collectFileCandidates, defaultMode, mediaMismatch } from "./fileRefs";
import { t } from "@/i18n";

/** 上傳檔案（POST /api/files，octet-stream）：上傳中顯示檔名與大小；失敗保留可重選。 */
export function FileUploadField({
  id,
  typeId,
  disabled,
  onUploaded,
  trackUpload,
}: {
  id: string;
  typeId: string;
  disabled?: boolean;
  onUploaded: (value: { type_id: string; file: FileRef }) => void;
  /** 選填：上傳開始時呼叫，回傳的函式在上傳結束（成功或失敗）時呼叫，例如讓頁面在上傳完成前擋下送出。 */
  trackUpload?: () => () => void;
}) {
  const [pending, setPending] = useState<{ name: string; size: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  return (
    <div className="grid gap-2">
      {/* 上傳中：圖示換成旋轉進度、底部一條不定進度光帶（瀏覽器沒有回報進度，不顯示百分比）；按下時輕微縮小 */}
      <label
        htmlFor={id}
        className={cn(
          "relative inline-flex min-h-10 w-fit max-w-full cursor-pointer items-center gap-2 overflow-hidden rounded-lg border border-line-control bg-raised px-3 text-body text-fg hover:border-fg-tertiary hover:bg-overlay focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus",
          disabled || pending ? "cursor-not-allowed text-fg-disabled hover:border-line-control hover:bg-raised" : "pressable",
        )}
      >
        {pending ? <LoaderCircle aria-hidden className="size-4 shrink-0 text-action-fg animate-spin" /> : <FileUp aria-hidden className="size-4 shrink-0" />}
        <span className="min-w-0 truncate" title={pending ? pending.name : undefined}>
          {pending ? t("上傳中：{name}（{pendingCount}）…", { name: pending.name, pendingCount: formatBytes(pending.size) }) : t("上傳檔案")}
        </span>
        {pending ? <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-brand-gradient-soft animate-shimmer" /> : null}
        <input
          id={id}
          type="file"
          className="sr-only"
          accept={acceptFor(typeId)}
          disabled={disabled || pending !== null}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            setError(null);
            setPending({ name: file.name, size: file.size });
            const end = trackUpload?.();
            uploadFile(file)
              .then((ref) => onUploaded({ type_id: typeId, file: ref }))
              .catch((cause: unknown) => setError(cause))
              .finally(() => {
                setPending(null);
                end?.();
              });
          }}
        />
      </label>
      {error ? <ErrorCallout error={error} write title={t("上傳失敗；可重新選擇檔案")} /> : null}
    </div>
  );
}

/** 從近期 run 的輸入／輸出挑選既有 FileRef（同 type_id）。 */
export function FileRefPicker({
  id,
  typeId,
  onPick,
  disabled,
}: {
  id: string;
  typeId: string;
  onPick: (value: { type_id: string; file: FileRef }) => void;
  disabled?: boolean;
}) {
  const runs = useRunList(50);
  const all = runs.data?.pages.flatMap((page) => page.items) ?? [];
  const candidates = collectFileCandidates(all, typeId);
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-caption text-fg-secondary">
        {t("或從近期 run 挑選既有檔案（{typeId}）", { typeId })}
      </label>
      <Select
        id={id}
        value=""
        disabled={disabled || candidates.length === 0}
        onChange={(event) => {
          const found = candidates.find((candidate) => candidate.key === event.target.value);
          if (found) onPick(found.value);
        }}
      >
        <option value="">
          {runs.isPending ? t("讀取近期 run…") : runs.isError ? t("無法讀取 run 列表") : candidates.length === 0 ? t("近期 run 沒有此型別的檔案") : t("選擇（{candidatesCount} 個）", { candidatesCount: candidates.length })}
        </option>
        {candidates.map((candidate) => (
          <option key={candidate.key} value={candidate.key}>
            {candidate.runLabel} · {candidate.where} · {candidate.value.file.media_type} · {formatBytes(candidate.value.file.size_bytes)} · sha {shortId(candidate.value.file.sha256, 8)} · {formatTimestamp(candidate.createdAt)}
            {candidate.note ? t("（{note}）", { note: candidate.note }) : ""}
          </option>
        ))}
      </Select>
    </div>
  );
}

/**
 * 依 type_id 與 transport 輸入一個 TypedValue：text.* 用文字框、其他 inline 用 JSON、檔案可上傳或挑選既有 FileRef。
 */
export function TypedValueInput({
  id,
  label,
  typeId,
  transport,
  value,
  onChange,
  required = false,
  disabled = false,
  trackUpload,
}: {
  id: string;
  label: string;
  typeId: string;
  transport: "inline" | "file" | "either";
  value: WireTypedValue | null;
  onChange: (next: WireTypedValue | null) => void;
  required?: boolean;
  disabled?: boolean;
  /** 選填：檔案上傳的開始／結束（見 FileUploadField）。 */
  trackUpload?: () => () => void;
}) {
  const groupId = useId();
  const [modeChoice, setModeChoice] = useState<"inline" | "file" | null>(null);
  const mode = value ? ("file" in value ? "file" : "inline") : (modeChoice ?? defaultMode(typeId, transport));
  const mismatch = value && "file" in value ? mediaMismatch(typeId, value.file.media_type) : null;
  return (
    <div className="grid min-w-0 gap-2">
      {transport === "either" ? (
        <div role="radiogroup" aria-labelledby={groupId} className="flex flex-wrap items-center gap-3 text-caption text-fg-secondary">
          <span id={groupId}>{t("{label} 的傳遞方式", { label })}</span>
          {(["inline", "file"] as const).map((item) => (
            <label key={item} className="inline-flex min-h-8 cursor-pointer items-center gap-1.5">
              <input
                type="radio"
                className="accent-action"
                name={`${id}-mode`}
                checked={mode === item}
                disabled={disabled}
                onChange={() => {
                  setModeChoice(item);
                  onChange(null);
                }}
              />
              {item === "inline" ? "inline JSON" : t("檔案（FileRef）")}
            </label>
          ))}
        </div>
      ) : null}
      {mode === "inline" ? (
        typeId.startsWith("text.") ? (
          <Textarea
            id={id}
            aria-label={label}
            value={value && "value" in value && typeof value.value === "string" ? value.value : ""}
            disabled={disabled}
            rows={4}
            onChange={(event) => onChange(event.target.value === "" && !required ? null : { type_id: typeId, value: event.target.value })}
          />
        ) : (
          <JsonEditor
            id={id}
            label={t("{label}（inline JSON）", { label })}
            hideLabel
            value={value && "value" in value ? value.value : null}
            onChange={(next) => onChange({ type_id: typeId, value: next })}
            rows={5}
            disabled={disabled}
            description={t("inline JSON 上限 256 KiB；大內容請改用檔案。")}
          />
        )
      ) : (
        <div className="grid gap-3">
          {value && "file" in value ? (
            <div className="grid gap-2 rounded-md border border-line-subtle bg-sunken/60 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-caption text-fg-secondary">{t("已選擇的檔案")}</span>
                <Button size="sm" variant="quiet" icon={<X aria-hidden />} disabled={disabled} onClick={() => onChange(null)}>
                  {t("清除")}
                </Button>
              </div>
              <FileRefView file={value.file} downloadLabel={label} />
              {mismatch ? <p className="text-caption text-warning">{mismatch}</p> : null}
            </div>
          ) : null}
          <div className="flex flex-wrap items-end gap-3">
            <FileUploadField id={`${id}-upload`} typeId={typeId} disabled={disabled} onUploaded={onChange} trackUpload={trackUpload} />
            <div className="min-w-64 flex-1">
              <FileRefPicker id={`${id}-pick`} typeId={typeId} disabled={disabled} onPick={onChange} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
