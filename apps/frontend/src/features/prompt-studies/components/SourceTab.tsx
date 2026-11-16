// 分頁 1：來源與分析。中欄＝原圖（局部觀察標在圖上）、檔案事實、分析任務的進度與原始描述；
// 檢視器＝視覺模型與編譯元件、研究資訊（名稱可改）；底部是「分析原圖」或未結束任務的控制。
import { ArrowRight, FileBraces, ScanSearch, Settings2 } from "lucide-react";
import { Link } from "react-router";
import { useState } from "react";
import { Disclosure } from "@/components/common/Disclosure";
import { IdText, TimeText } from "@/components/common/values";
import { ActionButton } from "@/components/common/ActionButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/controls";
import { KeyValueList } from "@/components/ui/kv";
import { DockBody } from "@/components/workbench/DockPanel";
import { EntityHeader, InspectorFooter, PropertyGrid, PropertyRow, PropertySection } from "@/components/workbench/Inspector";
import { formatBytes } from "@/lib/format";
import { runPath } from "@/app/paths";
import { StatusChip } from "@/components/workbench/StatusChip";
import { FlowSection } from "@/components/flow/FlowSection";
import { ProgressTrack } from "@/components/flow/ProgressTrack";
import { analyzeBlock } from "../model/blocks";
import { ROLE_LABELS, ROLE_PROVIDER } from "../model/components";
import { LANGUAGE_LABELS, LIMITS } from "../model/sections";
import { isRunStep, planTask } from "../model/planner";
import { captionOf, findVersion, latestTask, newTask, versionLabel, versionRefsOf } from "../model/study";
import type { PromptStudyTask } from "../types";
import { ComponentSelect, StudyImage, TaskStateChip } from "./shared";
import { TaskControls } from "./TaskControls";
import type { Workspace } from "./workspace";
import { stepErrorText } from "../model/stepError";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

function SourceFigure({ ws }: { ws: Workspace }) {
  const { study } = ws;
  return (
    <figure className="grid gap-2">
      <div className="relative w-fit max-w-full overflow-hidden rounded-xl border border-line-subtle bg-stage shadow-raised">
        <StudyImage
          file={study.source.file}
          alt={t("研究「{title}」的來源圖片", { title: study.title })}
          className="block max-h-[60vh] max-w-full rounded-none border-0 bg-transparent"
          onSize={(width, height) => ws.setSourceSize({ width, height })}
        />
        {study.crops.map((crop) => (
          <div
            key={crop.view_id}
            aria-hidden
            className="pointer-events-none absolute rounded-xs border-2 border-info"
            style={{ left: `${crop.x0 * 100}%`, top: `${crop.y0 * 100}%`, width: `${(crop.x1 - crop.x0) * 100}%`, height: `${(crop.y1 - crop.y0) * 100}%` }}
          >
            <span className="machine absolute top-0 left-0 bg-info px-1 text-caption text-on-accent">{crop.view_id}</span>
          </div>
        ))}
      </div>
      <figcaption className="text-caption text-fg-tertiary">
        {study.crops.length > 0
          ? t("來源只用於分析與比較，不會成為生成的參考圖。藍框是額外局部觀察（{map}）。", { map: formatList(study.crops.map((crop) => crop.view_id)) })
          : t("來源只用於分析與比較，不會成為生成的參考圖。")}
      </figcaption>
    </figure>
  );
}

/** 分析：分析任務的狀態（描述 → 場景 → 編譯在同一個 run 內依序執行）。 */
function AnalysisStatus({ ws, task }: { ws: Workspace; task: PromptStudyTask }) {
  const caption = captionOf(task);
  const next = task.state === "running" ? planTask(ws.study, task) : null;
  const step = next && isRunStep(next) ? next : null;
  const runId = step?.runId ?? caption?.run_id ?? null;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <TaskStateChip task={task} />
        {step?.action === "attach" ? <StatusChip tone="info" spinning label={t("分析 run：已送出")} title={t("描述 → 場景 → 編譯在同一個 run 內依序執行")} /> : null}
        {step?.action === "retry" ? <StatusChip tone="danger" label={t("分析失敗：{value}", { value: step.error?.code ?? t("錯誤") })} title={stepErrorText(step.error) || undefined} /> : null}
        {caption ? <StatusChip tone="success" label={t("描述、場景、編譯：完成")} /> : null}
        {runId ? (
          <Link to={runPath(runId)} className="machine text-caption" title={`run ${runId}`}>
            {`run ${runId.slice(0, 8)}`}
          </Link>
        ) : null}
        {!step && !caption && task.state === "running" ? <span className="text-caption text-fg-tertiary">{t("還沒有開始第一步")}</span> : null}
      </div>
      {step?.action === "attach" ? <ProgressTrack value={null} tone="running" label={t("分析進度")} valueText={t("分析 run 執行中")} className="max-w-xl" /> : null}
      {step?.action === "retry" && step.error?.remote_outcome_unknown ? <p className="text-caption text-warning">{t("遠端結果未知：請到「紀錄・執行紀錄」確認，系統不會自動重送。")}</p> : null}
    </div>
  );
}

