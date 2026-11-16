// 換參考檔案 (the shot list's multi-selection, SelectionBar): every @ name the selected shots use, grouped by alias and kind
// (BatchReplaceGroup), each with a file of the same kind to choose from the project library or to upload. 套用 writes every
// chosen file into every selected shot that has that @ name with that kind, by the rule of one shot's 「換成其他檔案」
// (references/batchReplace.ts → replacedReference); shots without the name, or with it as another kind, stay as they
// are. It is one document edit (one updateShot per changed shot, in one event), which the autosave sends once. Shot
// settings are not in the edit history (it holds the timeline only), so the notice afterwards (ReplaceNotice, given the
// references before and after through onApplied) offers 復原 instead. Each card says how many shots its choice changes,
// the footer how many in all, the notice afterwards what changed. 取消, Esc and the close button change nothing; a click
// outside does not close it while a file is chosen or uploading. Uploads go to the library only (this opening's own
// queue); each is chosen for its @ name when it lands unless another file was chosen for that name meanwhile, and 套用
// waits for them.
// Mounted once per opening (ShotList keys it) and kept through its exit animation: after 套用 it goes on showing the shots
// as they were while it fades, so nothing in it changes on the way out.
// Keyboard: the first @ name's choices have the focus; the arrow keys choose within a name and Tab goes on to the next;
// Ctrl/⌘+Enter applies; Esc cancels. Motion: the shared dialog entrance and exit; the cards and their tiles rise in one
// after another; the footer's status fades when it changes; tiles and buttons press.
import { Replace } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { StudioShot } from "@/api/generated/contracts";
import { ActionButton } from "@/components/common/ActionButton";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useChangeFade } from "@/components/ui/motion";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";
import { cn } from "@/lib/cn";
import { detectApplePlatform, modifierLabel } from "@/lib/keyboard";
import { aliasGroups, replacementPlan, usablePicks, type AliasGroup } from "../../references/batchReplace";
import { videoLibrary } from "../../references/materials";
import { ReferenceUploadRow } from "../../references/UploadRow";
import { useStudio } from "../../studioContext";
import { BatchReplaceGroup } from "./BatchReplaceGroup";
import type { AppliedReplace } from "./ReplaceNotice";
import { useLibraryUploads } from "./useLibraryUploads";

export interface BatchReplaceDialogProps {
  /** The selected shots it was opened for (list order); read from the project on every render. */
  shotIds: readonly string[];
  open: boolean;
  onClose: () => void;
  /** After 套用: what changed (the notice with 復原). */
  onApplied: (applied: Omit<AppliedReplace, "id">) => void;
}

const NONE: ReadonlyMap<string, string> = new Map();

