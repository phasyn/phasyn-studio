// Confirmation and progress of removing several projects at once (the project table's 「移除 N 個專案」). It names
// every project, says what goes (the project document: shots, prompts, library, take references, take reviews) and
// what stays (rendered videos and images, uploaded references, runs and recordings on the Controller and the nodes),
// then removes them one at a time through the per-project DELETE and reports each one. On the project list page it
// sits in a dialog; in the project manager (itself a dialog) it takes the place of the preview column, so there is
// never a second dialog level. Look: calm; each row turns into a check or a warning as its request lands.
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, LoaderCircle, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import type { StudioProjectSummary } from "@/api/generated/contracts";
import { isApiError } from "@/api/http";
import type { StorageCleanResult } from "@/api/generated/contracts";
import { cleanStorage, storageKeys } from "@/api/storage";
import { deleteProject, fetchProject, studioKeys } from "@/api/studioProjects";
import { Checkbox } from "@/components/ui/controls";
import { formatBytes } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";
import { cleanProjectMedia, mediaCleanupSummary, mergeScopes, projectMediaScope, removeSequentially, type MediaScope, type RemovalOutcome } from "./projectRemovalModel";
import { failureText as plainFailure } from "@/lib/errors";

type MediaOutcome = { ok: true; result: StorageCleanResult | null; unread: number } | { ok: false; error: unknown };

function mediaText(outcome: MediaOutcome): string {
  if (!outcome.ok) return t("影片與圖片沒有清除：{reason}", { reason: failureText(outcome.error) });
  const summary = outcome.result === null ? { deleted: 0, failed: 0, bytes: 0 } : mediaCleanupSummary(outcome.result);
  const unread = outcome.unread > 0 ? t("（{unread} 個專案讀不到內容，它們的媒體沒有清除）", { unread: outcome.unread }) : "";
  if (summary.deleted === 0 && summary.failed === 0) return t("沒有只屬於這些專案的影片與圖片需要清除；仍被其他專案使用的都保留。") + unread;
  if (summary.failed > 0) return t("已清除 {deleted} 項影片與圖片（{bytes}），{failed} 項沒有清除；仍被其他專案使用的都保留。", { deleted: summary.deleted, bytes: formatBytes(summary.bytes), failed: summary.failed }) + unread;
  return t("已清除 {deleted} 項只屬於這些專案的影片與圖片（{bytes}）；仍被其他專案使用的都保留。", { deleted: summary.deleted, bytes: formatBytes(summary.bytes) }) + unread;
}

export interface ProjectRemovalPanelProps {
  /** The projects to remove, in display order (never the open project). */
  items: readonly StudioProjectSummary[];
  /** "dialog": inside a DialogContent the caller owns; "inline": a column of an existing dialog. */
  layout: "dialog" | "inline";
  onClose: () => void;
  /** True while requests are in flight (the caller keeps the panel open meanwhile). */
  onRunningChange?: (running: boolean) => void;
  /**
   * Every project went (and the media cleanup, if asked, failed nowhere): the panel does not stay on a result screen
   * the person must dismiss; the caller closes it and shows `message` where the list is. Without it, the result stays.
   */
  onRemoved?: (message: string) => void;
}

function failureText(error: unknown): string {
  if (!isApiError(error)) return String(error);
  if (error.code === "REVISION_CONFLICT") return t("這個專案剛在別處被修改，沒有移除；確認內容後再試一次。");
  return plainFailure(error.code, error.message);
}

