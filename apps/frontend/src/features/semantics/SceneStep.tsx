// 步驟 2：Scene 編修。中欄＝SceneEditor（主要工作區）與各種載入狀態；
// 檢視器＝Scene 檔（原檔不變、另存的新檔、caption 會用哪一份）、資料檢查、反推 run；底部是「另存新 Scene」。
import { withOccurrenceKeys } from "@/lib/occurrenceKeys";
import type { UseQueryResult } from "@tanstack/react-query";
import { FileBraces, ListChecks, LoaderCircle, RotateCcw, Save } from "lucide-react";
import type { WireRun } from "@/api/types";
import { ActionButton } from "@/components/common/ActionButton";
import { EmptyState } from "@/components/common/EmptyState";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { IdText } from "@/components/common/values";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { EntityHeader, PropertyGrid, PropertyRow, PropertySection } from "@/components/workbench/Inspector";
import { StatusChip } from "@/components/workbench/StatusChip";
import { SceneEditor } from "./SceneEditor";
import { RunSection, StepInspector } from "./StepFrame";
import type { SceneStepState } from "./useSemanticsSteps";
import { t } from "@/i18n";

const MAX_LISTED_ISSUES = 10;

function Pending({ children }: { children: string }) {
  return (
    <p role="status" className="flex items-center gap-2 px-5 py-6 text-data text-fg-secondary">
      <LoaderCircle aria-hidden className="size-4 text-brand-cyan animate-spin" />
      {children}
    </p>
  );
}

/** 中欄：Scene 編修器；沒有 Scene 時說明原因（尚未反推、執行中、沒有輸出、讀檔失敗、內容無效）。 */
export function SceneWorkspace({ scene, describeRunId, describeRun }: { scene: SceneStepState; describeRunId: string | null; describeRun: UseQueryResult<WireRun> }) {
  if (!(describeRunId != null && describeRunId !== "")) {
    return <EmptyState illustration="frames" icon={<FileBraces />} title={t("還沒有 Scene")} description={t("執行反推後在這裡檢視與編修 Scene。也可從 run 明細的 Scene 輸出開啟此頁。")} />;
  }
  if (!describeRun.data) {
    return describeRun.isError ? (
      <div className="p-4">
        <ErrorCallout error={describeRun.error} title={t("無法讀取反推 run")} onRetry={() => void describeRun.refetch()} retrying={describeRun.isFetching} />
      </div>
    ) : (
      <Pending>{t("讀取反推 run…")}</Pending>
    );
  }
  if (!scene.sceneValue) {
    return describeRun.data.state === "running" ? (
      <Pending>{t("反推執行中…")}</Pending>
    ) : (
      <p className="px-5 py-6 text-data text-warning">{t("這個 run 沒有 video.scene.v1 輸出。")}</p>
    );
  }
  if (scene.sceneFile && scene.sceneJson.isPending) return <Pending>{t("讀取 Scene JSON…")}</Pending>;
  if (scene.sceneFile && scene.sceneJson.isError) {
    return (
      <div className="p-4">
        <ErrorCallout error={scene.sceneJson.error} title={t("無法讀取 Scene 檔案")} onRetry={() => void scene.sceneJson.refetch()} retrying={scene.sceneJson.isFetching} />
      </div>
    );
  }
  if (!scene.originalScene) {
    return (
      <div className="p-4">
        <ErrorCallout error={{ code: "INVALID_ARGUMENT", message: t("Scene 內容不是有效的 SceneDocument（缺少 source／duration／events 等欄位）") }} />
      </div>
    );
  }
  if (!scene.draft || !(scene.originKey != null && scene.originKey !== "")) return <Pending>{t("讀取反推 run…")}</Pending>;
  return (
    <div className="p-4 animate-rise-in">
      <SceneEditor scene={scene.draft} issues={scene.issues} onChange={scene.setDraft} />
    </div>
  );
}

function SceneStatus({ scene }: { scene: SceneStepState }) {
  if (!scene.draft) return null;
  if (scene.savedCurrent) return <StatusChip tone="success" label={t("已另存")} />;
  if (scene.changed) return <StatusChip tone="warning" label={t("已修改")} />;
  return <StatusChip tone="neutral" label={t("與原 Scene 相同")} />;
}

