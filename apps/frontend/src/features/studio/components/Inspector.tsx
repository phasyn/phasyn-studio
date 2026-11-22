// 屬性面板（選取的鏡頭）：四個分頁，每個分頁是一個畫面——Prompt（名稱、編輯器與生成列；插件檢查是編輯器工具列上的
// 徽章，整個分頁只有 prompt 本身捲動）、參考（參考素材）、插件（專案的插件項目）、備註。Ctrl+Enter 在面板裡任何地方都會
// 渲染這個鏡頭（「渲染鏡頭」按鈕的提示寫著這個快捷鍵）。
// 外觀（Phasyn）：浮動的主要面板；表單維持俐落（不發光）；換鏡頭時內容從右側滑入（smooth 彈簧），換分頁時內容淡入。
import { Images, NotebookPen, PenLine, Plus, Puzzle } from "lucide-react";
import { useCallback, type KeyboardEvent } from "react";
import type { StudioShot } from "@/api/generated/contracts";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { PANEL_RAISED } from "@/components/ui/look";
import { playMotion, usePanelEnter } from "@/components/ui/motion";
import { PanelTabs } from "@/components/workbench/PanelTabs";
import { PanelCollapseButton } from "@/features/studio-shell";
import { t } from "@/i18n";
import { shortcutRender, useRenderBlock } from "../hooks/useRenderBlock";
import { shotFps } from "../model/promptRules";
import { findRoute } from "../model/routes";
import { insertMentionAt } from "../prompt";
import { ReferencesPanel } from "../references";
import { useStudio } from "../studioContext";
import { isInspectorTab, setInspectorTab, useInspectorTab, type InspectorTab } from "./inspector/inspectorTab";
import { NotesTab } from "./inspector/NotesTab";
import { PromptTab } from "./inspector/PromptTab";
import { referenceUnsupported } from "./inspector/referenceSupport";
import { ShotPlugins } from "./PromptPlugins";

function ReferencesTab({ shot }: { shot: StudioShot }) {
  const { project, dispatch, engine } = useStudio();
  return (
    <div className="grid gap-3 p-3">
      <ReferencesPanel
        projectId={project.project_id}
        shotId={shot.shot_id}
        prompt={shot.prompt}
        durationSeconds={shot.frames / shotFps(findRoute(engine.routes, shot.route), project)}
        library={project.library ?? []}
        references={shot.references ?? []}
        onLibraryChange={(library) => { dispatch({ type: "setLibrary", library }); }}
        onReferencesChange={(references) => { dispatch({ type: "updateShot", shotId: shot.shot_id, patch: { references } }); }}
        onPromptChange={(prompt) => { dispatch({ type: "updateShot", shotId: shot.shot_id, patch: { prompt } }); }}
        onInsertMention={(alias) => { dispatch({ type: "updateShot", shotId: shot.shot_id, patch: { prompt: insertMentionAt(shot.prompt, shot.prompt.length, alias).text } }); }}
        unsupportedReason={referenceUnsupported(engine, shot.route)}
      />
    </div>
  );
}

/** 沒有鏡頭或沒有選取時：說明現況並提供新增鏡頭。 */
function NoShot() {
  const { project, addShot } = useStudio();
  return (
    <EmptyState
      size="compact"
      icon={<PenLine />}
      title={project.shots.length === 0 ? t("這個專案還沒有鏡頭") : t("沒有選取鏡頭")}
      description={t("新增鏡頭後，在這裡寫 prompt、加入參考素材，再按工具列上的「渲染鏡頭」。")}
      action={
        <Button size="sm" variant="secondary" icon={<Plus aria-hidden />} onClick={() => { addShot(); }}>
          {t("新增鏡頭")}
        </Button>
      }
    />
  );
}