export function ProjectRemovalPanel({ items, layout, onClose, onRunningChange, onRemoved }: ProjectRemovalPanelProps) {
  const client = useQueryClient();
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, RemovalOutcome>>(() => new Map());
  const [phase, setPhase] = useState<"confirm" | "running" | "done">("confirm");
  const [purgeMedia, setPurgeMedia] = useState(false);
  const [media, setMedia] = useState<MediaOutcome | null>(null);
  const count = items.length;
  // One run per confirmation, however fast the button is clicked (each request is sent once and never retried)
  const startedRef = useRef(false);
  const run = async () => {
    if (startedRef.current) return;
    startedRef.current = true;
    setPhase("running");
    onRunningChange?.(true);
    // The media scope is read before each project goes: afterwards nothing says what it used
    const scopes = new Map<string, MediaScope>();
    if (purgeMedia) {
      for (const item of items) {
        try {
          scopes.set(item.project_id, projectMediaScope(item.project_id, await fetchProject(item.project_id)));
        } catch {
          // An unreadable project is still removed; only its media stays (reported below)
        }
      }
    }
    const removed = await removeSequentially(items, deleteProject, (outcome) => {
      setOutcomes((previous) => new Map(previous).set(outcome.item.project_id, outcome));
      if (outcome.status !== "failed") client.removeQueries({ queryKey: studioKeys.project(outcome.item.project_id) });
    });
    let mediaOutcome: MediaOutcome | null = null;
    if (purgeMedia) {
      const gone = removed.filter((outcome) => outcome.status === "removed").map((outcome) => outcome.item.project_id);
      const own = gone.flatMap((id) => { const scope = scopes.get(id); return scope ? [scope] : []; });
      try {
        const result = own.length > 0 ? await cleanProjectMedia(mergeScopes(own), cleanStorage) : null;
        mediaOutcome = { ok: true, result, unread: gone.length - own.length };
      } catch (error) {
        mediaOutcome = { ok: false, error };
      }
      setMedia(mediaOutcome);
      void client.invalidateQueries({ queryKey: storageKeys.all() });
      void client.invalidateQueries({ queryKey: ["runs"] });
    }
    await client.invalidateQueries({ queryKey: studioKeys.projects() });
    onRunningChange?.(false);
    const clean = removed.every((outcome) => outcome.status !== "failed") && (mediaOutcome === null || (mediaOutcome.ok && mediaOutcome.unread === 0 && (mediaOutcome.result === null || mediaCleanupSummary(mediaOutcome.result).failed === 0)));
    if (clean && onRemoved) {
      onRemoved(mediaOutcome === null ? t("已移除 {count} 個專案。", { count }) : `${t("已移除 {count} 個專案。", { count })}${mediaText(mediaOutcome)}`);
      return;
    }
    setPhase("done");
  };
  const failed = [...outcomes.values()].filter((outcome) => outcome.status === "failed").length;
  const done = outcomes.size;
  const dialog = layout === "dialog";
  const Title = dialog ? DialogTitle : "h3";
  const Description = dialog ? DialogDescription : "p";
  const Header = dialog ? DialogHeader : "div";
  const Body = dialog ? DialogBody : "div";
  const Footer = dialog ? DialogFooter : "div";
  return (
    <div role={dialog ? undefined : "region"} aria-label={dialog ? undefined : t("移除專案")} className={cn(dialog ? "contents" : "grid gap-3 rounded-xl border border-danger/30 bg-canvas/60 p-4 animate-fade-in")}>
      <Header className={dialog ? undefined : "grid gap-1"}>
        <Title className={cn("flex items-center gap-2", !dialog && "text-section font-semibold text-fg")}>
          <Trash2 aria-hidden className="size-4 shrink-0 text-danger" />
          {phase === "done" ? t("移除結果") : t("移除 {count} 個專案？", { count })}
        </Title>
        <Description className={dialog ? undefined : "text-data text-fg-secondary"}>
          {phase === "done"
            ? media === null
              ? t("已產生的影片與圖片、上傳的參考檔、run 與效能紀錄沒有清除，仍保留在主控與 Node。")
              : mediaText(media)
            : purgeMedia
              ? t("會刪除這些專案的專案文件：鏡頭、prompt、素材庫、take 參照與 take 審查，並清除只屬於這些專案的影片、圖片、上傳檔與 run，無法復原。仍被其他專案、run 或釘選項目使用的檔案會保留。")
              : t("會刪除這些專案的專案文件：鏡頭、prompt、素材庫、take 參照與 take 審查，無法復原。已產生的影片與圖片、上傳的參考檔、run 與效能紀錄不會清除，仍保留在主控與 Node。")}
        </Description>
      </Header>
      <Body className="grid gap-2">
        {phase === "confirm" ? (
          <Checkbox
            id="project-removal-purge-media"
            label={t("同時清除這些專案專屬的影片與圖片")}
            title={t("刪除專案後，再清除只有這些專案用到的渲染影片、圖片、上傳檔與 run（含 Node 上的檔案）。其他專案仍在用的不會動。")}
            checked={purgeMedia}
            onChange={(event) => { setPurgeMedia(event.target.checked); }}
          />
        ) : null}
        <p aria-live="polite" className="text-caption text-fg-tertiary">
          {phase === "confirm"
            ? t("將移除以下專案：")
            : phase === "running"
              ? t("正在移除 {done}/{count}…", { done, count })
              : failed === 0
                ? t("已移除 {count} 個專案。", { count })
                : t("已移除 {removed} 個，{failed} 個沒有移除。", { removed: done - failed, failed })}
        </p>
        <ul aria-label={t("要移除的專案")} className="grid max-h-72 gap-1 overflow-y-auto rounded-lg border border-line-subtle bg-sunken/40 p-1.5">
          {items.map((item) => {
            const outcome = outcomes.get(item.project_id);
            return (
              <li key={item.project_id} title={item.project_id} className="grid grid-cols-[1rem_minmax(0,1fr)] items-start gap-2 rounded-md px-2 py-1.5 text-data">
                <span aria-hidden className="mt-0.5 [&_svg]:size-4">
                  {outcome === undefined ? (
                    phase === "running" ? <LoaderCircle className="animate-spin text-fg-tertiary" /> : <Trash2 className="text-fg-tertiary" />
                  ) : outcome.status === "failed" ? (
                    <CircleAlert className="text-danger" />
                  ) : (
                    <CircleCheck className="text-success" />
                  )}
                </span>
                <span className="grid min-w-0 gap-0.5">
                  <span className="truncate text-fg">{item.title || t("未命名專案")}</span>
                  <span className="text-caption text-fg-tertiary">
                    {outcome === undefined
                      ? t("{shot_count} 個鏡頭・已渲染 {rendered_shot_count}", { shot_count: item.shot_count, rendered_shot_count: item.rendered_shot_count })
                      : outcome.status === "removed"
                        ? t("已移除")
                        : outcome.status === "gone"
                          ? t("已不存在（先前已移除）")
                          : <span className="text-danger">{failureText(outcome.error)}</span>}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      </Body>
      <Footer className={dialog ? undefined : "flex flex-wrap items-center justify-end gap-2"}>
        {phase === "done" ? (
          <Button variant="primary" size="sm" onClick={onClose}>
            {t("完成")}
          </Button>
        ) : (
          <>
            <Button size="sm" disabled={phase === "running"} onClick={onClose}>
              {t("取消")}
            </Button>
            <Button size="sm" variant="danger-confirm" icon={<Trash2 aria-hidden />} pending={phase === "running"} className={phase === "running" ? "opacity-60" : undefined} onClick={() => void run()}>
              {phase === "running" ? t("正在移除 {done}/{count}…", { done, count }) : t("移除 {count} 個專案", { count })}
            </Button>
          </>
        )}
      </Footer>
    </div>
  );
}
