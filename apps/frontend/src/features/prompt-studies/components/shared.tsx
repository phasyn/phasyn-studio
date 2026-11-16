// 圖片反推頁共用的小元件：階段狀態、任務狀態、判斷與誤差、圖片（載入失敗時說明原因）、元件選擇。
import { ImageOff } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { FileRef } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/controls";
import { StatusChip } from "@/components/workbench/StatusChip";
import { componentPath } from "@/app/paths";
import { cn } from "@/lib/cn";
import { formatLoss, metricLabelText, metricTone } from "../model/loss";
import type { ComponentChoice } from "../model/components";
import type { CompareStatus } from "../model/rows";
import { STOP_TEXT } from "../model/study";
import type { MetricLabel, PromptStudyTask, RenderRef } from "../types";
import { stepErrorText } from "../model/stepError";
import { t } from "@/i18n";

const RENDER_STATE: Record<RenderRef["state"], { tone: "success" | "info" | "danger" | "neutral" | "warning"; text: string }> = {
  succeeded: { tone: "success", text: t("完成") },
  unknown: { tone: "info", text: t("已送出") },
  failed: { tone: "danger", text: t("失敗") },
  cancelled: { tone: "neutral", text: t("已取消") },
  interrupted: { tone: "warning", text: t("已中斷") },
};

/** 生成的狀態（失敗、取消、中斷也計入預算）。 */
export function RenderChip({ render }: { render: RenderRef }) {
  const state = RENDER_STATE[render.state];
  const title = render.error ? t("{code}：{message}{value}", { code: render.error.code, message: stepErrorText(render.error), value: render.error.remote_outcome_unknown ? t("（遠端結果未知）") : "" }) : render.state === "unknown" ? t("run 已建立；結果讀回後才會更新") : undefined;
  return <StatusChip tone={state.tone} spinning={render.state === "unknown"} label={t("生成：{text}", { text: state.text })} title={title} />;
}

const COMPARE_STATE: Record<CompareStatus, { tone: "success" | "info" | "danger" | "neutral"; text: string } | null> = {
  done: { tone: "success", text: t("完成") },
  running: { tone: "info", text: t("已送出") },
  failed: { tone: "danger", text: t("失敗") },
  queued: { tone: "neutral", text: t("等待") },
  skipped: { tone: "neutral", text: t("沒有比較") },
  none: null,
};

/** 與原圖比較＋評分（同一個 run）的狀態；生成沒有成功時不顯示。 */
export function CompareChip({ status, title }: { status: CompareStatus; title?: string }) {
  const state = COMPARE_STATE[status];
  if (!state) return null;
  return <StatusChip tone={state.tone} spinning={status === "running"} label={t("比較：{text}", { text: state.text })} title={title} />;
}

export function TaskStateChip({ task }: { task: PromptStudyTask | null }) {
  if (!task) return <StatusChip tone="neutral" label={t("尚未執行")} />;
  if (task.state === "running") {
    return task.error ? (
      <StatusChip tone="warning" label={t("已暫停（上一步失敗）")} title={t("{code}：{message}{value}", { code: task.error.code, message: stepErrorText(task.error), value: task.error.remote_outcome_unknown ? t("（遠端結果未知）") : "" })} />
    ) : (
      <StatusChip tone="info" label={t("進行中")} />
    );
  }
  if (task.state === "succeeded") return <StatusChip tone="success" label={task.stop_reason && task.stop_reason !== "completed" ? t("完成（{stop_reason}）", { stop_reason: STOP_TEXT[task.stop_reason] }) : t("完成")} />;
  if (task.state === "failed") return <StatusChip tone="danger" label={task.stop_reason ? t("失敗（{stop_reason}）", { stop_reason: STOP_TEXT[task.stop_reason] }) : t("失敗")} />;
  if (task.state === "interrupted") return <StatusChip tone="warning" label={t("已中斷")} />;
  return <StatusChip tone="neutral" label={task.stop_reason === "user_cancel" ? t("已結束（使用者）") : t("已結束")} />;
}

