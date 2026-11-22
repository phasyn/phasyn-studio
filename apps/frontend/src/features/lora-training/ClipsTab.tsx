// 資料分頁：切出來的每一段（三格縮圖表＋caption＋來源與用途）；可以依「訓練／留出／排除」篩選。
// 工作在等你檢查資料時，可以移除或恢復片段、直接改 caption（離開欄位就保存，一次請求）。
import { useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { LoraTraining } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { SegmentedTabs } from "@/components/flow/SegmentedTabs";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/controls";
import { reveal } from "@/components/ui/motion";
import { StatusChip } from "@/components/workbench/StatusChip";
import { t } from "@/i18n";
import { editClips, trainingKeys } from "./api";
import { clipRows, MASK_LABEL, rejectLabel, ROLE_LABEL, sources, type ClipRow } from "./model";

type Filter = ClipRow["status"];
const PAGE = 48;

function ClipCard({ clip, sourceLabel, editable, index, onEdit }: {
  clip: ClipRow;
  sourceLabel: string;
  editable: boolean;
  index: number;
  onEdit: (change: { drop?: boolean; caption?: string }) => Promise<void>;
}) {
  const [draft, setDraft] = useState(clip.caption ?? "");
  const [busy, setBusy] = useState(false);
  const save = async (change: { drop?: boolean; caption?: string }) => {
    setBusy(true);
    try {
      await onEdit(change);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li ref={reveal(index)} className="grid gap-2 rounded-xl border border-line-subtle bg-canvas/60 p-2.5">
      {clip.sheet ? (
        <img src={mediaUrl(clip.sheet.node_id, clip.sheet.file_id)} alt={t("片段 {id} 的開頭、中間與結尾", { id: clip.clip_id })} loading="lazy" width={1344} height={258} className="h-auto w-full rounded-md bg-stage" />
      ) : (
        <div className="grid aspect-[1344/258] place-items-center rounded-md bg-stage text-caption text-fg-tertiary">{t("沒有縮圖")}</div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-caption text-fg-tertiary">
        <span className="min-w-0 truncate" title={sourceLabel}>{sourceLabel}</span>
        <span aria-hidden>·</span>
        <span>{ROLE_LABEL[clip.role]}</span>
        {clip.start_seconds !== null ? <span className="machine">{`${clip.start_seconds.toFixed(1)} s`}</span> : null}
        {clip.status === "rejected" ? <StatusChip tone="neutral" label={rejectLabel(clip.reason)} /> : null}
        {clip.status !== "rejected"
          ? clip.masks.map((m) => {
              const label = MASK_LABEL[m];
              return label === undefined ? null : <StatusChip key={m} tone="neutral" label={label} />;
            })
          : null}
      </div>
      {editable && clip.status === "train" ? (
        <Textarea compact className="min-h-24" value={draft} aria-label={t("片段 {id} 的 caption", { id: clip.clip_id })} onChange={(e) => { setDraft(e.target.value); }}
          onBlur={() => { if (draft.trim() !== (clip.caption ?? "").trim() && draft.trim() !== "") void save({ caption: draft.trim() }); }} />
      ) : (
        <p className="text-data text-fg-secondary">{clip.caption ?? t("（沒有 caption）")}</p>
      )}
      {editable ? (
        clip.status === "train" ? (
          <Button size="sm" variant="quiet" icon={<Trash2 aria-hidden />} pending={busy} onClick={() => void save({ drop: true })}>{t("不要訓練這段")}</Button>
        ) : clip.reason === "dropped_by_user" ? (
          <Button size="sm" variant="quiet" icon={<RotateCcw aria-hidden />} pending={busy} onClick={() => void save({ drop: false })}>{t("恢復這段")}</Button>
        ) : null
      ) : null}
    </li>
  );
}

export function ClipsTab({ job }: { job: LoraTraining }) {
  const client = useQueryClient();
  const rows = useMemo(() => clipRows(job), [job]);
  const labels = useMemo(() => new Map(sources(job).map((s) => [s.source_id, s.label])), [job]);
  const [filter, setFilter] = useState<Filter>("train");
  const [shown, setShown] = useState(PAGE);
  const [error, setError] = useState<unknown>(null);
  const editable = job.status === "review" && job.phase === "select";
  const counts = { train: 0, heldout: 0, rejected: 0 };
  for (const r of rows) counts[r.status] += 1;
  const visible = rows.filter((r) => r.status === filter);
  const edit = (clip: ClipRow) => async (change: { drop?: boolean; caption?: string }) => {
    setError(null);
    try {
      const body = change.caption !== undefined ? { captions: { [clip.clip_id]: change.caption } } : change.drop === true ? { drop: [clip.clip_id] } : { restore: [clip.clip_id] };
      client.setQueryData(trainingKeys.one(job.training_id), await editClips(job.training_id, body));
    } catch (cause) {
      setError(cause);
    }
  };
  if (rows.length === 0) return <p className="text-data text-fg-secondary">{t("片段切好、反推完成後會列在這裡。")}</p>;
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedTabs
          idPrefix={`clips-${job.training_id}`}
          label={t("片段篩選")}
          value={filter}
          onChange={(id) => { setFilter(id === "heldout" || id === "rejected" ? id : "train"); setShown(PAGE); }}
          tabs={[
            { id: "train", label: t("訓練"), count: counts.train },
            { id: "heldout", label: t("留出"), count: counts.heldout },
            { id: "rejected", label: t("排除"), count: counts.rejected },
          ]}
        />
        {editable ? <p className="text-caption text-fg-secondary">{t("檢查完按上方「開始訓練」。改 caption 時只描述鏡頭、運鏡與動作，不寫角色名或作品名。")}</p> : null}
      </div>
      {error !== null ? <ErrorCallout error={error} write title={t("修改沒有保存")} /> : null}
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(20rem,1fr))] gap-3" aria-label={t("片段")}>
        {visible.slice(0, shown).map((clip, i) => (
          <ClipCard key={`${clip.clip_id}:${clip.caption ?? ""}:${clip.status}`} clip={clip} index={i} sourceLabel={labels.get(clip.source_id) ?? clip.source_id} editable={editable} onEdit={edit(clip)} />
        ))}
      </ul>
      {visible.length > shown ? (
        <Button className="justify-self-center" onClick={() => { setShown((n) => n + PAGE); }}>{t("再顯示 {count} 段", { count: Math.min(PAGE, visible.length - shown) })}</Button>
      ) : null}
    </div>
  );
}
