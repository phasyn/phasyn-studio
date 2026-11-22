// 訓練工作清單：每個工作一張卡（名稱、方向、狀態、階段與進度條）；右上「新增訓練」。沒有工作時是品牌空狀態。
import { Plus } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import type { LoraTrainingSummary } from "@/api/generated/contracts";
import { trainingPath } from "@/app/paths";
import { EmptyState } from "@/components/common/EmptyState";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { Button } from "@/components/ui/button";
import { LIFT, METER_FILL, METER_TRACK, PANEL_TITLE } from "@/components/ui/look";
import { reveal } from "@/components/ui/motion";
import { DockBody } from "@/components/workbench/DockPanel";
import { StatusChip } from "@/components/workbench/StatusChip";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { formatTimestamp } from "@/lib/format";
import { useTrainingList } from "./api";
import { CreateTrainingDialog } from "./CreateTrainingDialog";
import { PHASE_LABEL, STATUS_SPEC, summaryProgress } from "./model";

function TrainingCard({ item, index }: { item: LoraTrainingSummary; index: number }) {
  const status = STATUS_SPEC[item.status];
  const progress = summaryProgress(item);
  return (
    <li ref={reveal(index)}>
      <Link
        to={trainingPath(item.training_id)}
        className={cn("pressable grid gap-2 rounded-xl border border-line-subtle bg-canvas/60 p-4 no-underline outline-none hover:border-line-strong focus-visible:ring-2 focus-visible:ring-focus", LIFT)}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-body font-semibold text-fg" title={item.name}>
            {item.name}
          </span>
          <StatusChip tone={status.tone} label={status.label} spinning={status.spinning} />
        </span>
        <span className="line-clamp-2 text-data text-fg-secondary" title={item.direction}>
          {item.direction}
        </span>
        <span className="flex items-center gap-2 text-caption text-fg-tertiary">
          <span className="truncate">{PHASE_LABEL[item.phase]}</span>
          <span aria-hidden>·</span>
          <span className="truncate">{formatTimestamp(item.updated_at)}</span>
        </span>
        {progress !== null ? (
          <span className={METER_TRACK} role="progressbar" aria-label={t("進度")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
            <span className={METER_FILL} style={{ width: `${String(Math.round(progress * 100))}%` }} />
          </span>
        ) : null}
      </Link>
    </li>
  );
}

export function TrainingList() {
  const list = useTrainingList();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const items = list.data ?? [];
  const create = (
    <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => { setCreating(true); }}>
      {t("新增訓練")}
    </Button>
  );
  return (
    <DockBody className="p-4 sm:p-6">
      <div className="mx-auto grid w-full max-w-6xl gap-5">
        <header className="flex flex-wrap items-center gap-3">
          <div className="grid min-w-0 flex-1 gap-1">
            <h1 className={cn(PANEL_TITLE, "text-title")}>{t("LoRA 訓練")}</h1>
            <p className="text-data text-fg-secondary">{t("丟進影片、寫下方向，接下來的切片、反推、訓練與強度比較都會自動完成。")}</p>
          </div>
          {items.length > 0 ? create : null}
        </header>
        {list.isError ? (
          <ErrorCallout error={list.error} title={t("無法讀取訓練工作")} onRetry={() => void list.refetch()} retrying={list.isFetching} />
        ) : list.isPending ? (
          <p role="status" className="text-data text-fg-secondary">{t("讀取中…")}</p>
        ) : items.length === 0 ? (
          <EmptyState
            scene
            illustration="drop"
            title={t("還沒有訓練工作")}
            description={t("例如丟進幾支動漫戰鬥剪輯，方向寫「動漫戰鬥的運鏡與打擊感」，完成後會看到同一個 Prompt 在不同 LoRA 強度下的差異。")}
            action={create}
          />
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-3" aria-label={t("訓練工作")}>
            {items.map((item, index) => (
              <TrainingCard key={item.training_id} item={item} index={index} />
            ))}
          </ul>
        )}
      </div>
      <CreateTrainingDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id) => {
          setCreating(false);
          void navigate(trainingPath(id));
        }}
      />
    </DockBody>
  );
}