/** 檢視器：Scene 檔與 caption 輸入、資料檢查、反推 run；底部「另存新 Scene」（上傳成新檔）與「還原為原 Scene」。 */
export function SceneInspector({ scene, describeRunId, describeRun }: { scene: SceneStepState; describeRunId: string | null; describeRun: UseQueryResult<WireRun> }) {
  const draft = scene.draft;
  const issues = scene.issues;
  return (
    <StepInspector
      header={
        <EntityHeader
          icon={FileBraces}
          tone="info"
          title={t("Scene（video.scene.v1）")}
          status={<SceneStatus scene={scene} />}
          description={
            draft ? (
              <span className="machine">{t("{duration_seconds} s · {eventsCount} 個事件 · {entitiesCount} 個主體 · {evidenceCount} 個證據幀", { duration_seconds: draft.duration_seconds, eventsCount: draft.events.length, entitiesCount: draft.entities.length, evidenceCount: draft.evidence.length })}</span>
            ) : (
              t("執行反推後載入 Scene；觀測事實與 generation edits 分開編修。")
            )
          }
          id={scene.sceneFile?.file_id ?? null}
        />
      }
      note={t("另存會上傳成新檔（application/json）；原 Scene 保留。")}
      actions={
        <>
          {(scene.saveError != null) ? <ErrorCallout error={scene.saveError} write title={t("另存 Scene 失敗；編修內容保留")} /> : null}
          <div className="flex flex-wrap items-center gap-2">
            <ActionButton
              variant="primary"
              size="sm"
              icon={<Save aria-hidden />}
              pending={scene.saving}
              disabledReason={scene.saving ? null : scene.saveBlock}
              onClick={() => void scene.save()}
            >
              {t("另存新 Scene")}
            </ActionButton>
            <Button size="sm" variant="quiet" icon={<RotateCcw aria-hidden />} disabled={!scene.changed} title={scene.changed ? undefined : t("沒有修改")} onClick={scene.revert}>
              {t("還原為原 Scene")}
            </Button>
          </div>
        </>
      }
    >
      <PropertySection title={t("Scene 檔")} icon={<FileBraces aria-hidden />}>
        {scene.sceneValue ? (
          <PropertyGrid>
            <PropertyRow label={t("原 Scene")} hint={scene.sceneFile ? t("不會被修改") : undefined}>
              {scene.sceneFile ? (
                <IdText value={scene.sceneFile.file_id} />
              ) : (
                <span>
                  <Badge>inline Scene</Badge>
                </span>
              )}
            </PropertyRow>
            <PropertyRow label={t("草稿")}>
              <span>{scene.changed ? <Badge tone="warning">{t("已修改")}</Badge> : <Badge>{t("與原 Scene 相同")}</Badge>}</span>
            </PropertyRow>
            <PropertyRow label={t("另存的新檔")}>
              {scene.savedCurrent ? <IdText value={scene.savedCurrent.ref.file_id} /> : <span className="text-fg-tertiary">—</span>}
            </PropertyRow>
            <PropertyRow label={t("caption 輸入")}>
              {scene.captionScene ? (
                <span>{scene.savedCurrent ? t("另存的新 Scene") : t("原 Scene（反推輸出）")}</span>
              ) : (
                <span className="text-warning">{scene.captionSceneBlock}</span>
              )}
            </PropertyRow>
          </PropertyGrid>
        ) : (
          <p className="text-data text-fg-tertiary">{t("尚未載入 Scene。")}</p>
        )}
      </PropertySection>
      <PropertySection title={t("資料檢查")} icon={<ListChecks aria-hidden />} count={draft ? issues.length : null}>
        {!draft ? (
          <p className="text-data text-fg-tertiary">{t("沒有 Scene 可檢查。")}</p>
        ) : issues.length === 0 ? (
          <p className="text-data text-fg-secondary">{t("沒有資料錯誤：事件時間在影片長度內，引用的主體與證據幀都存在。")}</p>
        ) : (
          <Callout tone="danger" title={t("Scene 有 {issuesCount} 個資料錯誤（修正後才能另存）", { issuesCount: issues.length })}>
            <ul className="grid gap-0.5">
              {withOccurrenceKeys(issues.slice(0, MAX_LISTED_ISSUES), (issue) => issue.message).map(({ item: issue, key }) => (
                <li key={key}>
                  <span className="machine text-caption">{issue.path}</span>
                  {t("：{message}", { message: issue.message })}
                </li>
              ))}
            </ul>
            {issues.length > MAX_LISTED_ISSUES ? <p className="text-caption text-fg-tertiary">{t("另有 {issuesCount} 個，修正上面的項目後會繼續列出。", { issuesCount: issues.length - MAX_LISTED_ISSUES })}</p> : null}
          </Callout>
        )}
      </PropertySection>
      <RunSection title={t("反推 run")} runId={describeRunId} run={describeRun} label="video.describe" emptyText={t("尚未執行反推。")} errorTitle={t("無法讀取反推 run")} />
    </StepInspector>
  );
}
