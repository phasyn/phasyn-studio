// 分頁 3：生成比對（手動）。最新版本的候選 × 指定 seed：每張圖一個 t2i 生成 run，再一個比較 run（qimg.vision 與原圖比較 →
// prompt.scene_score 評分）。中欄＝任務選擇、圖片清單與比較細節；檢視器＝生成設定、seed 與候選、元件；底部是「生成候選」或任務控制。
import { Images, Settings2, SlidersHorizontal } from "lucide-react";
import { ActionButton } from "@/components/common/ActionButton";
import { Disclosure } from "@/components/common/Disclosure";
import { EmptyState } from "@/components/common/EmptyState";
import { Select } from "@/components/ui/controls";
import { DockBody } from "@/components/workbench/DockPanel";
import { EntityHeader, InspectorFooter, PropertySection } from "@/components/workbench/Inspector";
import { ToolStrip } from "@/components/workbench/ToolStrip";
import { renderBlock } from "../model/blocks";
import { uniqueCandidates } from "../model/compile";
import { ROLE_LABELS, ROLE_PROVIDER } from "../model/components";
import { formatLoss } from "../model/loss";
import { taskSettings } from "../model/normalize";
import { renderImageBudget } from "../model/planner";
import { imageRows } from "../model/rows";
import { renderSeedProblem, type RenderSeedDraft } from "../model/seeds";
import { evaluationsOf, findTask, imagesUsed, latestVersion, meanEvaluationLoss, rendersOf, versionLabel } from "../model/study";
import type { PromptStudyTask, PromptVariant } from "../types";
import { EvaluationDetail } from "./EvaluationDetail";
import { EvaluationTable } from "./EvaluationTable";
import { GenerationSettingsForm, RenderSeedsForm } from "./GenerationSettingsForm";
import { ComponentSelect, TaskStateChip } from "./shared";
import { TaskControls } from "./TaskControls";
import type { Workspace } from "./workspace";
import { formatDateTime, formatList } from "@/i18n/format";
import { t } from "@/i18n";

export interface RenderController {
  seeds: RenderSeedDraft;
  setSeeds: (seeds: RenderSeedDraft) => void;
  variants: PromptVariant[];
  setVariants: (variants: PromptVariant[]) => void;
  taskId: string | null;
  setTaskId: (taskId: string) => void;
  /** 選擇的圖片（生成 run id）。 */
  rowId: string | null;
  setRowId: (rowId: string) => void;
  start: () => void;
}

function renderTasks(ws: Workspace): PromptStudyTask[] {
  return ws.study.tasks.filter((task) => task.kind === "render").reverse();
}

function selectedTask(ws: Workspace, render: RenderController): PromptStudyTask | null {
  return findTask(ws.study, render.taskId) ?? renderTasks(ws)[0] ?? null;
}

