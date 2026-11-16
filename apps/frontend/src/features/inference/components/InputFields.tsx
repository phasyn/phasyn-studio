import { Film, X } from "lucide-react";
import type { Asset, FileRef, Port } from "@/api/generated/contracts";
import { useRunList } from "@/api/runs";
import type { WireTypedValue } from "@/api/types";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { Button } from "@/components/ui/button";
import { Select, Textarea } from "@/components/ui/controls";
import { formatBytes, formatTimestamp, shortId } from "@/lib/format";
import { FileRefPicker, TypedValueInput } from "@/features/pipelines";
import { beginUpload, fileNameOf, rememberFileName } from "../draftStore";
import { acceptOf, assetCandidates, familyMismatch, mediaFamily, type MediaFamily } from "../model/inputs";
import { useUploads } from "../useUploads";
import { MediaPreview } from "@/components/values/MediaPreview";
import { UploadButton } from "./UploadButton";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

type ValueUpdate = (next: WireTypedValue | null) => void;

const FAMILY_LABEL: Record<MediaFamily, string> = { image: t("圖片"), video: t("影片"), audio: t("聲音") };

/** 清除後按鈕消失：焦點移到穩定的位置（上傳鈕）。 */
function focusLater(id: string) {
  window.requestAnimationFrame(() => document.getElementById(id)?.focus());
}

/** text.prompt.v1：多行文字（原樣送出，不改寫、不補字）。 */
export function PromptField({ id, port, value, onChange, disabled }: { id: string; port: Port; value: WireTypedValue | null; onChange: ValueUpdate; disabled: boolean }) {
  const text = value && "value" in value && typeof value.value === "string" ? value.value : "";
  return (
    <div className="grid gap-1">
      <Textarea
        id={id}
        value={text}
        disabled={disabled}
        rows={8}
        spellCheck={false}
        placeholder={t("描述畫面、動作、聲音與時間軸；ref2va 可用 <Picture 1>、<Video 1>、<Audio 1> 引用參考素材")}
        onChange={(event) => onChange(event.target.value === "" ? null : { type_id: port.type_id, value: event.target.value })}
        className="min-h-40 text-data leading-6"
      />
      <p className="flex flex-wrap justify-between gap-2 text-caption text-fg-tertiary">
        <span>{t("原樣送給元件（不翻譯、不改寫）。H3 沒有負向 prompt。")}</span>
        <span className="machine">{t("{textCount} 字元", { textCount: text.length })}</span>
      </p>
    </div>
  );
}

/** 已選擇的檔案：預覽＋事實＋清除。 */
function ChosenFile({ file, title, mismatch, onClear, disabled }: { file: FileRef; title: string; mismatch: string | null; onClear: () => void; disabled: boolean }) {
  return (
    <div className="grid gap-2 rounded-lg border border-line-subtle bg-sunken/50 p-2 animate-rise-in">
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-caption">
        <span className="min-w-0 truncate text-data text-fg" title={title}>
          {title}
        </span>
        <span className="machine text-fg-tertiary">{`${file.media_type || t("未知類型")} · ${formatBytes(file.size_bytes)} · sha ${shortId(file.sha256, 8)}`}</span>
        <Button size="sm" variant="quiet" icon={<X aria-hidden />} disabled={disabled} onClick={onClear} className="ml-auto min-h-7 px-2">
          {t("清除")}
        </Button>
      </div>
      <MediaPreview file={file} title={title} />
      {mismatch ? <p className="text-caption text-warning">{t("{mismatch}；元件可能拒絕。", { mismatch })}</p> : null}
    </div>
  );
}

/** media.image.v1／media.video.v1／media.audio.v1：上傳到主控（或挑選近期 run 的檔）＋預覽。 */
export function MediaField({ id, pipelineId, port, value, onChange, disabled }: { id: string; pipelineId: string; port: Port; value: WireTypedValue | null; onChange: ValueUpdate; disabled: boolean }) {
  const family = mediaFamily(port.type_id) ?? "image";
  const uploads = useUploads(pipelineId);
  const file = value && "file" in value ? value.file : null;
  return (
    <div className="grid gap-2">
      {file ? (
        <ChosenFile
          file={file}
          title={fileNameOf(file.file_id) ?? t("{name}（{family}）", { name: port.name, family: FAMILY_LABEL[family] })}
          mismatch={familyMismatch(family, file.media_type)}
          onClear={() => {
            onChange(null);
            focusLater(`${id}-upload`);
          }}
          disabled={disabled}
        />
      ) : null}
      <div className="flex flex-wrap items-start gap-3">
        <UploadButton
          inputId={`${id}-upload`}
          label={file ? t("換一個{family}", { family: FAMILY_LABEL[family] }) : t("上傳{family}", { family: FAMILY_LABEL[family] })}
          accept={acceptOf(family)}
          disabledReason={disabled ? t("建立 run 中") : null}
          pendingText={uploads.progress ? t("上傳中：{name}（{progressCount}）", { name: uploads.progress.name, progressCount: formatBytes(uploads.progress.size) }) : null}
          onFiles={(files) =>
            void uploads.upload(files.slice(0, 1), (picked, ref) => {
              rememberFileName(ref.file_id, picked.name);
              onChange({ type_id: port.type_id, file: ref });
            })
          }
        />
        <div className="min-w-56 flex-1">
          <FileRefPicker id={`${id}-pick`} typeId={port.type_id} disabled={disabled} onPick={onChange} />
        </div>
      </div>
      {uploads.failures.map((failure) => (
        <ErrorCallout key={failure.name} error={failure.error} write title={t("「{name}」上傳失敗；可重新選擇檔案", { name: failure.name })} />
      ))}
    </div>
  );
}

