// 已安裝的包的詳情：標題列的動作（在這個專案啟用或停用、匯出、⋯ 選單裡的停用插件、重新載入、移除）與四個分頁。
// 「在這個專案啟用」只改這個專案選用的貢獻（專案文件）；「停用插件」是整個安裝，停用後所有專案都不能套用它的內容。
// 已停用的包主要動作是「啟用插件」。內建與開發目錄的包不能停用或移除，選單裡說明原因。
import { CircleCheck, CircleMinus, Download, Ellipsis, ListChecks, MousePointerClick, Power, PowerOff, RefreshCw, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import type { StudioPlugin } from "@/api/generated/contracts";
import { usePluginDetail } from "@/api/plugins";
import { ActionButton } from "@/components/common/ActionButton";
import { ActionMenu, MenuTriggerButton } from "@/components/ui/action-menu";
import type { MenuItem } from "@/components/ui/menuModel";
import { t } from "@/i18n";
import { pluginName } from "../../model/evaluate";
import { pluginRefs, pluginUsable, refsOfPlugin } from "../../model/registry";
import { enablePluginPlan, presetPlan, withoutPlugin } from "../../model/selection";
import { pluginText } from "../../model/text";
import { useSlideIn } from "../../parts/motion";
import { useManager, type ManagerValue, type PluginProjectBinding } from "../managerContext";
import { usePluginActions, type PluginActions } from "../usePluginActions";
import { DetailBody, DetailHeader } from "./DetailBody";
import { useDetailTab } from "./detailTab";

interface Menu {
  element: HTMLButtonElement;
  focus: "first" | "last";
}

function sourceRefusal(plugin: StudioPlugin, action: "disable" | "remove"): string | null {
  if (plugin.source === "builtin") return action === "disable" ? t("內建插件不能停用") : t("內建插件不能移除");
  if (plugin.source === "dev") return action === "disable" ? t("開發目錄的插件由設定檔管理，不能停用") : t("開發目錄的插件由設定檔管理，不能經 API 移除");
  return null;
}

/** 在這個專案啟用：只有一個貢獻時直接啟用；有好幾個時讓使用者選推薦組合、全部或逐項。 */
function enableItems(plugin: StudioPlugin, manager: ManagerValue, project: PluginProjectBinding, onPickItems: () => void): MenuItem[] {
  const { registry, notify } = manager;
  const name = pluginName(plugin);
  const all = enablePluginPlan(registry, project.refs, plugin);
  const presets: MenuItem[] = plugin.contributes.presets.map((entry) => {
    const label = pluginText(entry.preset.label, entry.preset.id);
    const plan = presetPlan(registry, project.refs, { key: entry.preset.id, preset: entry.preset, refs: entry.refs, plugin });
    return {
      id: `preset:${entry.preset.id}`,
      label: t("套用推薦組合「{label}」", { label }),
      icon: ListChecks,
      disabledReason: plan.reason,
      onSelect: () => {
        project.onRefsChange(plan.refs);
        notify("success", t("這個專案已套用「{label}」", { label }));
      },
    };
  });
  return [
    ...presets,
    {
      id: "all",
      label: t("啟用可以同時使用的 {count} 項", { count: all.added.length }),
      icon: CircleCheck,
      separatorBefore: presets.length > 0,
      disabledReason: all.added.length === 0 ? t("沒有可以加入的項目（同一組已經選了別的，或已達上限）") : null,
      onSelect: () => {
        project.onRefsChange(all.refs);
        notify("success", t("這個專案已啟用「{name}」的 {count} 項", { name, count: all.added.length }));
      },
    },
    { id: "pick", label: t("逐項選擇…"), icon: MousePointerClick, onSelect: onPickItems },
  ];
}

function ProjectAction({ plugin, onPickItems }: { plugin: StudioPlugin; onPickItems: () => void }) {
  const manager = useManager();
  const { registry, project, notify } = manager;
  const menuId = useId();
  const [menu, setMenu] = useState<Menu | null>(null);
  if (!project) return null;
  const name = pluginName(plugin);
  const used = refsOfPlugin(plugin, project.refs);
  if (used.length > 0) {
    return (
      <ActionButton
        variant="secondary"
        icon={<CircleMinus aria-hidden />}
        title={t("把「{name}」的 {count} 個項目從這個專案拿掉", { name, count: used.length })}
        onClick={() => {
          project.onRefsChange(withoutPlugin(plugin, project.refs));
          notify("success", t("這個專案已停用「{name}」", { name }));
        }}
      >
        {t("在這個專案停用")}
      </ActionButton>
    );
  }
  const selectable = pluginRefs(plugin);
  const blocked = !pluginUsable(plugin) ? t("這個包目前不能使用") : selectable.length === 0 ? t("這個包沒有可以在專案選用的內容") : null;
  const single = selectable.length === 1 ? enablePluginPlan(registry, project.refs, plugin) : null;
  const singleBlocked = single?.added.length === 0 ? t("現在加不進去（同一組已經選了別的，或已達上限）") : null;
  return (
    <>
      <ActionButton
        variant="primary"
        icon={<CircleCheck aria-hidden />}
        aria-haspopup={single ? undefined : "menu"}
        aria-expanded={single ? undefined : menu !== null}
        aria-controls={menu ? menuId : undefined}
        disabledReason={blocked ?? singleBlocked}
        onClick={(event) => {
          if (single) {
            project.onRefsChange(single.refs);
            notify("success", t("這個專案已啟用「{name}」", { name }));
          } else setMenu(menu ? null : { element: event.currentTarget, focus: "first" });
        }}
      >
        {t("在這個專案啟用")}
      </ActionButton>
      {menu ? (
        <ActionMenu
          id={menuId}
          label={t("在這個專案啟用「{name}」", { name })}
          items={enableItems(plugin, manager, project, onPickItems)}
          anchor={{ kind: "element", element: menu.element }}
          returnFocus={menu.element}
          initialFocus={menu.focus}
          onClose={() => { setMenu(null); }}
        />
      ) : null}
    </>
  );
}

function moreItems(plugin: StudioPlugin, manager: ManagerValue, actions: PluginActions): MenuItem[] {
  const items: MenuItem[] = [];
  if (!plugin.disabled) {
    items.push({
      id: "disable",
      label: t("停用插件"),
      icon: PowerOff,
      disabledReason: sourceRefusal(plugin, "disable"),
      onSelect: () => { actions.setDisabled(plugin, true); },
    });
  }
  if (plugin.source === "dev") items.push({ id: "reload", label: t("重新載入"), icon: RefreshCw, onSelect: () => { actions.reload(plugin); } });
  items.push({
    id: "remove",
    label: t("移除…"),
    icon: Trash2,
    tone: "danger",
    separatorBefore: items.length > 0,
    disabledReason: sourceRefusal(plugin, "remove") ?? (manager.registry.list?.install === "disabled" ? t("設定檔關閉了經 API 安裝與移除插件") : null),
    onSelect: () => { manager.requestRemove(plugin.plugin_id); },
  });
  return items;
}

function MoreMenu({ plugin, actions }: { plugin: StudioPlugin; actions: PluginActions }) {
  const manager = useManager();
  const menuId = useId();
  const [menu, setMenu] = useState<Menu | null>(null);
  return (
    <>
      <MenuTriggerButton
        menuId={menuId}
        open={menu !== null}
        label={t("更多動作")}
        onOpen={(element, focus) => { setMenu({ element, focus }); }}
        onClose={() => { setMenu(null); }}
        className="size-10 border border-line-strong bg-raised text-fg-secondary shadow-edge [&_svg]:size-4"
      >
        <Ellipsis aria-hidden />
      </MenuTriggerButton>
      {menu ? (
        <ActionMenu
          id={menuId}
          label={t("「{name}」的動作", { name: pluginName(plugin) })}
          items={moreItems(plugin, manager, actions)}
          anchor={{ kind: "element", element: menu.element }}
          returnFocus={menu.element}
          initialFocus={menu.focus}
          onClose={() => { setMenu(null); }}
        />
      ) : null}
    </>
  );
}

export function PluginDetail({ plugin }: { plugin: StudioPlugin }) {
  const actions = usePluginActions();
  const [tab, setTab] = useDetailTab();
  const query = usePluginDetail(plugin.plugin_id, `${plugin.digest ?? ""}:${String(plugin.revision)}`);
  const slideIn = useSlideIn<HTMLDivElement>();
  // 登錄表剛換了內容（更新、重新載入）而詳情還是舊的：等新的讀到再顯示
  const detail = query.data?.plugin.digest === plugin.digest ? query.data : null;
  const state = { pending: query.isPending, error: query.error, retrying: query.isFetching, retry: () => void query.refetch() };
  return (
    <div ref={slideIn} className="flex min-h-0 flex-1 flex-col">
      <DetailHeader
        plugin={plugin}
        actions={
          <>
            {plugin.status === "disabled" ? (
              <ActionButton variant="primary" icon={<Power aria-hidden />} pending={actions.pending.toggle} onClick={() => { actions.setDisabled(plugin, false); }}>
                {t("啟用插件")}
              </ActionButton>
            ) : (
              <ProjectAction plugin={plugin} onPickItems={() => { setTab("contents"); }} />
            )}
            <ActionButton
              variant="secondary"
              icon={<Download aria-hidden />}
              pending={actions.pending.export}
              disabledReason={plugin.status === "invalid" ? t("內容讀不到，無法匯出") : null}
              onClick={() => { actions.exportPackage(plugin); }}
            >
              {t("匯出")}
            </ActionButton>
            <MoreMenu plugin={plugin} actions={actions} />
          </>
        }
      />
      <DetailBody plugin={plugin} tab={tab} onTabChange={setTab} detail={detail} state={state} preview={false} />
    </div>
  );
}
