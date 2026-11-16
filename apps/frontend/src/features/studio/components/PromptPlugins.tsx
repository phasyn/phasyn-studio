// 鏡頭屬性面板裡的插件：「插件」分頁只負責「使用」——專案套用中的插件項目（大膠囊，可移除）、加入選單、一鍵套用的
// 推薦組合、這個鏡頭的 prompt 對這些規則的檢查結果，以及開啟插件管理視窗的大按鈕。安裝、檢視內容、匯出與移除都在
// 插件管理視窗（@/features/plugins）。Prompt 分頁上方只留檢查結果，寫 prompt 時看得到哪裡不符合。
// 專案選用的項目存在專案文件（prompt_plugins），所以這裡的每個變更都是一般的專案編輯。
import { SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import type { StudioShot } from "@/api/generated/contracts";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ActiveChips,
  AddMenu,
  ApplyDefaultsDialog,
  checkGeneration,
  evaluateSelection,
  generationDefaults,
  ManagePluginsButton,
  openPluginManager,
  pluginText,
  PresetButtons,
  RegistryNotice,
  resolveSelection,
  selectedItems,
  ValidationList,
  withoutRef,
  type GenerationTarget,
  type RegistryGeneration,
  type ShotGenerationValues,
} from "@/features/plugins";
import { t } from "@/i18n";
import { useProjectLanes } from "../model/lanePrefs";
import { laneRouteFor } from "../model/lanes";
import { generationActuals } from "../model/promptPlugins";
import { findRoute } from "../model/routes";
import { useStudio } from "../studioContext";

const NO_REFS: readonly string[] = [];

/** 這個鏡頭對專案插件的檢查結果（與送出渲染前同一套判斷：同一份登錄表、同一條路由）。 */
function useShotCheck(shot: StudioShot) {
  const { project, plugins, engine } = useStudio();
  const lanes = useProjectLanes(project.project_id);
  return useMemo(() => {
    const selection = resolveSelection(plugins, project.prompt_plugins);
    const route = findRoute(engine.routes, laneRouteFor(engine.routes, lanes, shot));
    return {
      selection,
      evaluation: evaluateSelection(selection, shot.prompt),
      generation: checkGeneration(selection.generation, generationActuals({ project, shot, route })),
    };
  }, [plugins, project, shot, engine.routes, lanes]);
}

function shotValues(shot: StudioShot): ShotGenerationValues {
  return { id: shot.shot_id, title: shot.title || shot.shot_id, frames: shot.frames, steps: shot.steps, video_shift: shot.video_shift, audio_shift: shot.audio_shift };
}

/** 套用生成設定的預設值時，專案目前的值與寫入的方法。 */
function useGenerationTarget(shot: StudioShot): GenerationTarget {
  const { project, dispatch } = useStudio();
  return {
    format: { width: project.format.width, height: project.format.height },
    defaults: { frames: project.defaults.frames, steps: project.defaults.steps },
    shot: shotValues(shot),
    shots: project.shots.map(shotValues),
    apply: (values, scope) => {
      const { format, frames, steps, video_shift, audio_shift } = values;
      if (format) dispatch({ type: "setFormat", width: format.width, height: format.height });
      if (frames !== undefined || steps !== undefined) dispatch({ type: "setDefaults", patch: { ...(frames === undefined ? {} : { frames }), ...(steps === undefined ? {} : { steps }) } });
      const patch = {
        ...(frames === undefined ? {} : { frames }),
        ...(steps === undefined ? {} : { steps }),
        ...(video_shift === undefined ? {} : { video_shift }),
        ...(audio_shift === undefined ? {} : { audio_shift }),
      };
      if (Object.keys(patch).length === 0) return;
      for (const target of scope === "all" ? project.shots : [shot]) dispatch({ type: "updateShot", shotId: target.shot_id, patch });
    },
  };
}

/** 套用中的生成設定裡有預設值的：一顆按鈕開啟「目前 → 套用後」的確認。 */
function DefaultsButtons({ entries, onPick }: { entries: readonly RegistryGeneration[]; onPick: (entry: RegistryGeneration) => void }) {
  const withDefaults = entries.filter((entry) => generationDefaults(entry.generation).length > 0);
  if (withDefaults.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {withDefaults.map((entry) => (
        <Button key={entry.ref} size="sm" variant="secondary" icon={<SlidersHorizontal aria-hidden />} onClick={() => onPick(entry)} className="max-w-full min-w-0">
          <span className="truncate">{t("套用「{label}」的設定…", { label: pluginText(entry.generation.label, entry.ref) })}</span>
        </Button>
      ))}
    </div>
  );
}

