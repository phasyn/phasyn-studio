// 分頁 2：場景與候選。中欄＝版本選擇、8 區段編修（鎖定、有意修改、證據）與候選（已儲存、草稿預覽、逐區段差異）；
// 檢視器＝版本事實、資料檢查、視覺模型修訂、接受與套用；底部是「儲存新版本」（prompt.scene_compile 編譯後另存，原版本不變）。
import { ArrowLeft, BadgeCheck, FileBraces, ListChecks, RotateCcw, Save, Send, WandSparkles } from "lucide-react";
import { ActionButton } from "@/components/common/ActionButton";
import { Disclosure } from "@/components/common/Disclosure";
import { EmptyState } from "@/components/common/EmptyState";
import { JsonView } from "@/components/common/JsonView";
import { TimeText } from "@/components/common/values";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Select, Textarea } from "@/components/ui/controls";
import { DockBody } from "@/components/workbench/DockPanel";
import { EntityHeader, InspectorFooter, PropertyGrid, PropertyRow, PropertySection } from "@/components/workbench/Inspector";
import { StatusChip } from "@/components/workbench/StatusChip";
import { ToolStrip } from "@/components/workbench/ToolStrip";
import { refineBlock, saveVersionBlock } from "../model/blocks";
import type { EditorDraft, SceneIssue } from "../model/scene";
import { LIMITS, SECTION_KEYS, SECTION_LABELS } from "../model/sections";
import { acceptBlockReason, acceptedRef, findVersion, ORIGIN_LABELS, promptTokenState, versionLabel } from "../model/study";
import { candidateOf } from "../model/compile";
import type { PromptStudyVersion, PromptVariant } from "../types";
import { CandidatesPanel } from "./CandidatesPanel";
import { SceneEditor } from "./SceneEditor";
import { TaskControls } from "./TaskControls";
import type { Workspace } from "./workspace";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

export interface SceneController {
  version: PromptStudyVersion | null;
  latest: PromptStudyVersion | null;
  draft: EditorDraft | null;
  setDraft: (draft: EditorDraft) => void;
  dirty: boolean;
  changed: boolean;
  issues: SceneIssue[];
  /** 切換版本（有未儲存的修改時先確認）。 */
  selectVersion: (versionId: string) => void;
  revert: () => void;
  variant: PromptVariant;
  setVariant: (variant: PromptVariant) => void;
  instruction: string;
  setInstruction: (text: string) => void;
  save: () => void;
  refine: () => void;
}

function versionOption(ws: Workspace, version: PromptStudyVersion): string {
  const latest = ws.study.versions[ws.study.versions.length - 1]?.version_id === version.version_id;
  const accepted = ws.study.accepted_version_id === version.version_id;
  return `${versionLabel(ws.study, version.version_id)} · ${ORIGIN_LABELS[version.origin]}${latest ? t(" · 最新") : ""}${accepted ? t(" · 已接受") : ""}`;
}

