// 「生成圖片」：工具列右側、「生成引擎」左邊的主動作（與 Video Studio 的「渲染鏡頭」同一個位置與樣式：大按鈕、一定有
// 文字、工具列唯一的漸層），生成選取的圖片（批次 N 張＝一個 run）。不能生成時按鈕保持可聚焦，原因在提示與
// aria-describedby（與送出時同一套檢查）；左邊的狀態標記以提示說明這張圖片目前的狀態；元件組合在但沒有就緒（或讀不到）時，
// 右邊多一個「開啟生成引擎」。Image Studio 沒有圖片生成的時間模型（Video Studio 的預估是 H3 專用），所以不顯示預估時間。
import { Cpu, Sparkles } from "lucide-react";
import { ActionButton } from "@/components/common/ActionButton";
import { useMaskDraftDirty } from "../hooks/maskDrafts";
import { useImageStudio } from "../imageStudioContext";
import { NO_IMAGE_ENGINE } from "../model/engine";
import { changedSinceTake } from "../model/params";
import { imageRenderPreflight } from "../model/plan";
import { findImageRoute } from "../model/routes";
import { activeImageTake, imageShots, imageShotStatus, takeNumber, type ImageShotStatus } from "../model/shots";
import type { StudioImageShot } from "../types";
import { ShotStatusMark } from "./marks";
import { t, tServer } from "@/i18n";
import { formatList } from "@/i18n/format";

const BUTTON_CLASS = "h-10 shrink-0 px-5 text-body";

/** 圖片狀態的一句話（狀態標記的提示）。 */
function statusText(shot: StudioImageShot, status: ImageShotStatus): string {
  const active = activeImageTake(shot);
  const latest = shot.takes.at(-1);
  const error = latest?.error ? `${latest.error.code} ${tServer(latest.error.message)}` : null;
  if (status === "rendering") return t("生成中（{count} 張）；監看器顯示進度與預覽。", { count: shot.takes.filter((take) => take.state === "rendering").length });
  if (status === "ready" && active) return t("使用中：take {takeNumber}（seed {seed}）。", { takeNumber: takeNumber(shot, active.take_id), seed: active.seed });
  if (status === "stale" && active) {
    return t("使用中的 take {takeNumber} 是舊設定（已變更：{changedSinceTake}）。", { takeNumber: takeNumber(shot, active.take_id), changedSinceTake: formatList(changedSinceTake(active, shot)) });
  }
  if (status === "failed" && latest?.error) return t("最近一次失敗：{code} {message}", { code: latest.error.code, message: tServer(latest.error.message) });
  if (status === "cancelled") return error ? t("最近一次已取消：{error}", { error }) : t("最近一次已取消。");
  if (status === "interrupted") return error ? t("最近一次中斷：{error}", { error }) : t("最近一次中斷");
  return t("還沒生成過。");
}

export function GenerateControl() {
  const { project, selectedShotId } = useImageStudio();
  const shot = imageShots(project).find((item) => item.image_shot_id === selectedShotId) ?? null;
  if (!shot) {
    return (
      <ActionButton size="md" variant="primary" icon={<Sparkles aria-hidden />} disabledReason={t("先新增一張圖片")} className={BUTTON_CLASS}>
        {t("生成圖片")}
      </ActionButton>
    );
  }
  return <GenerateButton shot={shot} />;
}

function GenerateButton({ shot }: { shot: StudioImageShot }) {
  const { project, engine, busy, runBlockedReason, notSent, autoLibrary, generate, setEngineOpen } = useImageStudio();
  const maskDirty = useMaskDraftDirty(shot.image_shot_id);
  const preflight =
    engine.status === "ready"
      ? imageRenderPreflight(project, shot, { routes: engine.routes, autoLibrary })
      : { problem: engine.status === "loading" ? t("還在讀取元件組合與元件目錄") : t("無法讀取元件組合或元件目錄：{value}", { value: engine.error ?? "" }), notes: [] };
  const route = findImageRoute(engine.routes, shot.route);
  // 沒有任何圖片元件組合時，「基本」分頁有範本可以建立（不是引擎側欄的事）
  const reason = runBlockedReason ?? (engine.status === "ready" && engine.routes.length === 0 ? t("{value}：在「基本」分頁用範本建立。", { value: NO_IMAGE_ENGINE }) : preflight.problem);
  // 「生成引擎」能處理的問題：元件組合讀不到，或選的元件組合有元件沒有就緒
  const engineProblem = engine.status === "error" || (route !== null && !route.ready);
  const count = shot.batch;
  const notSentReason = notSent.get(shot.image_shot_id) ?? null;
  const shotStatus = imageShotStatus(shot, (take) => changedSinceTake(take, shot), notSentReason);
  const status = notSentReason !== null ? t("沒有送出：{reason}", { reason: notSentReason }) : statusText(shot, shotStatus);
  const title = [
    count > 1 ? t("生成 {count} 張（Ctrl+Enter）", { count }) : t("生成（Ctrl+Enter）"),
    maskDirty && shot.mode === "i2i" ? t("生成前會先保存未保存的遮罩。") : null,
    ...preflight.notes,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  return (
    <div className="flex shrink-0 items-center gap-2">
      <span title={status} className="inline-flex shrink-0">
        <ShotStatusMark status={shotStatus} compact />
        <span className="sr-only">{status}</span>
      </span>
      <ActionButton
        size="md"
        variant="primary"
        icon={<Sparkles aria-hidden />}
        pending={busy}
        disabledReason={reason}
        onClick={() => void generate(shot.image_shot_id)}
        title={title}
        className={BUTTON_CLASS}
      >
        {count > 1 ? t("生成 {count} 張圖片", { count }) : t("生成圖片")}
      </ActionButton>
      {engineProblem && !runBlockedReason ? (
        <button
          type="button"
          onClick={() => setEngineOpen(true)}
          title={route?.problems.join("\n") || engine.error || undefined}
          className="pressable inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-caption text-warning hover:bg-raised active:bg-sunken [&_svg]:size-3.5"
        >
          <Cpu aria-hidden />
          {t("開啟生成引擎")}
        </button>
      ) : null}
    </div>
  );
}