export function RenderCenter({ ws, render }: { ws: Workspace; render: RenderController }) {
  const { study } = ws;
  const tasks = renderTasks(ws);
  const task = selectedTask(ws, render);
  if (!task) {
    return (
      <EmptyState
        illustration="frames"
        icon={<Images />}
        title={t("還沒有生成比對")}
        description={t("在檢視器設定元件組合、尺寸與 seed 後按「生成候選」：最新版本的 core／detailed 各用同一組 seed 生成，每張都會與原圖比較並評分。")}
      />
    );
  }
  const rows = imageRows(study, task);
  const selected = rows.find((row) => row.id === render.rowId) ?? rows[0] ?? null;
  const request = task.request.kind === "render" ? task.request : null;
  const frozen = request ? taskSettings(request.settings) : null;
  return (
    <div className="grid min-w-0 content-start">
      <ToolStrip label={t("生成比對任務")}>
        <label htmlFor="prompt-render-task" className="text-caption text-fg-secondary">
          {t("任務")}
        </label>
        <Select id="prompt-render-task" compact className="w-auto max-w-full min-w-64" value={task.task_id} onChange={(event) => { render.setTaskId(event.target.value); }}>
          {tasks.map((item) => (
            <option key={item.task_id} value={item.task_id}>
              {t("{versionLabel} · {created_at} · {itemCount} 張", { versionLabel: versionLabel(study, item.base_version_id), created_at: formatDateTime(item.created_at), itemCount: rendersOf(item).length })}
            </option>
          ))}
        </Select>
        <TaskStateChip task={task} />
        <span className="ml-auto machine text-caption text-fg-tertiary">{t("圖片 {task}/{task2} · 平均誤差 {task3}", { task: imagesUsed(task), task2: renderImageBudget(task), task3: formatLoss(meanEvaluationLoss(evaluationsOf(task))) })}</span>
      </ToolStrip>
      <div className="@container grid min-w-0 gap-4 p-4">
        {request && frozen ? (
          <Disclosure summary={t("這個任務的設定（建立時凍結）：{route} · {width}×{height} · {steps} 步 · guidance {guidance} · {variants} · seed {seeds}", { route: frozen.route, width: frozen.width, height: frozen.height, steps: frozen.steps, guidance: frozen.guidance, variants: formatList(request.variants, { type: "disjunction", separator: "／" }), seeds: request.seeds.join(", ") })}>
            <GenerationSettingsForm idPrefix={`prompt-render-frozen-${task.task_id}`} settings={frozen} onChange={() => undefined} routes={ws.routes} routesLoading={ws.routesLoading} sourceSize={ws.sourceSize} readOnly />
          </Disclosure>
        ) : (
          <p className="text-caption text-warning">{t("這個任務的生成設定無法解讀；結果參照仍保留在研究文件中。")}</p>
        )}
        {rows.length === 0 ? (
          <p className="text-data text-fg-tertiary">{t("這個任務還沒有生成任何圖片。")}</p>
        ) : (
          <EvaluationTable study={study} rows={rows} selectedId={selected?.id ?? null} onSelect={render.setRowId} label={t("生成比對的圖片")} />
        )}
        {selected ? (
          <div key={selected.id} className="animate-rise-in">
            <EvaluationDetail study={study} row={selected} rubric={task.rubric} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function RenderInspector({ ws, render }: { ws: Workspace; render: RenderController }) {
  const { study, runner } = ws;
  const latest = latestVersion(study);
  const openRender = ws.open?.kind === "render" ? ws.open : null;
  const route = ws.routes.find((item) => item.id === ws.settings.route) ?? null;
  const seedProblem = renderSeedProblem(render.seeds);
  const block = renderBlock({ study, busy: runner.state.busy, route, settings: ws.settings, vision: ws.chosen.vision, score: ws.chosen.score, seedProblem, variants: render.variants });
  const candidates = latest ? uniqueCandidates(latest.candidates.items.filter((candidate) => render.variants.includes(candidate.variant))).length : 0;
  const perCandidate = render.seeds.mode === "explicit" ? render.seeds.explicit.split(/[\s,，、]+/).filter(Boolean).length : Number(render.seeds.count) || 0;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <EntityHeader
        icon={Images}
        tone="file"
        title={t("生成比對")}
        status={<TaskStateChip task={openRender ?? selectedTask(ws, render)} />}
        description={latest ? t("對最新版本 {versionLabel} 生成；每張圖：t2i 生成 → qimg.vision 比較 → prompt.scene_score 評分", { versionLabel: versionLabel(study, latest.version_id) }) : t("先分析原圖產生第一版")}
        id={openRender?.task_id ?? null}
      />
      <DockBody>
        <PropertySection title={t("生成設定（與有界搜尋共用）")} icon={<SlidersHorizontal aria-hidden />}>
          <GenerationSettingsForm idPrefix="prompt-render-settings" settings={ws.settings} onChange={ws.setSettings} routes={ws.routes} routesLoading={ws.routesLoading} sourceSize={ws.sourceSize} readOnly={ws.readOnly} />
        </PropertySection>
        <PropertySection title={t("候選與 seed")} icon={<Images aria-hidden />}>
          <RenderSeedsForm idPrefix="prompt-render-seeds" seeds={render.seeds} onSeeds={render.setSeeds} variants={render.variants} onVariants={render.setVariants} disabled={ws.readOnly} />
        </PropertySection>
        <PropertySection title={t("元件")} icon={<Settings2 aria-hidden />}>
          <div className="grid gap-3">
            {(["vision", "score"] as const).map((role) => (
              <ComponentSelect
                key={role}
                id={`prompt-render-${role}`}
                label={ROLE_LABELS[role]}
                providerId={ROLE_PROVIDER[role]}
                choices={ws.choices[role]}
                value={ws.chosen[role]}
                onChange={(key) => { ws.setComponent(role, key); }}
                loading={ws.catalogLoading}
                disabled={runner.state.busy}
              />
            ))}
          </div>
        </PropertySection>
      </DockBody>
      <InspectorFooter
        note={
          openRender
            ? t("失敗不自動重試；失敗或取消的生成也計入這個任務的張數。")
            : t("會生成 {candidates} 個候選 × {value} 個 seed＝{value2} 張（文字相同的候選只生成一次）；失敗或取消的生成也計入，不自動補抽。", { candidates, value: perCandidate || "?", value2: candidates * perCandidate || "?" })
        }
      >
        {openRender ? (
          <TaskControls study={study} task={openRender} runner={runner} />
        ) : (
          <ActionButton variant="primary" size="sm" icon={<Images aria-hidden />} disabledReason={block} onClick={render.start}>
            {t("生成候選")}
          </ActionButton>
        )}
      </InspectorFooter>
    </div>
  );
}
