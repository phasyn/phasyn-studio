// Wizard step 1: source video (library or upload), range, facts and route-independent tips.
import { AssetVideo } from "@/components/common/AssetMedia";
import { FileVideo, Film, Info, LoaderCircle, Scissors, TriangleAlert, Upload } from "lucide-react";
import { useId, useRef } from "react";
import type { StudioLibraryItem } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { OPTION_CARD, OPTION_IDLE, OPTION_SELECTED } from "@/components/ui/look";
import { reveal } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { itemFacts } from "../../references/display";
import { Fact, Facts, NoteList, NumberField, Section } from "../fields";
import { COSTUME_LEAK_TIP } from "../limits";
import type { SwapDraftApi } from "../useSwapDraft";
import type { WizardDerived } from "../wizardModel";
import { Label } from "./Label";
import { ResponsibleUseNote } from "./ResponsibleUseNote";
import { round3, seconds } from "./format";
import { t } from "@/i18n";

export function SourceStep({ api, derived, library }: { api: SwapDraftApi; derived: WizardDerived; library: readonly StudioLibraryItem[] }) {
  const { draft, update, chooseLibraryVideo, uploadSource } = api;
  const id = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const videos = library.filter((item) => item.kind === "video");
  const source = draft.source;
  const inLibrary = source ? videos.some((item) => item.file.file_id === source.file.file_id) : false;
  const facts = derived.facts;
  const duration = facts?.duration_seconds ?? null;
  const end = draft.endSeconds ?? duration;
  const uploading = draft.sourceUpload !== null && draft.sourceUpload.state !== "failed";
  const fromVideo = (field: "startSeconds" | "endSeconds") => {
    const time = videoRef.current?.currentTime;
    if (time !== undefined && Number.isFinite(time)) update({ [field]: round3(time) });
  };
  return (
    <div className="grid gap-5">
      <ResponsibleUseNote />
      <Section
        title={t("來源影片")}
        icon={<FileVideo />}
        actions={
          <Button size="sm" variant="secondary" icon={<Upload aria-hidden />} pending={uploading} onClick={() => fileInputRef.current?.click()}>
            {t("上傳影片")}
          </Button>
        }
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          tabIndex={-1}
          aria-hidden
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void uploadSource(file);
          }}
        />
        {draft.sourceUpload ? (
          <p role={draft.sourceUpload.state === "failed" ? "alert" : "status"} className={cn("flex items-start gap-1.5 text-caption [overflow-wrap:anywhere]", draft.sourceUpload.state === "failed" ? "text-danger" : "text-info")}>
            {draft.sourceUpload.state === "failed" ? <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" /> : <LoaderCircle aria-hidden className="mt-0.5 size-3.5 shrink-0 animate-spin" />}
            {draft.sourceUpload.state === "reading" ? t("讀取「{name}」的媒體資訊…", { name: draft.sourceUpload.name }) : draft.sourceUpload.state === "uploading" ? t("上傳「{name}」…", { name: draft.sourceUpload.name }) : t("「{name}」上傳失敗：{value}（重新選檔再試）", { name: draft.sourceUpload.name, value: draft.sourceUpload.error ?? "" })}
          </p>
        ) : null}
        {videos.length === 0 && !source ? (
          <div className="rounded-xl border border-dashed border-line bg-canvas/40">
            <EmptyState
              illustration="drop"
              size="compact"
              title={t("這個專案的素材庫沒有影片")}
              description={t("按「上傳影片」選一支；上傳後只加到新的換角專案，不會改動目前的專案。")}
              action={
                <Button size="sm" variant="secondary" icon={<Upload aria-hidden />} pending={uploading} onClick={() => fileInputRef.current?.click()}>
                  {t("上傳影片")}
                </Button>
              }
            />
          </div>
        ) : (
          <fieldset className="grid min-w-0 gap-1.5">
            <legend className="sr-only">{t("選擇來源影片")}</legend>
            {source && !inLibrary ? <SourceOption id={`${id}-uploaded`} index={0} name={t("{name}（剛上傳）", { name: source.name })} facts={facts ? describeFacts(facts) : ""} checked onSelect={() => undefined} /> : null}
            {videos.map((item, index) => (
              <SourceOption
                key={item.item_id}
                id={`${id}-${item.item_id}`}
                index={index + (source && !inLibrary ? 1 : 0)}
                name={item.name}
                facts={itemFacts(item)}
                checked={source?.file.file_id === item.file.file_id}
                onSelect={() => { chooseLibraryVideo(item); }}
              />
            ))}
          </fieldset>
        )}
      </Section>

      {source ? (
        <Section title={t("範圍")} icon={<Scissors />}>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_17rem]">
            <AssetVideo ref={videoRef} controls preload="metadata" src={mediaUrl(source.file.node_id, source.file.file_id)} aria-label={t("來源影片預覽：{name}", { name: source.name })} className="aspect-video w-full rounded-lg border border-line-subtle bg-stage object-contain" />
            <div className="grid content-start gap-3">
              <div className="grid gap-1">
                <Label htmlFor={`${id}-start`}>{t("起點（秒）")}</Label>
                <div className="flex items-start gap-1.5">
                  <NumberField id={`${id}-start`} value={draft.startSeconds} min={0} max={duration ?? 86_400} onCommit={(value) => { update({ startSeconds: round3(value ?? 0) }); }} className="flex-1" />
                  <Button size="sm" variant="quiet" onClick={() => { fromVideo("startSeconds"); }} title={t("用預覽播放器目前的時間當起點")}>
                    {t("設為目前時間")}
                  </Button>
                </div>
              </div>
              <div className="grid gap-1">
                <Label htmlFor={`${id}-end`}>{t("終點（秒；空白＝到結尾）")}</Label>
                <div className="flex items-start gap-1.5">
                  <NumberField id={`${id}-end`} value={draft.endSeconds} allowEmpty placeholder={duration !== null ? duration.toFixed(3) : t("到結尾")} min={0} max={duration ?? 86_400} onCommit={(value) => { update({ endSeconds: value === null ? null : round3(value) }); }} className="flex-1" />
                  <Button size="sm" variant="quiet" onClick={() => { fromVideo("endSeconds"); }} title={t("用預覽播放器目前的時間當終點")}>
                    {t("設為目前時間")}
                  </Button>
                </div>
              </div>
              <Facts className="text-caption">
                <Fact label={t("影片長度")}>{duration !== null ? seconds(duration) : t("未知（切鏡偵測會讀出）")}</Fact>
                <Fact label={t("範圍")}>{end !== null && end > draft.startSeconds ? t("{end}（{total_frames} 影格，24 fps）", { end: seconds(end - draft.startSeconds), total_frames: derived.plan.total_frames }) : "—"}</Fact>
                <Fact label={t("原聲")}>{facts?.has_audio === true ? t("有音軌") : facts?.has_audio === false ? t("沒有音軌") : t("未知")}</Fact>
                <Fact label={t("資訊來源")}>{facts?.from === "probe" ? t("切鏡偵測（ffprobe）") : t("瀏覽器讀取")}</Fact>
              </Facts>
            </div>
          </div>
        </Section>
      ) : null}
      {/* Route-independent tips: costume details of the original character can leak through; burned-in subtitles can be copied */}
      <NoteList
        tone="info"
        icon={<Info aria-hidden />}
        items={[
          t("{costumeLeakTip}。", { costumeLeakTip: COSTUME_LEAK_TIP }),
          t("原影片若有燒進畫面的字幕，建議換成本來就沒有字幕的版本：用模糊或遮罩去掉的字幕區，有時會被照抄進成片；prompt 也會要求不要字幕。"),
        ]}
      />
    </div>
  );
}

