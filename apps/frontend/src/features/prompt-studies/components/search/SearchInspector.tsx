// The search tab's inspector: search settings (a new task) or the frozen settings of an open task, generation settings
// and components, with the start／continue controls at the bottom.
import { Play, Settings2, SlidersHorizontal, StepForward, Telescope } from "lucide-react";
import { useId, useState } from "react";
import { ActionButton } from "@/components/common/ActionButton";
import { Input, Select } from "@/components/ui/controls";
import { DockBody } from "@/components/workbench/DockPanel";
import { EntityHeader, InspectorFooter, PropertyGrid, PropertyRow, PropertySection } from "@/components/workbench/Inspector";
import { generationBlock } from "../../model/blocks";
import { roleProblem, ROLE_LABELS, ROLE_PROVIDER } from "../../model/components";
import { taskSettings } from "../../model/normalize";
import { SEARCH_LIMITS, validateSearch, type SearchDraft } from "../../model/search";
import { SECTION_LABELS } from "../../model/sections";
import { findTask } from "../../model/study";
import type { PromptStudyTask } from "../../types";
import { GenerationSettingsForm } from "../GenerationSettingsForm";
import { ComponentSelect, TaskStateChip } from "../shared";
import { TaskControls } from "../TaskControls";
import type { Workspace } from "../workspace";
import { formatList } from "@/i18n/format";
import { t } from "@/i18n";
import { searchTasks, type ReconstructRequest, type SearchController } from "./controller";