export function BatchReplaceDialog({ shotIds, open, onClose, onApplied }: BatchReplaceDialogProps) {
  const { project, dispatch } = useStudio();
  const content = useRef<HTMLDivElement>(null);
  const turns = useRef(new Map<string, number>());
  const uploads = useLibraryUploads();
  /** The chosen file of each @ name (group key → library item id); a name without one stays as it is. */
  const [picks, setPicks] = useState<ReadonlyMap<string, string>>(NONE);
  /** The shots as they were when 套用 was pressed (shown while the dialog fades out). */
  const [applied, setApplied] = useState<readonly StudioShot[] | null>(null);
  const items = useMemo(() => new Map((project.library ?? []).map((item) => [item.item_id, item])), [project.library]);
  const durations = useMemo(() => new Map((project.library ?? []).map((item) => [item.item_id, item.duration_seconds ?? null])), [project.library]);
  // Newest first, as in the library: a file just uploaded comes first (videoLibrary answers a new array)
  const newest = useMemo(() => videoLibrary(project.library ?? []).sort((a, b) => b.created_at.localeCompare(a.created_at)), [project.library]);
  const live = useMemo(() => {
    const byId = new Map(project.shots.map((shot) => [shot.shot_id, shot]));
    return shotIds.flatMap((shotId) => byId.get(shotId) ?? []);
  }, [project.shots, shotIds]);
  const shots = applied ?? live;
  const groups = useMemo(() => aliasGroups(shots), [shots]);
  const usable = useMemo(() => usablePicks(groups, project.library ?? [], picks), [groups, project.library, picks]);
  const plan = useMemo(() => replacementPlan(shots, usable, durations), [shots, usable, durations]);
  const uploading = uploads.tasks.some((task) => task.state === "waiting" || task.state === "reading" || task.state === "uploading");
  const count = plan.shots.length;

  const blockedReason = uploading
    ? t("等上傳完成再套用")
    : count > 0
      ? null
      : usable.size === 0
        ? t("為要換的 @ 名稱各選一個新檔案")
        : t("選的檔案這些鏡頭都已經在用，沒有要換的");
  const aliases = groups.flatMap((group) => ((plan.changed.get(group.key) ?? 0) > 0 ? [`@${group.alias}`] : []));
  const status = uploading ? t("上傳完成後會自動選取新檔案") : (blockedReason ?? t("套用後會改 {count} 個鏡頭的 {aliases}", { count, aliases: formatList(aliases) }));
  const statusRef = useChangeFade<HTMLParagraphElement>(status);
  const shortcut = t("{key}+Enter 套用・Esc 取消", { key: modifierLabel("Mod", detectApplePlatform()) });

  // Every choice for a name (a click, an upload started) takes a turn: an upload is chosen when it lands only while it
  // still has the name's last turn, so a file clicked meanwhile, or a later upload, is not overridden
  const nextTurn = (key: string) => (turns.current.get(key) ?? 0) + 1;
  const choose = (key: string, itemId: string | null) => {
    turns.current.set(key, nextTurn(key));
    setPicks((current) => {
      const next = new Map(current);
      if (itemId === null) next.delete(key);
      else next.set(key, itemId);
      return next;
    });
  };
  const upload = (group: AliasGroup, file: File) => {
    const mine = nextTurn(group.key);
    const accepted = uploads.addAndPick(file, group.kind, group.key, (item) => {
      if (turns.current.get(group.key) !== mine) return t("已加入專案素材庫");
      choose(group.key, item.item_id);
      return t("已加入素材庫，選為 @{alias} 的新檔案", { alias: group.alias });
    });
    // A file of another kind is refused before it uploads: no upload started, so it takes no turn
    if (accepted) turns.current.set(group.key, mine);
  };
  const apply = () => {
    if (blockedReason !== null || applied !== null) return;
    for (const change of plan.shots) dispatch({ type: "updateShot", shotId: change.shotId, patch: { references: change.references } });
    const lines = groups.flatMap((group) => {
      const changed = plan.changed.get(group.key) ?? 0;
      const itemId = usable.get(group.key);
      return changed > 0 && itemId !== undefined ? [t("@{alias} 換成「{name}」（{count} 個鏡頭）", { alias: group.alias, name: items.get(itemId)?.name ?? itemId, count: changed })] : [];
    });
    onApplied({ title: t("已換掉 {count} 個鏡頭的參考檔案", { count }), lines, shots: plan.shots });
    setApplied(live);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        ref={content}
        wide
        onOpenAutoFocus={(event) => {
          // The first @ name's choice (不換 at first), so the arrow keys choose right away
          const first = content.current?.querySelector<HTMLInputElement>('input[type="radio"]:checked');
          if (!first) return;
          event.preventDefault();
          first.focus();
        }}
        onInteractOutside={(event) => {
          if (usable.size > 0 || uploading) event.preventDefault();
        }}
        onKeyDown={(event) => {
          // The keys stay in the dialog: the shot list and the editor have their own
          event.stopPropagation();
          if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || event.nativeEvent.isComposing) return;
          event.preventDefault();
          apply();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Replace aria-hidden className="size-4 text-brand-cyan" />
            {t("換參考檔案")}
            <span className="text-data font-normal text-fg-tertiary">{t("{count} 個鏡頭", { count: shots.length })}</span>
          </DialogTitle>
          <DialogDescription>
            {t("為要換的 @ 名稱各選一個新檔案，選取的鏡頭裡用這個名稱的參考會一起換掉。@ 名稱、送出順序與 prompt 不變；影片與聲音的片段在新檔案放得下時保留（例如換成去掉字幕的同一部影片），放不下的回到整個檔案。已渲染的鏡頭要重新渲染才會用到新檔案。")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid content-start gap-3">
          {groups.length === 0 ? (
            <EmptyState size="compact" icon={<Replace />} title={t("選取的鏡頭都沒有參考素材")} />
          ) : (
            groups.map((group, index) => {
              const tasks = uploads.tasks.filter((task) => task.info.target === group.key);
              return (
                <BatchReplaceGroup
                  key={group.key}
                  group={group}
                  index={index}
                  choices={newest.filter((item) => item.kind === group.kind)}
                  items={items}
                  pick={usable.get(group.key) ?? null}
                  changed={plan.changed.get(group.key) ?? 0}
                  unclipped={plan.unclipped.get(group.key) ?? 0}
                  onPick={(itemId) => choose(group.key, itemId)}
                  onUpload={(file) => upload(group, file)}
                >
                  {tasks.length > 0 ? (
                    <ul className="grid gap-0.5" aria-label={t("上傳")}>
                      {tasks.map((task) => (
                        <ReferenceUploadRow key={task.key} task={task} onRetry={() => uploads.retry(task.key)} onDismiss={() => uploads.dismiss(task.key)} />
                      ))}
                    </ul>
                  ) : null}
                </BatchReplaceGroup>
              );
            })
          )}
        </DialogBody>
        <DialogFooter className="flex-nowrap">
          <p ref={statusRef} role="status" aria-live="polite" className={cn("mr-auto min-w-0 flex-1 text-caption [overflow-wrap:anywhere]", count > 0 && !uploading ? "text-fg" : "text-fg-tertiary")}>
            {status}
          </p>
          <span className="shrink-0 text-caption whitespace-nowrap text-fg-tertiary">{shortcut}</span>
          <DialogClose asChild>
            <Button>{t("取消")}</Button>
          </DialogClose>
          <ActionButton variant="primary" icon={<Replace aria-hidden />} disabledReason={blockedReason} aria-keyshortcuts="Control+Enter Meta+Enter" onClick={apply}>
            {count > 0 ? t("套用到 {count} 個鏡頭", { count }) : t("套用")}
          </ActionButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