function describeFacts(facts: NonNullable<WizardDerived["facts"]>): string {
  const parts = [facts.duration_seconds !== null ? t("{duration_seconds} 秒", { duration_seconds: facts.duration_seconds.toFixed(1) }) : t("長度未知")];
  if (Boolean(facts.width) && Boolean(facts.height)) parts.push(`${String(facts.width)}×${String(facts.height)}`);
  parts.push(facts.has_audio === null ? t("音軌未知") : facts.has_audio ? t("有音軌") : t("無音軌"));
  return parts.join(" · ");
}

function SourceOption({ id, index, name, facts, checked, onSelect }: { id: string; index: number; name: string; facts: string; checked: boolean; onSelect: () => void }) {
  return (
    <label
      htmlFor={id}
      ref={reveal(index)}
      className={cn(OPTION_CARD, "flex cursor-pointer items-center gap-2.5 px-2.5 py-2", checked ? OPTION_SELECTED : OPTION_IDLE)}
    >
      <input id={id} type="radio" name="swap-source" checked={checked} onChange={onSelect} className="accent-action" />
      <Film aria-hidden className="size-4 shrink-0 text-info" />
      <span className="grid min-w-0">
        <span className="truncate text-data text-fg" title={name}>
          {name}
        </span>
        <span className="truncate text-caption text-fg-tertiary">{facts}</span>
      </span>
    </label>
  );
}
