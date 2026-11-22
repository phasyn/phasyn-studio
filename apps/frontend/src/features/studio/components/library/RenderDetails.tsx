// 素材庫右側的渲染成品詳細資料（take 或序列匯出）：大預覽、媒體資訊、seed／路由／run id、下載、設為使用中（take）與
// 跳到鏡頭（take）。渲染成品不是素材庫項目：沒有改名、備註或移除（刪除 take 或匯出不在素材庫做）。
// 選了幾個時改成選取摘要（數量與總大小）。
import { Download, Maximize2, MonitorPlay, MousePointerClick } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { mediaUrl } from "@/api/http";
import { Button } from "@/components/ui/button";
import { motionTransition } from "@/components/ui/motion";
import { buttonVariants } from "@/components/ui/variants";
import { formatList, joinInline } from "@/i18n/format";
import { extensionFor } from "@/lib/download";
import { formatBytesExact, formatTimestamp } from "@/lib/format";
import { renderEntryName, type RenderEntry } from "../../model/library";
import { takeRouteSummary } from "../../model/routes";
import { useStudio } from "../../studioContext";
import { CapabilityBadge } from "../routeParts";
import { TakeDownloadLink } from "../TakeDownload";
import { renderDimensions, renderDuration, renderSize, renderTotalSize } from "./display";
import { ActiveMark, RenderThumb } from "./cardParts";
import { t } from "@/i18n";

/** 檔名裡檔案系統不接受的字元（與控制字元）。 */
const UNSAFE_NAME = /[\\/:*?"<>|\p{Cc}]+/gu;

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-tertiary">{label}</dt>
      <dd className="min-w-0 truncate text-fg-secondary">{children}</dd>
    </>
  );
}

function Mono({ value }: { value: string }) {
  return (
    <span className="machine" title={value}>
      {value}
    </span>
  );
}

function LargePreview({ entry, onExpand }: { entry: RenderEntry; onExpand: () => void }) {
  const url = mediaUrl(entry.asset.file.node_id, entry.asset.file.file_id);
  return (
    <div className="group/tile relative grid aspect-video w-full place-items-center overflow-hidden rounded-xl border border-line-subtle bg-stage">
      <video key={url} src={url} controls muted playsInline preload="metadata" className="size-full object-contain" />
      <button
        type="button"
        onClick={onExpand}
        aria-label={t("放大預覽")}
        title={t("放大預覽（Enter）")}
        className="pressable material-hud absolute top-2 right-2 inline-flex size-7 items-center justify-center rounded-full border border-white/10 text-fg opacity-0 transition-opacity duration-(--duration-fast) group-hover/tile:opacity-100 focus-visible:opacity-100 [&_svg]:size-3.5"
      >
        <Maximize2 aria-hidden />
      </button>
    </div>
  );
}

const NOT_LIBRARY_NOTE = () => t("渲染成品不是素材庫項目：不能在這裡改名、備註或移除。");

function TakeDetails({ entry, onExpand, onUseTake, onJumpToShot }: { entry: Extract<RenderEntry, { kind: "take" }>; onExpand: () => void; onUseTake: (shotId: string, takeId: string) => void; onJumpToShot: (shotId: string, takeId: string) => void }) {
  const { engine } = useStudio();
  const { shot, take } = entry;
  const route = takeRouteSummary(engine.routes, take);
  const aliases = (take.references ?? []).map((ref) => `@${ref.alias}`);
  return (
    <div className="grid content-start gap-4 p-4">
      <LargePreview entry={entry} onExpand={onExpand} />
      <div className="grid gap-1">
        <h3 className="flex min-w-0 items-center gap-2 text-data font-semibold text-fg">
          <span className="min-w-0 truncate">{renderEntryName(entry)}</span>
          {entry.active ? <ActiveMark className="shrink-0 text-caption font-medium" /> : null}
        </h3>
        <p className="text-caption text-fg-tertiary">{joinInline([renderDimensions(entry), renderDuration(entry), renderSize(entry)])}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant={entry.active ? "secondary" : "primary"} disabled={entry.active} onClick={() => { onUseTake(shot.shot_id, take.take_id); }} title={entry.active ? t("時間軸與匯出用這個 take") : t("時間軸與匯出改用這個 take")}>
          {entry.active ? t("使用中") : t("設為使用中")}
        </Button>
        <Button size="sm" variant="secondary" icon={<MonitorPlay aria-hidden />} onClick={() => { onJumpToShot(shot.shot_id, take.take_id); }} title={t("關閉素材庫，到編輯的監看器看這個 take")}>
          {t("跳到鏡頭")}
        </Button>
        <TakeDownloadLink shot={shot} take={take} className={buttonVariants({ variant: "quiet", size: "sm" })} />
      </div>
      <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-caption">
        <Fact label={t("鏡頭")}>
          <span className="machine text-fg-tertiary">{String(entry.shotIndex + 1).padStart(2, "0")}</span> {shot.title}
        </Fact>
        <Fact label="take">{`${String(entry.takeNumber)} / ${String(shot.takes.length)}`}</Fact>
        {take.seed !== null ? <Fact label="seed">
          <span className="machine">{take.seed}</span>
        </Fact> : null}
        <Fact label={t("運算路由")}>
          <span className="inline-flex min-w-0 items-center gap-1.5" title={route.title}>
            <span className="truncate">{route.label}</span>
            <CapabilityBadge task={route.task} className="px-1 text-[11px]" />
          </span>
        </Fact>
        {take.steps !== null ? <Fact label="steps">{take.steps}</Fact> : null}
        <Fact label={t("影格數")}>
          <span className="machine">{entry.asset.frame_count}</span>
        </Fact>
        <Fact label={t("大小")}>
          <span title={formatBytesExact(entry.asset.file.size_bytes)}>{renderSize(entry)}</span>
        </Fact>
        <Fact label={t("格式")}>
          <span className="machine">{entry.asset.file.media_type}</span>
        </Fact>
        <Fact label={t("建立時間")}>{formatTimestamp(take.created_at)}</Fact>
        {aliases.length > 0 ? <Fact label={t("參考素材")}>{formatList(aliases)}</Fact> : null}
        <Fact label="run">
          <Mono value={take.run_id} />
        </Fact>
        <Fact label="take ID">
          <Mono value={take.take_id} />
        </Fact>
      </dl>
      {(take.prompt ?? "").length > 0 ? (
        <section className="grid gap-1.5" aria-label="Prompt">
          <h4 className="text-caption font-medium text-fg-secondary">Prompt</h4>
          <p className="max-h-40 overflow-y-auto rounded-md border border-line-subtle bg-sunken/60 px-2.5 py-2 text-caption whitespace-pre-wrap text-fg-secondary [overflow-wrap:anywhere]">{take.prompt}</p>
        </section>
      ) : null}
      <p className="border-t border-line-subtle pt-3 text-caption text-fg-tertiary">{NOT_LIBRARY_NOTE()}</p>
    </div>
  );
}