/** 結果：分析產生的版本、模型的原始描述與觀察數。 */
function AnalysisResult({ ws, task }: { ws: Workspace; task: PromptStudyTask }) {
  const caption = captionOf(task);
  const versionId = versionRefsOf(task)[0]?.version_id ?? null;
  const version = findVersion(ws.study, versionId);
  if (!versionId && !caption) return <p className="text-data text-fg-tertiary">{t("還沒有結果：分析完成後，版本與模型的描述會出現在這裡。")}</p>;
  return (
    <div className="grid gap-3">
      {versionId ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line-subtle bg-canvas px-3.5 py-3 animate-rise-in">
          <span aria-hidden className="grid size-8 place-items-center rounded-lg border border-success/40 bg-success/12 text-success">
            <FileBraces className="size-4" />
          </span>
          <span className="min-w-0 flex-1 text-data text-fg">{t("已產生 {versionLabel}：8 區段場景與 core／detailed 候選。", { versionLabel: versionLabel(ws.study, versionId) })}</span>
          <Button size="sm" icon={<ArrowRight aria-hidden />} onClick={() => ws.goTab("scene")}>
            {t("前往場景與候選")}
          </Button>
        </div>
      ) : null}
      {caption ? (
        <Disclosure summary={t("視覺模型的原始描述（caption）")}>
          <pre className="max-h-64 overflow-auto rounded-lg border border-line-subtle bg-sunken px-3 py-2 font-mono text-caption whitespace-pre-wrap text-fg-secondary [overflow-wrap:anywhere]">{caption.caption}</pre>
        </Disclosure>
      ) : null}
      {version ? (
        <p className="text-caption text-fg-tertiary">
          {t("觀察 {observationsCount} 筆（{filterCount} 筆不確定）· 不確定項目 {uncertainty_notesCount} 項。", { observationsCount: version.scene.observations.length, filterCount: version.scene.observations.filter((item) => item.certainty === "uncertain").length, uncertainty_notesCount: version.scene.uncertainty_notes.length })}
        </p>
      ) : null}
    </div>
  );
}

export function SourceCenter({ ws }: { ws: Workspace }) {
  const { study } = ws;
  const task = latestTask(study, "analyze");
  const file = study.source.file;
  const declared = study.source.width && study.source.height ? `${study.source.width}×${study.source.height}` : t("未記錄");
  const hasVersions = study.versions.length > 0;
  return (
    <div className="grid content-start p-5">
      <FlowSection id="prompt-source-title" phase="input" title={t("來源圖片")} lit>
        <SourceFigure ws={ws} />
        <KeyValueList
          dense
          className="max-w-xl"
          items={[
            { key: "name", label: t("檔名"), value: study.source.name || "—" },
            { key: "declared", label: t("尺寸（建立時記錄）"), value: declared, mono: true },
            { key: "size", label: t("尺寸（瀏覽器量測）"), value: ws.sourceSize ? `${ws.sourceSize.width}×${ws.sourceSize.height}` : t("讀取中"), mono: true },
            { key: "type", label: t("媒體類型"), value: file.media_type, mono: true },
            { key: "bytes", label: t("檔案大小"), value: formatBytes(file.size_bytes), mono: true },
            { key: "file", label: "file_id", value: <IdText value={file.file_id} length={12} /> },
            { key: "sha", label: "sha256", value: <IdText value={file.sha256} length={12} /> },
            { key: "node", label: "Node", value: file.node_id, mono: true },
            ...(study.source.library_item ? [{ key: "library", label: t("來自 Studio 素材庫"), value: `${study.source.library_item.project_id} / ${study.source.library_item.item_id}`, mono: true }] : []),
          ]}
        />
      </FlowSection>
      <FlowSection id="prompt-analysis-title" phase="analysis" title={t("分析（視覺模型 → 場景 → 編譯）")} lit={task !== null && task.state !== "failed" && task.state !== "interrupted"}>
        {task ? (
          <AnalysisStatus ws={ws} task={task} />
        ) : hasVersions ? (
          <p className="text-data text-fg-secondary">{t("這個研究的版本不是由本頁的分析任務產生的（例如匯入）；可直接到「場景與候選」編修。")}</p>
        ) : (
          <p className="text-data text-fg-tertiary">{t("還沒有分析：在檢視器選擇視覺模型與編譯元件後按「分析原圖」。分析不會自動生成圖片。")}</p>
        )}
      </FlowSection>
      <FlowSection id="prompt-analysis-result-title" phase="result" title={t("版本與描述")} lit={hasVersions} last>
        {task ? (
          <AnalysisResult ws={ws} task={task} />
        ) : hasVersions ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-data text-fg-secondary">{t("這個研究已有 {versionsCount} 個版本。", { versionsCount: study.versions.length })}</span>
            <Button size="sm" icon={<ArrowRight aria-hidden />} onClick={() => ws.goTab("scene")}>
              {t("前往場景與候選")}
            </Button>
          </div>
        ) : (
          <p className="text-data text-fg-tertiary">{t("還沒有結果：分析完成後，版本與模型的描述會出現在這裡。")}</p>
        )}
      </FlowSection>
    </div>
  );
}