export function MetricChip({ label, className }: { label: MetricLabel; className?: string }) {
  return (
    <Badge tone={metricTone(label)} className={className}>
      {metricLabelText(label)}
    </Badge>
  );
}

/** 誤差：三位小數＋「不可判斷」；誤差是機器評審的差異量，不是相似百分比。 */
export function LossText({ loss, unverified, className }: { loss: number | null; unverified: boolean | null; className?: string }) {
  if (unverified === null) return <span className={cn("text-fg-tertiary", className)}>{t("未評分")}</span>;
  return <span className={cn("machine", unverified ? "text-warning" : "text-fg", className)}>{formatLoss(unverified ? null : loss)}</span>;
}

/** Node 檔案圖片；讀完才淡入，載入失敗時說明可能原因，不留破圖。 */
export function StudyImage({ file, alt, className, onSize, fit = "contain" }: { file: FileRef | null; alt: string; className?: string; onSize?: (width: number, height: number) => void; fit?: "contain" | "cover" }) {
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const key = file ? `${file.node_id}/${file.file_id}` : null;
  if (!file || failedKey === key) {
    return (
      <div className={cn("grid place-items-center gap-1 rounded-lg border border-line-subtle bg-sunken p-3 text-center text-caption text-fg-tertiary", className)} role="img" aria-label={t("{alt}：無法顯示", { alt })}>
        <ImageOff aria-hidden className="size-4" />
        <span>{file ? t("無法載入圖片（檔案不存在或 Node 離線）") : t("沒有圖片")}</span>
      </div>
    );
  }
  return (
    <img
      src={mediaUrl(file.node_id, file.file_id)}
      alt={alt}
      loading="lazy"
      draggable={false}
      onError={() => setFailedKey(key)}
      onLoad={(event) => {
        setLoadedKey(key);
        onSize?.(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight);
      }}
      data-loaded={loadedKey === key || undefined}
      className={cn(
        "rounded-lg border border-line-subtle bg-sunken opacity-0 transition-opacity duration-(--duration-base) ease-standard data-[loaded]:opacity-100",
        fit === "contain" ? "object-contain" : "object-cover",
        className,
      )}
    />
  );
}

/** 元件 instance 選擇（依 provider_id，任何 Node）；未就緒時說明原因並連到元件頁。 */
export function ComponentSelect({
  id,
  label,
  providerId,
  choices,
  value,
  onChange,
  disabled,
  loading = false,
}: {
  id: string;
  label: string;
  providerId: string;
  choices: readonly ComponentChoice[];
  value: ComponentChoice | null;
  onChange: (key: string) => void;
  disabled?: boolean;
  /** 元件目錄還在讀取。 */
  loading?: boolean;
}) {
  return (
    <div className="grid min-w-0 gap-1">
      <label htmlFor={id} className="text-caption text-fg-secondary">
        {label}
      </label>
      {choices.length === 0 && loading ? (
        <p id={id} role="status" className="text-caption text-fg-secondary">
          {t("讀取元件目錄…")}
        </p>
      ) : choices.length === 0 ? (
        <p id={id} className="text-caption text-warning">
          {t("目錄中沒有 {providerId} 元件：到「元件修改」建立 instance。", { providerId })}
        </p>
      ) : (
        <>
          <Select id={id} compact value={value?.key ?? ""} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
            {choices.map((choice) => (
              <option key={choice.key} value={choice.key}>
                {`${choice.place} / ${choice.descriptor.component_id}${choice.usable ? "" : t("（未就緒）")}`}
              </option>
            ))}
          </Select>
          {value && !value.usable ? (
            <p className="text-caption text-warning">
              {value.reason}{" "}
              <Link to={componentPath(value.descriptor.node_id, value.descriptor.component_id)} className="text-caption">
                {t("開啟元件")}
              </Link>
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/** 區塊標題（中欄）。 */
export function SectionTitle({ id, children, actions }: { id: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 id={id} className="text-section font-semibold text-fg">
        {children}
      </h2>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