/** 鏡頭「插件」分頁。 */
export function ShotPlugins({ shot }: { shot: StudioShot }) {
  const { project, dispatch, plugins, notify } = useStudio();
  const check = useShotCheck(shot);
  const target = useGenerationTarget(shot);
  // 只記引用：確認框開著時登錄表換了內容，看到的仍是現在的定義；每次開啟都是新的確認框（範圍回到「這個鏡頭」）
  const [applyingRef, setApplyingRef] = useState<string | null>(null);
  const applying = applyingRef === null ? null : (plugins.generation.get(applyingRef) ?? null);
  const refs = project.prompt_plugins ?? NO_REFS;
  const limit = plugins.list?.limits.max_project_plugins ?? null;
  const setRefs = (next: string[]) => dispatch({ type: "setPromptPlugins", plugins: next });
  const loading = plugins.status === "loading";
  return (
    <div className="grid content-start gap-4 p-3">
      <ManagePluginsButton registry={plugins} />

      <section aria-label={t("套用中的插件項目")} className="grid gap-2">
        <div className="flex min-h-8 items-center gap-2">
          <h3 className="text-data font-semibold text-fg-secondary">{t("套用中")}</h3>
          <span className="machine text-caption text-fg-tertiary" title={limit === null ? undefined : t("一個專案最多選 {limit} 個插件項目", { limit })}>
            {limit === null ? refs.length : t("{count} / {limit}", { count: refs.length, limit })}
          </span>
          <span className="ml-auto">
            <AddMenu registry={plugins} refs={refs} onChange={setRefs} disabledReason={plugins.status === "ready" ? null : t("插件登錄表還沒讀到")} />
          </span>
        </div>
        {loading && refs.length > 0 ? (
          <div role="status" aria-label={t("讀取插件登錄表…")} className="flex flex-wrap gap-1.5">
            {refs.map((ref) => (
              <Skeleton key={ref} className="h-9 w-32 rounded-full" />
            ))}
          </div>
        ) : (
          <ActiveChips items={selectedItems(plugins, refs)} onOpen={(ref) => openPluginManager({ ref })} onRemove={(ref) => setRefs(withoutRef(refs, ref))} />
        )}
        {refs.length === 0 ? <p className="text-data text-fg-tertiary">{t("這個專案還沒有使用插件項目")}</p> : null}
      </section>

      {plugins.presets.length > 0 ? (
        <section aria-label={t("推薦組合")} className="grid gap-2">
          <h3 className="text-data font-semibold text-fg-secondary">{t("推薦組合")}</h3>
          <PresetButtons registry={plugins} refs={refs} onChange={setRefs} />
        </section>
      ) : null}

      {refs.length > 0 && !loading ? (
        <section aria-label={t("這個鏡頭的檢查結果")} className="grid gap-2">
          <h3 className="text-data font-semibold text-fg-secondary">{t("這個鏡頭")}</h3>
          <ValidationList evaluation={check.evaluation} generation={check.generation} activeCount={refs.length} />
          <DefaultsButtons entries={check.selection.generation} onPick={(entry) => setApplyingRef(entry.ref)} />
        </section>
      ) : null}

      <RegistryNotice registry={plugins} />

      <ApplyDefaultsDialog
        key={applyingRef ?? "closed"}
        entry={applying}
        target={{
          ...target,
          apply: (values, scope) => {
            target.apply(values, scope);
            if (applying) notify({ tone: "success", title: t("已套用「{label}」的設定", { label: pluginText(applying.generation.label, applying.ref) }) });
          },
        }}
        onClose={() => setApplyingRef(null)}
      />
    </div>
  );
}

/** Prompt 分頁上方：這個鏡頭的 prompt 對專案插件的檢查結果（專案沒有選用插件時不顯示）。 */
export function PromptPluginStatus({ shot }: { shot: StudioShot }) {
  const { project, plugins } = useStudio();
  const check = useShotCheck(shot);
  const count = project.prompt_plugins?.length ?? 0;
  // 登錄表還在讀取時先不下結論（讀到之後才知道符不符合）
  if (count === 0 || plugins.status === "loading") return null;
  return <ValidationList evaluation={check.evaluation} generation={check.generation} activeCount={count} />;
}