function ExportDetails({ entry, onExpand }: { entry: Extract<RenderEntry, { kind: "export" }>; onExpand: () => void }) {
  const { project } = useStudio();
  const { record, asset } = entry;
  const file = asset.file;
  const title = project.title.replace(UNSAFE_NAME, "-").trim() || "export";
  return (
    <div className="grid content-start gap-4 p-4">
      <LargePreview entry={entry} onExpand={onExpand} />
      <div className="grid gap-1">
        <h3 className="truncate text-data font-semibold text-fg">{renderEntryName(entry)}</h3>
        <p className="text-caption text-fg-tertiary">{joinInline([renderDimensions(entry), renderDuration(entry), renderSize(entry)])}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <a href={mediaUrl(file.node_id, file.file_id)} download={`${title} export ${String(entry.exportNumber)}.${extensionFor(file.media_type)}`} className={buttonVariants({ variant: "secondary", size: "sm" })}>
          <Download aria-hidden />
          {t("下載 MP4")}
        </a>
      </div>
      <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-caption">
        <Fact label={t("鏡頭")}>{t("{count} 個鏡頭", { count: record.shot_ids.length })}</Fact>
        <Fact label={t("影格數")}>
          <span className="machine">{asset.frame_count}</span>
        </Fact>
        <Fact label={t("大小")}>
          <span title={formatBytesExact(file.size_bytes)}>{renderSize(entry)}</span>
        </Fact>
        <Fact label={t("格式")}>
          <span className="machine">{file.media_type}</span>
        </Fact>
        <Fact label={t("建立時間")}>{formatTimestamp(record.created_at)}</Fact>
        <Fact label="run">
          <Mono value={record.run_id} />
        </Fact>
        <Fact label="export ID">
          <Mono value={record.export_id} />
        </Fact>
      </dl>
      <p className="border-t border-line-subtle pt-3 text-caption text-fg-tertiary">{NOT_LIBRARY_NOTE()}</p>
    </div>
  );
}

function MultiDetails({ selected, onClearSelection }: { selected: readonly RenderEntry[]; onClearSelection: () => void }) {
  return (
    <div className="grid content-start gap-4 p-4">
      <div className="grid grid-cols-3 gap-1.5">
        {selected.slice(0, 6).map((entry) => (
          <span key={entry.id} className="grid aspect-video place-items-center overflow-hidden rounded-md border border-line-subtle bg-stage">
            <RenderThumb entry={entry} />
          </span>
        ))}
      </div>
      <h3 className="text-data font-semibold text-fg">{t("已選取 {count} 個", { count: selected.length })}</h3>
      <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-caption">
        <Fact label={t("合計大小")}>{renderTotalSize(selected)}</Fact>
      </dl>
      <div className="flex flex-wrap items-center gap-2 border-t border-line-subtle pt-3">
        <Button size="sm" variant="quiet" onClick={onClearSelection}>
          {t("取消選取")}
        </Button>
      </div>
    </div>
  );
}

export interface RenderDetailsProps {
  entry: RenderEntry | null;
  selected: readonly RenderEntry[];
  onExpand: (id: string) => void;
  onUseTake: (shotId: string, takeId: string) => void;
  onJumpToShot: (shotId: string, takeId: string) => void;
  onClearSelection: () => void;
}

export function RenderDetails({ entry, selected, onExpand, onUseTake, onJumpToShot, onClearSelection }: RenderDetailsProps) {
  const key = selected.length > 1 ? "multi" : (entry?.id ?? "none");
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div key={key} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -4 }} transition={motionTransition("fast", "standard")}>
        {selected.length > 1 ? (
          <MultiDetails selected={selected} onClearSelection={onClearSelection} />
        ) : entry?.kind === "take" ? (
          <TakeDetails entry={entry} onExpand={() => { onExpand(entry.id); }} onUseTake={onUseTake} onJumpToShot={onJumpToShot} />
        ) : entry?.kind === "export" ? (
          <ExportDetails entry={entry} onExpand={() => { onExpand(entry.id); }} />
        ) : (
          <div className="grid h-full content-center justify-items-center gap-2 p-6 text-center">
            <span aria-hidden className="grid size-10 place-items-center rounded-xl border border-line bg-sunken text-fg-tertiary">
              <MousePointerClick className="size-5" />
            </span>
            <p className="text-data text-fg-secondary">{t("選一個渲染成品查看詳細資料")}</p>
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
