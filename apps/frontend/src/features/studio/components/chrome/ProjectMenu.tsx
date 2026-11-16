// Video Studio's project menu: the shell's project switcher, then the current project's settings and a new-project
// form that also picks the video format. The same form is the project home's "new project" panel.
import { useId, useState } from "react";
import { FolderPlus, Keyboard, Puzzle, Replace } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { useNavigate, useSearchParams } from "react-router";
import { useStableCatalog } from "@/api/catalog";
import type { StudioProjectSummary } from "@/api/generated/contracts";
import { usePipelines } from "@/api/pipelines";
import { openPluginManager, PluginManagerHost } from "@/features/plugins";
import { NewProjectForm, ProjectSwitcher, type NewProjectFormProps } from "@/features/studio-shell";
import { formatTimestamp } from "@/lib/format";
import { FORMAT_PRESETS, newProject } from "../../model/project";
import { deriveStudioRoutes, pickDefaultRoute } from "../../model/routes";
import { useStudio } from "../../studioContext";
import { projectHref } from "../../workspaces";
import { ExportDialog } from "../ExportDialog";
import { FormatPicker } from "../FormatPicker";
import { ProjectSettings } from "../ProjectSettings";
import { openShortcuts } from "../../model/shortcuts";
import { SWAP_URL_PARAM } from "../../swap/job";
import { t } from "@/i18n";

export function VideoProjectForm({ onCreated, initialFocus }: { onCreated: (projectId: string) => void; initialFocus?: NewProjectFormProps["initialFocus"] }) {
  const pipelines = usePipelines();
  const catalog = useStableCatalog();
  const formatId = useId();
  const [size, setSize] = useState(() => ({ width: FORMAT_PRESETS[0]?.width ?? 768, height: FORMAT_PRESETS[0]?.height ?? 448 }));
  const build = (title: string) => {
    // 新專案的預設路由：文字生成（t2va）優先、就緒優先；還讀不到元件組合時是「未指定」，之後在鏡頭的「生成」分頁選擇
    const route = pickDefaultRoute(deriveStudioRoutes(pipelines.data?.items, catalog.data))?.id;
    return newProject(title, { width: size.width, height: size.height, route });
  };
  return (
    <NewProjectForm build={build} onCreated={onCreated} initialFocus={initialFocus} placeholder={t("例如：海岸短片")}>
      <div className="grid gap-1">
        <label htmlFor={formatId} className="text-caption font-medium text-fg-secondary">
          {t("畫面格式")}
        </label>
        <FormatPicker id={formatId} compact={false} width={size.width} height={size.height} onChange={(width, height) => setSize({ width, height })} />
      </div>
    </NewProjectForm>
  );
}

const NO_PLUGIN_REFS: readonly string[] = [];

const projectMeta = (item: StudioProjectSummary) =>
  t("{shot_count} 個鏡頭・已渲染 {rendered_shot_count}・{updated_at}", { shot_count: item.shot_count, rendered_shot_count: item.rendered_shot_count, updated_at: formatTimestamp(item.updated_at) });