export function SceneCenter({ ws, scene }: { ws: Workspace; scene: SceneController }) {
  const { study } = ws;
  if (!scene.version || !scene.draft) {
    return (
      <EmptyState
        illustration="frames"
        icon={<FileBraces />}
        title={t("還沒有場景")}
        description={t("先分析原圖：產生 8 區段場景（主體、動作、構圖、環境、光線、外觀與材質、風格、可見文字）與 core／detailed 候選。")}
        action={
          <Button icon={<ArrowLeft aria-hidden />} onClick={() => ws.goTab("source")}>
            {t("前往來源與分析")}
          </Button>
        }
      />
    );
  }
  const version = scene.version;
  const previous = findVersion(study, version.parent_version_id);
  return (
    <div className="grid min-w-0 content-start">
      <ToolStrip label={t("版本")}>
        <label htmlFor="prompt-scene-version" className="text-caption text-fg-secondary">
          {t("版本")}
        </label>
        <Select id="prompt-scene-version" compact className="w-auto max-w-full min-w-60" value={version.version_id} onChange={(event) => scene.selectVersion(event.target.value)}>
          {[...study.versions].reverse().map((item) => (
            <option key={item.version_id} value={item.version_id}>
              {versionOption(ws, item)}
            </option>
          ))}
        </Select>
        {scene.dirty ? <Badge tone="warning">{t("有未儲存的修改")}</Badge> : null}
        {scene.latest && scene.latest.version_id !== version.version_id ? <Badge>{t("檢視舊版本（{versionLabel} 是最新）", { versionLabel: versionLabel(study, scene.latest.version_id) })}</Badge> : null}
        <div className="ml-auto">
          <Button size="sm" variant="quiet" icon={<RotateCcw aria-hidden />} disabled={!scene.dirty} title={scene.dirty ? t("捨棄草稿，回到這個版本") : t("沒有修改")} onClick={scene.revert}>
            {t("還原", undefined, { context: "revert" })}
          </Button>
        </div>
      </ToolStrip>
      {ws.readOnly ? (
        <div className="px-4 pt-3">
          <Callout tone="info" title={t("研究已封存：只能閱讀")}>
            <p>{t("取消封存後才能編修、修訂與執行。")}</p>
          </Callout>
        </div>
      ) : null}
      <div className="@container min-w-0">
        <div className="grid min-w-0 @5xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <div className="min-w-0 @5xl:border-r @5xl:border-line-subtle">
            <p className="border-b border-line-subtle px-4 py-2 text-caption text-fg-tertiary">{t("鎖定的區段在自動修訂時逐字保留；有意修改會成為比較的目標（一併鎖定）。候選要儲存後才會更新。")}</p>
            <SceneEditor draft={scene.draft} base={version.scene} issues={scene.issues} readOnly={ws.readOnly || ws.runner.state.mode === "compile"} onChange={scene.setDraft} />
          </div>
          <div className="min-w-0 border-t border-line-subtle p-4 @5xl:border-t-0">
            <CandidatesPanel study={study} version={version} previous={previous} draft={scene.draft} variant={scene.variant} onVariant={scene.setVariant} />
          </div>
        </div>
      </div>
    </div>
  );
}

