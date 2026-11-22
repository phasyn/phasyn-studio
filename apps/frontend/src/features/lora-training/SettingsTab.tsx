// 設定分頁：這個工作用的影片與用途、訓練參數（rank、學習率、步數…）與各階段用的元件；只讀。
import type { LoraTraining } from "@/api/generated/contracts";
import { CARD, PANEL_TITLE } from "@/components/ui/look";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";
import { cn } from "@/lib/cn";
import { isRecord } from "@/lib/json";
import { ROLE_LABEL, sources, trainingView } from "./model";

const PLACEMENT_LABEL: Record<string, string> = {
  clips: t("切片段"),
  review: t("自動反推"),
  conditioning: t("文字與參考條件"),
  video_encode: t("參考圖編碼"),
  audio_encode: t("靜音參考編碼"),
  train: t("訓練"),
  register: t("登錄 LoRA"),
};

const PARAM_LABEL: Record<string, string> = {
  steps: t("總步數"),
  rank: t("rank"),
  alpha: t("alpha"),
  learning_rate: t("學習率"),
  warmup_steps: t("暖身步數"),
  window_latent_frames: t("每步的 latent 幀數"),
  timestep_bins: t("時間步格點"),
  sigma_min: t("最小 sigma"),
  checkpoint_seconds: t("存檔間隔（秒）"),
  chunk_steps: t("每段步數"),
  seed: t("seed"),
};

function componentNames(key: unknown): string {
  if (!Array.isArray(key)) return "";
  const list: unknown[] = key;
  const pairs: unknown[] = Array.isArray(list[0]) ? list : [list];
  return formatList(pairs.map((pair) => (Array.isArray(pair) ? String(pair[1]) : "")));
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[minmax(8rem,14rem)_minmax(0,1fr)] gap-3 border-b border-line-subtle py-1.5 last:border-b-0">
      <dt className="text-data text-fg-tertiary">{label}</dt>
      <dd className="machine min-w-0 break-words text-data text-fg">{value}</dd>
    </div>
  );
}

export function SettingsTab({ job }: { job: LoraTraining }) {
  const view = trainingView(job);
  const placement = isRecord(job.placement) ? job.placement : {};
  return (
    <div className="mx-auto grid w-full max-w-4xl gap-4">
      <section className={cn(CARD, "grid gap-2 p-4")}>
        <h2 className={PANEL_TITLE}>{t("影片")}</h2>
        <dl>{sources(job).map((s) => <Row key={s.source_id} label={ROLE_LABEL[s.role]} value={s.label} />)}</dl>
      </section>
      <section className={cn(CARD, "grid gap-2 p-4")}>
        <h2 className={PANEL_TITLE}>{t("訓練參數")}</h2>
        {view === null ? (
          <p className="text-data text-fg-secondary">{t("挑好訓練資料後決定（步數依片段數量調整）。")}</p>
        ) : (
          <dl>{Object.entries(view.parameters).filter(([k]) => k in PARAM_LABEL).map(([k, v]) => <Row key={k} label={PARAM_LABEL[k] ?? k} value={String(v)} />)}</dl>
        )}
      </section>
      <section className={cn(CARD, "grid gap-2 p-4")}>
        <h2 className={PANEL_TITLE}>{t("使用的元件")}</h2>
        <dl>
          {Object.entries(placement).map(([phase, key]) => (
            <Row key={phase} label={PLACEMENT_LABEL[phase] ?? phase} value={componentNames(key)} />
          ))}
        </dl>
      </section>
    </div>
  );
}
