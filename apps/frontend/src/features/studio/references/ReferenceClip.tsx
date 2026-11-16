// A video or audio reference's clip settings, opened from its row: start and end (seconds; empty = the file's start or
// end), a preview that plays only the part that is sent, and for a video whether its last frame is held after the end
// (hold_last_frame) and whether its own sound is sent as an audio reference (off for a new reference, with a warning
// when on). Every field commits on Enter or leaving it; a rejected value stays with its reason.
import { Play, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import type { StudioLibraryItem, StudioReference } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import { Button } from "@/components/ui/button";
import { Checkbox, Switch } from "@/components/ui/controls";
import { TOOL_BUTTON_ON } from "@/components/ui/look";
import { cn } from "@/lib/cn";
import { formatSeconds, parseSecondsInput } from "../prompt/blocks";
import { DraftField } from "../prompt/DraftField";
import { clipSeconds, heldReference, type PresentationLabel } from "./materials";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

export function ReferenceClip({
  reference,
  item,
  label,
  disabled,
  onChange,
}: {
  reference: StudioReference;
  item: StudioLibraryItem | undefined;
  label: PresentationLabel | undefined;
  disabled: boolean;
  onChange: (patch: Partial<StudioReference>) => void;
}) {
  const id = useId();
  const [previewOpen, setPreviewOpen] = useState(false);
  const alias = `@${reference.alias}`;
  const duration = item?.duration_seconds ?? null;
  const clip = clipSeconds(reference, item);
  const start = reference.start_seconds;
  const end = reference.end_seconds;
  const soundtrack = label?.soundtrack ?? null;
  const embedded = reference.use_embedded_audio !== false;

  const commitStart = (text: string): string | null => {
    const parsed = parseSecondsInput(text);
    if (parsed.error) return parsed.error;
    const value = parsed.value;
    if (value !== null) {
      if (value < 0) return t("起點不可小於 0");
      if (end !== null && value >= end) return t("起點必須小於終點");
      if (duration !== null && value >= duration) return t("起點超過素材長度 {duration} 秒", { duration: formatSeconds(duration, 1) });
    }
    onChange({ start_seconds: value === 0 ? null : value });
    return null;
  };
  const commitEnd = (text: string): string | null => {
    const parsed = parseSecondsInput(text);
    if (parsed.error) return parsed.error;
    const value = parsed.value;
    if (value !== null) {
      if (value <= (start ?? 0)) return t("終點必須大於起點");
      if (duration !== null && value > duration + 1e-6) return t("終點超過素材長度 {duration} 秒", { duration: formatSeconds(duration, 1) });
    }
    onChange({ end_seconds: value });
    return null;
  };
  const src = item ? `${mediaUrl(item.file.node_id, item.file.file_id)}#t=${start ?? 0}${end !== null ? `,${end}` : ""}` : null;

  return (
    <div className="grid gap-1.5 rounded-md border border-line-subtle bg-sunken/60 p-2 animate-reveal">
      <div className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1">
        <label htmlFor={`${id}-start`} className="pt-1 text-caption text-fg-tertiary">
          {t("起點")}
        </label>
        <DraftField id={`${id}-start`} label={t("{alias} 起點（秒）", { alias })} mono inputMode="decimal" disabled={disabled} placeholder="0" value={start === null ? "" : String(start)} onCommit={commitStart} className="w-20" />
        <label htmlFor={`${id}-end`} className="pt-1 text-caption text-fg-tertiary">
          {t("終點")}
        </label>
        <DraftField id={`${id}-end`} label={t("{alias} 終點（秒）", { alias })} mono inputMode="decimal" disabled={disabled} placeholder={t("結尾")} value={end === null ? "" : String(end)} onCommit={commitEnd} className="w-20" />
        <span className="pt-1 text-caption text-fg-tertiary">
          <T source={"秒 · 使用 {span}"} values={{ span: <span className="machine">{clip === null ? t("長度未知") : t("{max} 秒", { max: formatSeconds(Math.max(0, clip), 1) })}</span> }} />
        </span>
        {src ? (
          <Button size="sm" variant="quiet" className={cn("ml-auto min-h-7 px-2", previewOpen && TOOL_BUTTON_ON)} icon={<Play aria-hidden />} aria-expanded={previewOpen} onClick={() => setPreviewOpen((open) => !open)}>
            {t("預覽片段")}
          </Button>
        ) : null}
      </div>
      {src && previewOpen ? (
        // 媒體片段（#t=起點,終點）：只播放實際送出的範圍
        <div className="animate-reveal">
          {reference.kind === "video" ? (
            <video key={src} src={src} controls preload="metadata" aria-label={t("{alias} 片段預覽", { alias })} className="max-h-48 w-full rounded-md bg-stage" />
          ) : (
            <audio key={src} src={src} controls preload="metadata" aria-label={t("{alias} 片段預覽", { alias })} className="w-full" />
          )}
        </div>
      ) : null}
      {reference.kind === "video" ? (
        <>
          {/* Off writes null (the contract's "not held"), so a request without the hold stays as it was */}
          <Checkbox
            id={`${id}-hold`}
            label={t("終點之後凍結最後一格")}
            description={t("參考影片只用到終點，之後重複最後一格、聲音補靜音，補滿生成長度；模型不會提早畫出終點之後的鏡頭。換角時建議打開。")}
            checked={heldReference(reference)}
            disabled={disabled}
            onChange={(event) => onChange({ hold_last_frame: event.target.checked ? true : null })}
            className="min-h-8 py-1"
          />
          {item?.has_audio === false ? (
            <p className="text-caption text-fg-tertiary">{t("這段影片沒有音軌，只用畫面。")}</p>
          ) : (
            <>
              {/* Off by default for a new reference: the original lines belong to the original characters' mouths and voices */}
              <Switch
                id={`${id}-audio`}
                label={t("使用原片聲音當參考")}
                aria-describedby={embedded ? `${id}-audio-warning` : undefined}
                description={
                  !embedded
                    ? t("只用畫面；台詞與聲音照 prompt 生成（台詞寫成 <d>[語言] 原文</d>），不佔用 <Audio n>。")
                    : soundtrack?.state === "unknown"
                      ? t("瀏覽器無法判斷有沒有音軌；有的話會多一個 <Audio n>，排在所有聲音參考之後（由 runtime probe 決定）。")
                      : t("會多送一個聲音參考 {value}（排在所有聲音參考之後）。", { value: soundtrack?.label ?? "<Audio n>" })
                }
                checked={embedded}
                disabled={disabled}
                onChange={(event) => onChange({ use_embedded_audio: event.target.checked })}
                className="min-h-8 py-1"
              />
              {embedded ? (
                <p id={`${id}-audio-warning`} className="flex items-start gap-1.5 text-caption text-warning animate-fade-in">
                  <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                  {t("原片的台詞是原角色的聲音：嘴型與聲線會對不上新角色。要角色說話時，關掉「使用原片聲音當參考」，在 prompt 寫 <d> 台詞。")}
                </p>
              ) : null}
            </>
          )}
        </>
      ) : null}
    </div>
  );
}