export function SceneInspector({ ws, scene }: { ws: Workspace; scene: SceneController }) {
  const { study, runner } = ws;
  const version = scene.version;
  const openRefine = ws.open?.kind === "refine" ? ws.open : null;
  if (!version) {
    return (
      <EmptyState icon={<FileBraces />} size="compact" title={t("沒有版本")} description={t("分析原圖後，這裡會顯示版本資訊、資料檢查與修訂。")} />
    );
  }
  const isLatest = scene.latest?.version_id === version.version_id;
  const ref = { version_id: version.version_id, variant: scene.variant };
  const acceptReason = acceptBlockReason(study, ref);
  const candidate = candidateOf(version, scene.variant);
  const tooLong = candidate ? promptTokenState(study, candidate.prompt_sha256, candidate.token_status) === "too_long" : false;
  const applyReason = scene.dirty ? t("先儲存或還原修改：套用的是已儲存的候選") : !candidate ? t("這個版本沒有這個候選") : tooLong ? t("這個候選超過 token 上限") : null;
  const saveReason = saveVersionBlock({ study, busy: runner.state.busy, changed: scene.changed, dirty: scene.dirty, issues: scene.issues, compile: ws.chosen.compile });
  const refineReason = refineBlock({ study, busy: runner.state.busy, dirty: scene.dirty, isLatest, instruction: scene.instruction, vision: ws.chosen.vision, compile: ws.chosen.compile });
  const acceptance = study.acceptance;
  const accepted = acceptedRef(study);
  const locked = SECTION_KEYS.filter((key) => version.scene.sections[key].locked);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <EntityHeader
        icon={FileBraces}
        tone="info"
        title={t("場景 {versionLabel}", { versionLabel: versionLabel(study, version.version_id) })}
        status={scene.dirty ? <StatusChip tone="warning" label={t("已修改（未儲存）")} /> : <StatusChip tone="neutral" label={isLatest ? t("最新版本") : t("舊版本")} />}
        description={
          <span className="flex flex-wrap items-center gap-x-1.5">
            <span>{ORIGIN_LABELS[version.origin]}</span>
            <span aria-hidden>·</span>
            <TimeText iso={version.created_at} />
            {version.parent_version_id ? <span>{t("· 由 {versionLabel} 修改", { versionLabel: versionLabel(study, version.parent_version_id) })}</span> : null}
          </span>
        }
        id={version.version_id}
      />
      <DockBody>
        <PropertySection title={t("版本")} icon={<FileBraces aria-hidden />}>
          <PropertyGrid>
            <PropertyRow label={t("有意修改")}>{version.intentional_changes.length === 0 ? <span className="text-fg-tertiary">{t("無")}</span> : formatList(version.intentional_changes.map((key) => SECTION_LABELS[key]))}</PropertyRow>
            <PropertyRow label={t("鎖定區段")}>{locked.length === 0 ? <span className="text-fg-tertiary">{t("無")}</span> : formatList(locked.map((key) => SECTION_LABELS[key]))}</PropertyRow>
            <PropertyRow label={t("備註")}>{version.note || <span className="text-fg-tertiary">—</span>}</PropertyRow>
          </PropertyGrid>
          {version.provenance ? (
            <Disclosure summary={t("來源紀錄（run、元件、模型輸出摘要）")}>
              <JsonView value={version.provenance} label="provenance" maxHeightClass="max-h-48" />
            </Disclosure>
          ) : (
            <p className="text-caption text-fg-tertiary">{t("沒有來源紀錄。")}</p>
          )}
        </PropertySection>
        <PropertySection title={t("資料檢查")} icon={<ListChecks aria-hidden />} count={scene.issues.length}>
          {scene.issues.length === 0 ? (
            <p className="text-data text-fg-secondary">{t("沒有問題：主體有文字、證據引用正確、有意修改的區段都已鎖定。")}</p>
          ) : (
            <ul className="grid gap-1 text-caption text-danger">
              {scene.issues.map((issue) => (
                <li key={issue.message}>{issue.message}</li>
              ))}
            </ul>
          )}
        </PropertySection>
        <PropertySection title={t("視覺模型修訂")} icon={<WandSparkles aria-hidden />}>
          {openRefine ? (
            <TaskControls study={study} task={openRefine} runner={runner} />
          ) : (
            <div className="grid gap-2">
              <label htmlFor="prompt-refine-instruction" className="text-caption text-fg-secondary">
                {t("給視覺模型的修訂指示（鎖定區段逐字保留；產生新版本）")}
              </label>
              <Textarea
                id="prompt-refine-instruction"
                compact
                rows={3}
                maxLength={LIMITS.instruction}
                readOnly={ws.readOnly}
                placeholder={t("例如：保留構圖，補足主體的材質描述。")}
                value={scene.instruction}
                onChange={(event) => scene.setInstruction(event.target.value)}
              />
              <ActionButton size="sm" icon={<WandSparkles aria-hidden />} disabledReason={refineReason} onClick={scene.refine}>
                {t("修訂場景")}
              </ActionButton>
            </div>
          )}
        </PropertySection>
        <PropertySection title={t("接受與套用")} icon={<BadgeCheck aria-hidden />}>
          <div className="grid gap-2">
            {acceptance && accepted ? (
              <p className="flex flex-wrap items-center gap-x-1.5 text-caption text-fg-secondary">
                <span>{t("已接受 {versionLabel} {variant}", { versionLabel: versionLabel(study, accepted.version_id), variant: acceptance.variant })}</span>
                <TimeText iso={acceptance.accepted_at} />
                {acceptance.note ? <span>{t("備註：{note}", { note: acceptance.note })}</span> : null}
              </p>
            ) : (
              <p className="text-caption text-fg-secondary">{t("尚未接受任何候選。")}</p>
            )}
            <div className="flex flex-wrap gap-2">
              <ActionButton size="sm" icon={<BadgeCheck aria-hidden />} disabledReason={acceptReason} onClick={() => ws.requestAccept(ref, null)}>
                {t("接受 {variant}…", { variant: scene.variant })}
              </ActionButton>
              <ActionButton size="sm" icon={<Send aria-hidden />} disabledReason={applyReason} onClick={() => ws.requestApply(ref, ws.settings)}>
                {t("套用到 Image Studio…")}
              </ActionButton>
            </div>
            <p className="text-caption text-fg-tertiary">{t("套用只在選定的專案新增圖片鏡頭（prompt＋目前的生成設定），不會自動生成。")}</p>
          </div>
        </PropertySection>
      </DockBody>
      <InspectorFooter note={t("儲存會用 prompt.scene_compile 編譯候選並另存新版本；原版本不變。")}>
        <ActionButton variant="primary" size="sm" icon={<Save aria-hidden />} pending={runner.state.mode === "compile"} disabledReason={runner.state.mode === "compile" ? null : saveReason} onClick={scene.save}>
          {t("儲存新版本")}
        </ActionButton>
        <Button size="sm" variant="quiet" icon={<RotateCcw aria-hidden />} disabled={!scene.dirty} onClick={scene.revert}>
          {t("還原", undefined, { context: "revert" })}
        </Button>
      </InspectorFooter>
    </div>
  );
}