function assetTitle(asset: Asset): string {
  const size = asset.width && asset.height ? `${asset.width}×${asset.height}` : t("畫幅未知");
  const fps = asset.fps && asset.fps.den > 0 ? `${(asset.fps.num / asset.fps.den).toFixed(2)} fps` : t("fps 未知");
  return t("{kind} · {frame_count} 幀 · {fps} · {size}{value}", { kind: asset.kind, frame_count: asset.frame_count, fps, size, value: asset.complete ? "" : t(" · 未完成") });
}

/**
 * media.asset.v1：Asset 需要實測的幀數、fps 與畫幅——上傳的檔案沒有這些值，所以 inline 輸入只能挑選近期 run 產生的 Asset；
 * 輸入接受檔案（transport file／either）時才可以上傳。
 */
export function AssetField({ id, pipelineId, port, value, onChange, disabled }: { id: string; pipelineId: string; port: Port; value: WireTypedValue | null; onChange: ValueUpdate; disabled: boolean }) {
  const runs = useRunList();
  const uploads = useUploads(pipelineId);
  const candidates = assetCandidates(runs.data?.pages.flatMap((page) => page.items) ?? []);
  const inlineAsset = value && "value" in value ? (candidates.find((candidate) => candidate.asset.asset_id === (value.value as { asset_id?: unknown } | null)?.asset_id) ?? null) : null;
  const file = value && "file" in value ? value.file : null;
  const allowsFile = port.transport !== "inline";
  const allowsInline = port.transport !== "file";
  const clear = () => {
    onChange(null);
    focusLater(allowsInline ? `${id}-asset` : `${id}-upload`);
  };
  return (
    <div className="grid gap-2">
      {inlineAsset ? (
        <ChosenFile file={inlineAsset.asset.file} title={t("Asset {asset_id}（{asset}）", { asset_id: shortId(inlineAsset.asset.asset_id), asset: assetTitle(inlineAsset.asset) })} mismatch={null} onClear={clear} disabled={disabled} />
      ) : value && "value" in value ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line-subtle bg-sunken/50 p-2 text-caption text-fg-secondary">
          <Film aria-hidden className="size-4 text-fg-tertiary" />
          <T source={"已選擇的 Asset 不在近期 run 清單中（仍會照原樣送出）。<0>清除</0>"} slots={[<Button size="sm" variant="quiet" icon={<X aria-hidden />} disabled={disabled} onClick={clear} className="ml-auto min-h-7 px-2" />]} />
        </div>
      ) : null}
      {file ? <ChosenFile file={file} title={fileNameOf(file.file_id) ?? port.name} mismatch={null} onClear={clear} disabled={disabled} /> : null}
      <div className="flex flex-wrap items-start gap-3">
        {allowsInline ? (
          <label className="grid min-w-64 flex-1 gap-1 text-caption text-fg-secondary" htmlFor={`${id}-asset`}>
            <T source={"從近期 run 挑選 Asset（實測的幀數、fps 與畫幅）{select}"} values={{ select: <Select
              id={`${id}-asset`}
              compact
              value=""
              disabled={disabled || candidates.length === 0}
              onChange={(event) => {
                const found = candidates.find((candidate) => candidate.key === event.target.value);
                if (found) onChange({ type_id: port.type_id, value: found.asset });
              }}
            >
              <option value="">
                {runs.isPending ? t("讀取近期 run…") : runs.isError ? t("無法讀取 run 列表") : candidates.length === 0 ? t("近期 run 沒有 Asset 輸出") : t("選擇（{candidatesCount} 個）", { candidatesCount: candidates.length })}
              </option>
              {candidates.map((candidate) => (
                <option key={candidate.key} value={candidate.key}>
                  {`${candidate.runLabel} · ${candidate.where} · ${assetTitle(candidate.asset)} · ${formatTimestamp(candidate.createdAt)}`}
                </option>
              ))}
            </Select> }} />
          </label>
        ) : null}
        {allowsFile ? (
          <UploadButton
            inputId={`${id}-upload`}
            label={t("上傳檔案")}
            accept="video/*,audio/*"
            disabledReason={disabled ? t("建立 run 中") : null}
            pendingText={uploads.progress ? t("上傳中：{name}", { name: uploads.progress.name }) : null}
            onFiles={(files) =>
              void uploads.upload(files.slice(0, 1), (picked, ref) => {
                rememberFileName(ref.file_id, picked.name);
                onChange({ type_id: port.type_id, file: ref });
              })
            }
          />
        ) : (
          <p className="max-w-[44ch] text-caption text-fg-tertiary">
            {t("這個輸入只接受 inline 的 Asset：上傳的檔案沒有實測的幀數與 fps，不能當成 Asset 送出（不補假值）。需要上傳時，請在元件組合中改用接受 media.video.v1 的輸入。")}
          </p>
        )}
      </div>
      {uploads.failures.map((failure) => (
        <ErrorCallout key={failure.name} error={failure.error} write title={t("「{name}」上傳失敗；可重新選擇檔案", { name: failure.name })} />
      ))}
    </div>
  );
}

/** 其他型別：沿用元件組合的輸入編輯器（inline JSON、上傳或挑選既有 FileRef）；上傳中同樣擋下送出。 */
export function GenericField({ id, pipelineId, port, value, onChange, disabled }: { id: string; pipelineId: string; port: Port; value: WireTypedValue | null; onChange: ValueUpdate; disabled: boolean }) {
  return (
    <TypedValueInput
      id={id}
      label={port.name}
      typeId={port.type_id}
      transport={port.transport}
      required={port.required}
      value={value}
      onChange={onChange}
      disabled={disabled}
      trackUpload={() => beginUpload(pipelineId)}
    />
  );
}