function SearchConfigForm({ search, readOnly }: { search: SearchController; readOnly: boolean }) {
  const id = useId();
  const draft = search.draft;
  const set = (key: keyof SearchDraft, value: string) => { search.setDraft({ ...draft, [key]: value }); };
  const validation = validateSearch(draft);
  const required = validation.ok ? validation.plan.requiredImages : validation.requiredImages;
  const visionOps = validation.ok ? validation.plan.visionOps : validation.visionOps;
  return (
    <div className="grid gap-2">
      <PropertyGrid>
        <PropertyRow label={t("搜尋 seed")} htmlFor={`${id}-search`} hint={t("1–4 個，不重複")}>
          <Input id={`${id}-search`} compact className="machine" value={draft.searchSeeds} readOnly={readOnly} onChange={(event) => { set("searchSeeds", event.target.value); }} />
        </PropertyRow>
        <PropertyRow label={t("保留驗證 seed")} htmlFor={`${id}-holdout`} hint={t("2–4 個，不能與搜尋 seed 重疊")}>
          <Input id={`${id}-holdout`} compact className="machine" value={draft.holdoutSeeds} readOnly={readOnly} onChange={(event) => { set("holdoutSeeds", event.target.value); }} />
        </PropertyRow>
        <PropertyRow label={t("輪數")} htmlFor={`${id}-rounds`} hint={t("含初始輪，最多 4")}>
          <Select id={`${id}-rounds`} compact value={draft.rounds} disabled={readOnly} onChange={(event) => { set("rounds", event.target.value); }}>
            {[1, 2, 3, 4].map((value) => (
              <option key={value} value={String(value)}>
                {t("{value} 輪", { value })}
              </option>
            ))}
          </Select>
        </PropertyRow>
        <PropertyRow label={t("圖片預算")} htmlFor={`${id}-budget`} hint={t("{minImages}–{maxImages} 張，要涵蓋最壞情況", { minImages: SEARCH_LIMITS.minImages, maxImages: SEARCH_LIMITS.maxImages })}>
          <Input id={`${id}-budget`} compact className="machine" inputMode="numeric" value={draft.budget} readOnly={readOnly} onChange={(event) => { set("budget", event.target.value); }} />
        </PropertyRow>
        <PropertyRow label={t("無改善停止")} htmlFor={`${id}-stop`} hint={t("連續幾輪沒有改善就提前進入保留驗證")}>
          <Select id={`${id}-stop`} compact value={draft.stopAfter} disabled={readOnly} onChange={(event) => { set("stopAfter", event.target.value); }}>
            {[1, 2, 3].map((value) => (
              <option key={value} value={String(value)}>
                {t("{value} 輪", { value })}
              </option>
            ))}
          </Select>
        </PropertyRow>
      </PropertyGrid>
      <p className="text-caption text-fg-tertiary">
        {t("最壞情況：{value} 張圖（2 × 搜尋 seed × 輪數 ＋ 2 × 保留驗證 seed）、{value2} 次視覺操作（上限 {maxVisionOps}）。失敗或取消的生成也計入；挑戰者要低至少 {improvement} 才做雙順序確認。", { value: required ?? "?", value2: visionOps ?? "?", maxVisionOps: SEARCH_LIMITS.maxVisionOps, improvement: SEARCH_LIMITS.improvement })}
      </p>
      {!validation.ok ? (
        <ul className="grid gap-0.5 text-caption text-danger">
          {validation.errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function FrozenConfig({ task, request }: { task: PromptStudyTask; request: ReconstructRequest }) {
  return (
    <PropertyGrid>
      <PropertyRow label={t("搜尋 seed")} mono>
        {request.search_seeds.join(", ")}
      </PropertyRow>
      <PropertyRow label={t("保留驗證 seed")} mono>
        {request.holdout_seeds.join(", ")}
      </PropertyRow>
      <PropertyRow label={t("輪數")} mono>
        {request.max_rounds}
      </PropertyRow>
      <PropertyRow label={t("圖片預算")} mono>
        {request.max_images}
      </PropertyRow>
      <PropertyRow label={t("視覺操作上限")} mono>
        {request.max_vision_operations}
      </PropertyRow>
      <PropertyRow label={t("無改善停止")} mono>
        {t("{stop_after_no_improvement} 輪", { stop_after_no_improvement: request.stop_after_no_improvement })}
      </PropertyRow>
      <PropertyRow label={t("評分區段")}>{task.rubric ? formatList(task.rubric.applicable_sections.map((key) => SECTION_LABELS[key])) || "—" : <span className="text-fg-tertiary">{t("第一次評分時由 prompt.scene_score 凍結")}</span>}</PropertyRow>
    </PropertyGrid>
  );
}

export function SearchInspector({ ws, search }: { ws: Workspace; search: SearchController }) {
  const { study, runner } = ws;
  const id = useId();
  const [rounds, setRounds] = useState("all");
  const open = ws.open?.kind === "reconstruct" ? ws.open : null;
  const shown = open ?? findTask(study, search.taskId) ?? searchTasks(ws)[0] ?? null;
  const frozenRequest = open?.request.kind === "reconstruct" ? open.request : null;
  const frozenSettings = frozenRequest ? taskSettings(frozenRequest.settings) : null;
  const route = ws.routes.find((item) => item.id === ws.settings.route) ?? null;
  const validation = validateSearch(search.draft);
  const block =
    generationBlock({ study, busy: runner.state.busy, route, settings: ws.settings, vision: ws.chosen.vision, score: ws.chosen.score }) ??
    (validation.ok ? null : (validation.errors[0] ?? t("搜尋設定有問題"))) ??
    (validation.ok && validation.plan.rounds > 1 ? roleProblem("compile", ws.chosen.compile) : null);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <EntityHeader
        icon={Telescope}
        tone="entity"
        title={t("有界搜尋")}
        status={<TaskStateChip task={shown} />}
        description={t("共同搜尋 seed 比較 → 修訂 → A/B＋B/A 確認 → 保留驗證；每一步一個 run，由你明確執行")}
        id={shown?.task_id ?? null}
      />
      <DockBody>
        <PropertySection title={open && frozenRequest ? t("搜尋設定（這個任務凍結）") : t("搜尋設定")} icon={<Telescope aria-hidden />}>
          {open && frozenRequest ? <FrozenConfig task={open} request={frozenRequest} /> : <SearchConfigForm search={search} readOnly={ws.readOnly} />}
        </PropertySection>
        <PropertySection title={frozenSettings ? t("生成設定（這個任務凍結）") : t("生成設定（與生成比對共用）")} icon={<SlidersHorizontal aria-hidden />}>
          <GenerationSettingsForm
            idPrefix="prompt-search-settings"
            settings={frozenSettings ?? ws.settings}
            onChange={ws.setSettings}
            routes={ws.routes}
            routesLoading={ws.routesLoading}
            sourceSize={ws.sourceSize}
            readOnly={Boolean(frozenSettings) || ws.readOnly}
          />
        </PropertySection>
        <PropertySection title={t("元件")} icon={<Settings2 aria-hidden />}>
          <div className="grid gap-3">
            {(["vision", "score", "compile"] as const).map((role) => (
              <ComponentSelect
                key={role}
                id={`prompt-search-${role}`}
                label={ROLE_LABELS[role]}
                providerId={ROLE_PROVIDER[role]}
                choices={ws.choices[role]}
                value={ws.chosen[role]}
                onChange={(key) => { ws.setComponent(role, key); }}
                loading={ws.catalogLoading}
                disabled={runner.state.busy || Boolean(open)}
              />
            ))}
            {open ? <p className="text-caption text-fg-tertiary">{t("任務使用建立時選的元件（凍結在任務的 request.settings）；要換元件請結束任務後重新開始。")}</p> : null}
          </div>
        </PropertySection>
      </DockBody>
      <InspectorFooter note={open ? t("停止只在目前的 run 結束後生效；失敗時停下來等你決定重試或結束。") : t("開始會凍結目前的搜尋設定、生成設定與元件；評分規則在第一次評分時凍結（起點版本的場景）。")}>
        {open ? (
          <TaskControls study={study} task={open} runner={runner} allowRounds />
        ) : (
          <div className="grid w-full gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <ActionButton variant="primary" size="sm" icon={<StepForward aria-hidden />} disabledReason={block} onClick={() => { search.start("step", 1); }}>
                {t("開始：執行第一步")}
              </ActionButton>
              <span className="inline-flex items-center gap-1.5">
                <label htmlFor={`${id}-rounds`} className="text-caption text-fg-secondary">
                  {t("或連續")}
                </label>
                <Select id={`${id}-rounds`} compact className="w-auto min-w-28" value={rounds} onChange={(event) => { setRounds(event.target.value); }}>
                  {[1, 2, 3, 4].map((value) => (
                    <option key={value} value={String(value)}>
                      {t("{value} 輪", { value })}
                    </option>
                  ))}
                  <option value="all">{t("到結束")}</option>
                </Select>
                <ActionButton size="sm" icon={<Play aria-hidden />} disabledReason={block} onClick={() => { search.start("loop", rounds === "all" ? "all" : Number(rounds)); }}>
                  {t("開始並連續執行")}
                </ActionButton>
              </span>
            </div>
          </div>
        )}
      </InspectorFooter>
    </div>
  );
}