/** 新增專案：先選類型——一般專案（名稱與畫面格式）或一鍵換角專案（開啟換角精靈，完成後建立新專案）。 */
function NewProjectChooser({ onCreated, onSwap }: { onCreated: (projectId: string) => void; onSwap: () => void }) {
  const [kind, setKind] = useState<"plain" | "swap">("plain");
  const options = [
    { id: "plain" as const, icon: FolderPlus, label: t("一般專案"), hint: t("自己寫鏡頭的 prompt、渲染並剪輯。") },
    { id: "swap" as const, icon: Replace, label: t("一鍵換角專案"), hint: t("上傳一段影片，依切鏡自動分段，把片中的角色換成你的角色圖並接成一支影片。") },
  ];
  return (
    <div className="grid gap-4">
      <div role="radiogroup" aria-label={t("專案類型")} className="grid gap-2 sm:grid-cols-2">
        {options.map((item) => (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={kind === item.id}
            onClick={() => setKind(item.id)}
            className={cn(
              "pressable grid content-start gap-1.5 rounded-xl border p-3 text-left transition-colors duration-(--duration-fast)",
              kind === item.id ? "border-brand-blue/60 bg-brand-gradient-soft shadow-glow-sm" : "border-line-subtle hover:border-line-strong hover:bg-raised/60",
            )}
          >
            <span className="flex items-center gap-2 text-body font-semibold text-fg">
              <item.icon aria-hidden className="size-4 text-brand-cyan" />
              {item.label}
            </span>
            <span className="text-caption text-fg-tertiary">{item.hint}</span>
          </button>
        ))}
      </div>
      {kind === "plain" ? (
        <VideoProjectForm onCreated={onCreated} />
      ) : (
        <Button variant="primary" icon={<Replace aria-hidden />} onClick={onSwap}>
          {t("開始設定一鍵換角")}
        </Button>
      )}
    </div>
  );
}

function ProjectManager({ workspace }: { workspace: string }) {
  const navigate = useNavigate();
  const [, setParams] = useSearchParams();
  const { project } = useStudio();
  const open = (projectId: string) => void navigate(projectHref(workspace, projectId));
  return (
    <ProjectSwitcher
      description={t("每個專案是一組鏡頭與一條時間軸，保存在主控上（不同瀏覽器看到的是同一份）。")}
      // The pill truncates a long title (the toolbar is shared with the workspace tabs): the tooltip gives it in full
      hint={t("{title}\n切換專案、修改目前專案的設定或新增專案", { title: project.title })}
      metaOf={projectMeta}
      onSelect={open}
      renderDetails={(_item, current, close) =>
        current ? (
          <>
            {/* 目前專案的動作：匯出成片與鍵盤快速鍵（時間軸工具列不再放這些按鈕） */}
            <div className="flex flex-wrap items-center gap-2">
              <ExportDialog />
              <Button
                size="sm"
                variant="secondary"
                icon={<Keyboard aria-hidden />}
                onClick={() => {
                  close();
                  openShortcuts();
                }}
              >
                {t("鍵盤快速鍵")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                icon={<Puzzle aria-hidden />}
                onClick={() => {
                  close();
                  openPluginManager({ tab: "project" });
                }}
              >
                {t("插件管理…")}
              </Button>
            </div>
            <ProjectSettings onNavigate={close} />
          </>
        ) : null
      }
      renderCreate={(close) => (
        <NewProjectChooser
          onCreated={(projectId) => {
            close();
            open(projectId);
          }}
          onSwap={() => {
            close();
            setParams(
              (current) => {
                const out = new URLSearchParams(current);
                out.set(SWAP_URL_PARAM, "1");
                return out;
              },
              { replace: true },
            );
          }}
        />
      )}
    />
  );
}

/** 插件管理視窗接到這個專案：它選用的插件項目存在專案文件（prompt_plugins），在視窗裡的變更是一般的專案編輯。 */
function ProjectPluginManager() {
  const { project, dispatch, notify } = useStudio();
  return (
    <PluginManagerHost
      onNotice={(tone, title) => notify({ tone, title })}
      project={{
        projectId: project.project_id,
        title: project.title,
        refs: project.prompt_plugins ?? NO_PLUGIN_REFS,
        onRefsChange: (plugins) => dispatch({ type: "setPromptPlugins", plugins }),
      }}
    />
  );
}

/**
 * 工具列上的專案管理員。插件管理視窗也掛在這裡一次（工具列每個工作區都在）：專案管理員的「插件管理…」與鏡頭「插件」
 * 分頁的「管理插件…」都開啟它。
 */
export function ProjectMenu({ workspace }: { workspace: string }) {
  return (
    <>
      <ProjectManager workspace={workspace} />
      <ProjectPluginManager />
    </>
  );
}