function ShotInspector({ shot, tab, onTab }: { shot: StudioShot; tab: InspectorTab; onTab: (tab: InspectorTab) => void }) {
  const { renderShots, busy, notify } = useStudio();
  const block = useRenderBlock(shot);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // A field or dialog inside the panel that used Ctrl+Enter itself (prevented it) keeps it
    if (!(event.ctrlKey || event.metaKey) || event.key !== "Enter" || event.nativeEvent.isComposing || event.defaultPrevented) return;
    event.preventDefault();
    const next = shortcutRender(block, busy);
    if (next.action === "render") void renderShots([shot.shot_id]);
    // A blocked shortcut says why, like the disabled 「渲染鏡頭」 button, instead of silently doing nothing
    else if (next.action === "explain") notify({ tone: "warning", title: t("「{shot}」還不能渲染", { shot: shot.title }), detail: next.reason });
  };
  // 換鏡頭時整個屬性內容重新掛載（key＝鏡頭）：從右側滑入（smooth 彈簧），不硬切；輸入中的鏡頭不會重新掛載
  const slideIn = useCallback((node: HTMLDivElement | null) => {
    if (node) playMotion(node, [{ opacity: 0, transform: "translateX(12px)" }, { opacity: 1, transform: "translateX(0px)" }], { duration: "spring-smooth", easing: "spring-smooth" });
  }, []);
  return (
    <div /* eslint-disable-line jsx-a11y-x/no-static-element-interactions -- Keyboard events from this panel’s focusable controls bubble here so navigation and dismissal share one handler. */  ref={slideIn} className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      {/* Each tab fills the panel; only a window too short for a tab's minimum lets the panel itself scroll */}
      <div role="tabpanel" id={`studio-inspector-panel-${tab}`} aria-labelledby={`studio-inspector-tab-${tab}`} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {tab === "prompt" ? (
          <PromptTab shot={shot} onShowPlugins={() => { onTab("plugins"); }} />
        ) : tab === "references" ? (
          <ReferencesTab shot={shot} />
        ) : tab === "plugins" ? (
          <ShotPlugins shot={shot} />
        ) : (
          <NotesTab shot={shot} />
        )}
      </div>
    </div>
  );
}

export function Inspector({ onCollapse }: { onCollapse?: () => void }) {
  const { project, selectedShotId } = useStudio();
  const tab = useInspectorTab();
  const shot = project.shots.find((item) => item.shot_id === selectedShotId) ?? null;
  // 從窄軌展開時從右緣淡入（label 與 PanelCollapseButton／CollapsedRail 相同）
  const enter = usePanelEnter<HTMLElement>(t("屬性面板"), "right");
  return (
    <section ref={enter} aria-label={t("鏡頭屬性")} className={PANEL_RAISED}>
      <PanelTabs
        variant="studio"
        idPrefix="studio-inspector"
        label={t("鏡頭設定")}
        value={tab}
        onChange={(next) => { setInspectorTab(isInspectorTab(next) ? next : "prompt"); }}
        tabs={[
          { id: "prompt", label: "Prompt", icon: PenLine },
          { id: "references", label: t("參考"), icon: Images, ...((shot?.references?.length != null && Boolean(shot.references.length)) ? { count: shot.references.length } : {}) },
          { id: "plugins", label: t("插件"), icon: Puzzle, ...((project.prompt_plugins?.length != null && Boolean(project.prompt_plugins.length)) ? { count: project.prompt_plugins.length } : {}) },
          { id: "notes", label: t("備註"), icon: NotebookPen },
        ]}
        actions={onCollapse ? <PanelCollapseButton side="right" label={t("屬性面板")} onCollapse={onCollapse} /> : undefined}
      />
      {shot ? (
        <ShotInspector key={shot.shot_id} shot={shot} tab={tab} onTab={setInspectorTab} />
      ) : (
        <div role="tabpanel" id={`studio-inspector-panel-${tab}`} aria-labelledby={`studio-inspector-tab-${tab}`} className="min-h-0 flex-1 overflow-y-auto">
          <NoShot />
        </div>
      )}
    </section>
  );
}