function TitleField({ ws }: { ws: Workspace }) {
  const [draft, setDraft] = useState<{ base: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = ws.study.title;
  const text = draft && draft.base === base ? draft.text : base;
  const commit = async () => {
    const next = text.trim();
    if (!draft || next === base) {
      setDraft(null);
      return;
    }
    if (next.length > LIMITS.title) {
      setError(t("名稱最多 {title} 字", { title: LIMITS.title }));
      return;
    }
    try {
      await ws.doc.update((study) => ({ ...study, title: next || t("未命名研究") }));
      setDraft(null);
      setError(null);
    } catch {
      setError(t("名稱沒有保存（錯誤在頁首）"));
    }
  };
  return (
    <div className="grid gap-1">
      <Input
        id="prompt-study-title"
        compact
        value={text}
        readOnly={ws.readOnly}
        maxLength={LIMITS.title}
        aria-invalid={error ? true : undefined}
        onChange={(event) => setDraft({ base, text: event.target.value })}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void commit();
          } else if (event.key === "Escape") {
            setDraft(null);
            setError(null);
          }
        }}
      />
      {error ? <span className="text-caption text-danger">{error}</span> : null}
    </div>
  );
}

export function SourceInspector({ ws }: { ws: Workspace }) {
  const { study, runner } = ws;
  const task = latestTask(study, "analyze");
  const openAnalyze = ws.open?.kind === "analyze" ? ws.open : null;
  const block = analyzeBlock({ study, busy: runner.state.busy, vision: ws.chosen.vision, compile: ws.chosen.compile });
  const start = () => {
    const created = newTask({ request: { kind: "analyze" }, baseVersionId: null, now: new Date().toISOString() });
    void runner.start(created, { mode: "loop", rounds: "all" }, ws.persistSettings());
  };
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <EntityHeader
        icon={ScanSearch}
        tone="info"
        title={t("分析原圖")}
        status={<TaskStateChip task={task} />}
        description={t("qimg.vision：描述（caption）→ 分析 8 區段場景（觀察與證據）→ prompt.scene_compile 編譯候選")}
        id={task?.task_id ?? null}
      />
      <DockBody>
        <PropertySection title={t("元件")} icon={<Settings2 aria-hidden />}>
          <div className="grid gap-3">
            {(["vision", "compile"] as const).map((role) => (
              <ComponentSelect
                key={role}
                id={`prompt-source-${role}`}
                label={ROLE_LABELS[role]}
                providerId={ROLE_PROVIDER[role]}
                choices={ws.choices[role]}
                value={ws.chosen[role]}
                onChange={(key) => ws.setComponent(role, key)}
                loading={ws.catalogLoading}
                disabled={runner.state.busy}
              />
            ))}
            <p className="text-caption text-fg-tertiary">{t("模型大小（4B／8B／32B）由元件的 model_path 設定決定；不會自動換模型或降精度。")}</p>
          </div>
        </PropertySection>
        <PropertySection title={t("研究")}>
          <PropertyGrid>
            <PropertyRow label={t("名稱")} htmlFor="prompt-study-title">
              <TitleField ws={ws} />
            </PropertyRow>
            <PropertyRow label={t("Prompt 語言")} hint={t("建立時決定；換語言請建立新研究")}>
              {LANGUAGE_LABELS[study.language]}
            </PropertyRow>
            <PropertyRow label={t("局部觀察")}>{study.crops.length === 0 ? <span className="text-fg-tertiary">{t("只有全圖")}</span> : <span className="machine">{study.crops.map((crop) => `${crop.view_id} (${crop.x0},${crop.y0})–(${crop.x1},${crop.y1})`).join(t("；"))}</span>}</PropertyRow>
            <PropertyRow label={t("建立")}>
              <TimeText iso={study.created_at} />
            </PropertyRow>
            <PropertyRow label={t("更新")}>
              <TimeText iso={study.updated_at} />
            </PropertyRow>
            <PropertyRow label="revision" mono>
              {study.revision}
            </PropertyRow>
          </PropertyGrid>
        </PropertySection>
      </DockBody>
      <InspectorFooter note={openAnalyze ? t("分析由本頁逐步推進；離開頁面不會取消已送出的 run，回來後繼續會先讀回結果。") : t("分析只呼叫視覺模型與編譯元件，不會生成圖片。")}>
        {openAnalyze ? (
          <TaskControls study={study} task={openAnalyze} runner={runner} />
        ) : (
          <ActionButton variant="primary" size="sm" icon={<ScanSearch aria-hidden />} disabledReason={block} onClick={start}>
            {t("分析原圖")}
          </ActionButton>
        )}
      </InspectorFooter>
    </div>
  );
}
