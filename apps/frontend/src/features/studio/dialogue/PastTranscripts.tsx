// 「從過去結果選」: the finished transcriptions of this project, each shown with the clips on the sequence that play the
// media it heard (「鏡頭名・時間碼」) and when it ran. Applying one turns it into those clips' captions, keeping manual
// edits, exactly like a fresh transcription.
import { History } from "lucide-react";
import { useEffect, useState } from "react";
import { useProjectRunList } from "@/api/runs";
import { asTypedValue, asTypedValueMap, type WireRun } from "@/api/types";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { reveal } from "@/components/ui/motion";
import { t } from "@/i18n";
import { formatDateTime } from "@/i18n/format";
import { errorText } from "@/lib/errors";
import { useEditor } from "../editor/editorContext";
import { audibleSource, clipLabel } from "./clipLabel";
import { TRANSCRIPT_TYPE } from "./dialogueRoutes";

interface Past {
  run: WireRun;
  outputKey: string;
  clipIds: string[];
}

function List() {
  const editor = useEditor();
  const { project, timeline, fps } = editor;
  const list = useProjectRunList(project.project_id);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const bySha = new Map<string, string[]>();
  for (const clip of timeline.clips) {
    const sha = audibleSource(timeline, clip)?.file?.sha256;
    if (sha !== undefined) bySha.set(sha, [...(bySha.get(sha) ?? []), clip.clip_id]);
  }
  const selected = editor.selectedClip?.clip_id;
  const items: Past[] = list.runs.flatMap((run) => {
    if (run.state !== "succeeded") return [];
    const outputKey = Object.entries(run.outputs).find(([, value]) => asTypedValue(value)?.type_id === TRANSCRIPT_TYPE)?.[0];
    if (outputKey === undefined) return [];
    const heard = Object.values(asTypedValueMap(run.request.inputs)).flatMap((value) => ("file" in value ? [value.file.sha256] : []));
    const clipIds = heard.flatMap((sha) => bySha.get(sha) ?? []);
    return clipIds.length > 0 ? [{ run, outputKey, clipIds }] : [];
  });
  // The selected clip's transcriptions come first
  items.sort((a, b) => Number(b.clipIds.includes(selected ?? "")) - Number(a.clipIds.includes(selected ?? "")));

  // Older pages are read on their own while none of the newest runs fits (a project's runs are mostly renders)
  const pages = list.data?.pages.length ?? 0;
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  const empty = items.length === 0;
  useEffect(() => {
    if (empty && hasNextPage && !isFetchingNextPage && pages < 8) void fetchNextPage();
  }, [empty, hasNextPage, isFetchingNextPage, pages, fetchNextPage]);

  const apply = async (item: Past) => {
    if (busy !== null) return;
    setBusy(item.run.run_id);
    setStatus(null);
    try {
      await editor.runTimelineCommands(item.clipIds.map((clipId) => ({ op: "caption", action: "import_transcript", clip_id: clipId, run_id: item.run.run_id, output_key: item.outputKey })));
      setStatus({ tone: "success", text: t("已套用到字幕，手動修改過的字幕都保留。") });
    } catch (cause) {
      setStatus({ tone: "danger", text: errorText(cause) });
    } finally {
      setBusy(null);
    }
  };

  if (list.isPending || (empty && isFetchingNextPage)) return <p role="status" className="text-data text-fg-secondary">{t("正在讀取這個專案的辨識結果…")}</p>;
  return (
    <div className="grid gap-3">
      {items.length === 0 ? (
        <EmptyState size="compact" icon={<History />} title={t("還沒有可用的辨識結果")} description={t("這個專案還沒有辨識過時間軸上片段的台詞。")} />
      ) : (
        <ul className="grid max-h-[50vh] gap-1.5 overflow-y-auto">
          {items.map((item, index) => {
            const names = item.clipIds.flatMap((clipId) => {
              const clip = timeline.clips.find((entry) => entry.clip_id === clipId);
              return clip ? [clipLabel(project, timeline, clip, fps)] : [];
            });
            return (
              <li key={item.run.run_id} ref={reveal(index)} className="flex min-h-12 items-center gap-3 rounded-md border border-line-subtle px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-data text-fg" title={names.join(t("、"))}>{names.join(t("、"))}</p>
                  <p className="text-caption text-fg-tertiary">{t("辨識於 {time}", { time: formatDateTime(item.run.finished_at ?? item.run.created_at) })}</p>
                </div>
                <Button size="sm" variant="secondary" pending={busy === item.run.run_id} disabled={busy !== null && busy !== item.run.run_id} onClick={() => { void apply(item); }}>
                  {t("套用到字幕")}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {list.hasNextPage ? (
        <Button size="sm" variant="quiet" className="justify-self-start" pending={list.isFetchingNextPage} onClick={() => { void list.fetchNextPage(); }}>{t("載入更早的結果")}</Button>
      ) : null}
      {list.error ? <p role="alert" className="text-data text-danger">{errorText(list.error)}</p> : null}
      {status ? <p role="status" className={status.tone === "success" ? "text-data text-success" : "text-data text-danger"}>{status.text}</p> : null}
    </div>
  );
}

export function PastTranscripts({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" onKeyDown={(event) => { event.stopPropagation(); }}>
        <DialogHeader>
          <DialogTitle>{t("從過去結果選")}</DialogTitle>
          <DialogDescription>{t("這個專案先前辨識出的台詞；套用後成為對應片段的字幕。")}</DialogDescription>
        </DialogHeader>
        <DialogBody>{open ? <List /> : null}</DialogBody>
      </DialogContent>
    </Dialog>
  );
}
