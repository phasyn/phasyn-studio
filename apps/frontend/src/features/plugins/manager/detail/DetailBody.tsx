// 詳情的標題與四個分頁（概覽、內容、權限、檔案與版本）：已安裝的包與安裝預覽共用同一套，預覽時多一行「安裝預覽」、
// 內容不能在專案選用、檔案只列出。分頁列是 44 px；選到的分頁會記住。
import { FolderTree, Info, KeyRound, LayoutList } from "lucide-react";
import type { ReactNode } from "react";
import type { StudioPlugin, StudioPluginDetail } from "@/api/generated/contracts";
import { PanelTabs } from "@/components/workbench/PanelTabs";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { pluginName } from "../../model/evaluate";
import { issueText } from "../../model/issues";
import { statusWord } from "../../model/listing";
import { PluginTile } from "../../parts/kinds";
import { ContentsTab } from "./ContentsTab";
import { isDetailTab, type DetailTab } from "./detailTab";
import { FilesTab, type DetailState } from "./FilesTab";
import { OverviewTab } from "./OverviewTab";
import { PermissionsTab } from "./PermissionsTab";

const ID_PREFIX = "plugin-detail";
const STATUS_TONE = { neutral: "text-fg-secondary", warning: "text-warning", danger: "text-danger" } as const;

function contentCount(plugin: StudioPlugin): number {
  const { rules, presets, generation, commands, panels } = plugin.contributes;
  return rules.length + presets.length + generation.length + commands.length + panels.length;
}

/** 狀態詞加上第一個原因（「不相容：這個版本還不能執行程式碼」）；一切正常時不顯示。 */
function StatusLine({ plugin }: { plugin: StudioPlugin }) {
  const status = statusWord(plugin);
  if (!status) return null;
  const first = plugin.problems[0];
  const text = first ? t("{word}：{reason}", { word: status.word, reason: issueText(first) }) : status.word;
  return (
    <p title={text} className={cn("truncate text-data font-medium", STATUS_TONE[status.tone])}>
      {text}
    </p>
  );
}

export function DetailHeader({ plugin, eyebrow, version, actions }: { plugin: StudioPlugin; eyebrow?: string; version?: ReactNode; actions: ReactNode }) {
  const name = pluginName(plugin);
  return (
    <header className="grid shrink-0 gap-3 border-b border-line-subtle px-4 pt-4 pb-3">
      <div className="flex min-w-0 items-start gap-3">
        <PluginTile plugin={plugin} size="lg" />
        <div className="grid min-w-0 flex-1 gap-0.5">
          {eyebrow ? <p className="text-caption font-semibold text-brand-cyan">{eyebrow}</p> : null}
          <div className="flex min-w-0 items-baseline gap-2">
            <h3 title={name} className="min-w-0 truncate text-section font-semibold text-fg">
              {name}
            </h3>
            <span className="machine shrink-0 text-data text-fg-secondary">{version ?? plugin.version ?? ""}</span>
          </div>
          <p title={plugin.plugin_id} className="machine truncate text-caption text-fg-tertiary">
            {plugin.plugin_id}
          </p>
          <StatusLine plugin={plugin} />
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>
    </header>
  );
}

export interface DetailBodyProps {
  plugin: StudioPlugin;
  tab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
  /** 完整內容（manifest、檔案、同意紀錄）；還在讀取時為 null。 */
  detail: StudioPluginDetail | null;
  state: DetailState | null;
  /** 安裝預覽：還沒安裝。 */
  preview: boolean;
  /** 預覽時相對於目前安裝的版本多出來的權限。 */
  permissionsAdded?: readonly string[];
}

const NO_PERMISSIONS: readonly string[] = [];

export function DetailBody({ plugin, tab, onTabChange, detail, state, preview, permissionsAdded = NO_PERMISSIONS }: DetailBodyProps) {
  return (
    <>
      <PanelTabs
        variant="underline"
        idPrefix={ID_PREFIX}
        label={t("插件詳情")}
        value={tab}
        onChange={(next) => onTabChange(isDetailTab(next) ? next : "overview")}
        tabs={[
          { id: "overview", label: t("概覽"), icon: Info },
          { id: "contents", label: t("內容"), icon: LayoutList, count: contentCount(plugin) || undefined },
          { id: "permissions", label: t("權限"), icon: KeyRound, count: plugin.permissions.length || undefined },
          { id: "files", label: t("檔案與版本"), icon: FolderTree },
        ]}
      />
      <div role="tabpanel" id={`${ID_PREFIX}-panel-${tab}`} aria-labelledby={`${ID_PREFIX}-tab-${tab}`} className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === "overview" ? <OverviewTab plugin={plugin} preview={preview} /> : null}
        {tab === "contents" ? <ContentsTab plugin={plugin} preview={preview} /> : null}
        {tab === "permissions" ? <PermissionsTab plugin={plugin} consent={preview ? null : detail?.consent} added={permissionsAdded} /> : null}
        {tab === "files" ? <FilesTab plugin={plugin} detail={detail} state={state} preview={preview} /> : null}
      </div>
    </>
  );
}
