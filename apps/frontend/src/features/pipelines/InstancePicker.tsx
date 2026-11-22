import { Boxes, Folder, Search, SearchX, Server, Unplug } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { ComponentEntry } from "@/api/catalog";
import { Disclosure } from "@/components/common/Disclosure";
import { EmptyState } from "@/components/common/EmptyState";
import { StatusBadge } from "@/components/common/StatusBadge";
import { SyntheticBadge } from "@/components/common/SyntheticNotice";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/controls";
import { folderOf, usesDefaultFolder, folderDisplayPath } from "@/components/workbench/componentFolders";
import { providerKind } from "@/components/workbench/kinds";
import { TEXT_TONE } from "@/components/workbench/tones";
import { TreeView } from "@/components/workbench/TreeView";
import { branchIds, filterTree } from "@/components/workbench/treeModel";
import { cn } from "@/lib/cn";
import { deviceTag } from "@/lib/deviceTag";
import { compatibleInstances, isTestProvider, libraryEntries, libraryInstanceId, libraryTree, settingsSummary } from "./instancePickerModel";
import { LIFT_CARD, SELECTED_ITEM } from "./presentation";
import { t } from "@/i18n";
import { T } from "@/i18n/T";
import { reveal } from "@/components/ui/motion";

function CandidateRow({
  entry,
  current,
  onChoose,
  buttonRef,
  appear,
}: {
  entry: ComponentEntry;
  current: boolean;
  onChoose: (entry: ComponentEntry) => void;
  buttonRef?: (element: HTMLButtonElement | null) => void;
  /** 清單中的順序（第一次出現時依序淡入）。 */
  appear: number;
}) {
  const d = entry.descriptor;
  const kind = providerKind(d.provider_id);
  const summary = settingsSummary(d);
  const folder = folderOf(d);
  return (
    <li ref={reveal(appear)}>
      <button
        ref={buttonRef}
        type="button"
        aria-pressed={current}
        onClick={() => { onChoose(entry); }}
        title={t("{value}（{component_id}）\n資料夾：{folder}{value2}{value3}", { value: d.label || d.component_id, component_id: d.component_id, folder: folderDisplayPath(folder), value2: usesDefaultFolder(d) ? t("（預設分類）") : "", value3: summary.length > 0 ? `\n${summary.join(" · ")}` : "" })}
        // 目前使用＝品牌底＋左側漸層標記（另有「目前使用」文字）；其他候選滑過時抬升 1 px（彈簧），按下縮小
        className={cn(
          "relative grid w-full min-w-0 gap-0.5 rounded-lg border px-2.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus",
          LIFT_CARD,
          current ? cn("border-brand-blue/55", SELECTED_ITEM) : "border-line-subtle bg-surface hover:border-line-strong hover:bg-raised/60",
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <kind.icon aria-hidden className={cn("size-4 shrink-0", TEXT_TONE[kind.tone])} />
          <span className="min-w-0 flex-1 truncate text-data font-medium text-fg">{d.label || d.component_id}</span>
          {current ? <Badge tone="action">{t("目前使用")}</Badge> : null}
          <StatusBadge kind="component" value={d.state} />
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 pl-6 text-caption text-fg-tertiary">
          <code className="machine text-fg-secondary">{d.component_id}</code>
          {((deviceTag(d.device) ?? "") !== "") ? <span className="machine rounded-sm border border-line px-1 text-fg-secondary">{deviceTag(d.device)}</span> : null}
          <span className="inline-flex min-w-0 items-center gap-1">
            <Folder aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{folderDisplayPath(folder)}</span>
          </span>
          {summary.map((item) => (
            <code key={item} className="machine">
              {item}
            </code>
          ))}
          {entry.node.stale ? <span className="text-warning">{t("Node 離線（資料過時）")}</span> : null}
          {isTestProvider(d.provider_id) ? <SyntheticBadge kind="test" /> : null}
        </span>
      </button>
    </li>
  );
}

/** 元件庫：Node → 資料夾 → instance（WAI-ARIA tree；Enter 或點選＝選用），可搜尋。 */
function InstanceLibrary({ entries, currentKey, onChoose }: { entries: readonly ComponentEntry[]; currentKey: string | null; onChoose: (entry: ComponentEntry) => void }) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const items = libraryTree(entries);
  const filtered = filterTree(items, query);
  const byId = new Map(entries.map((entry) => [libraryInstanceId(entry.key), entry]));
  const expanded = new Set([...branchIds(items).filter((id) => !collapsed.has(id)), ...filtered.expand]);
  if (items.length === 0) return <EmptyState size="compact" icon={<Boxes />} title={t("目錄中沒有可用的元件 instance；可到元件頁新建。")} />;
  return (
    <div className="grid min-w-0 gap-2">
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-tertiary" />
        <Input
          compact
          id={searchId}
          type="search"
          value={query}
          onChange={(event) => { setQuery(event.target.value); }}
          placeholder={t("搜尋名稱、component_id、provider、資料夾…")}
          aria-label={t("搜尋元件庫")}
          autoComplete="off"
          className="pl-8"
        />
      </div>
      <div className="max-h-72 min-w-0 overflow-auto rounded-lg border border-line-subtle bg-sunken/40">
        {filtered.items.length === 0 ? (
          <EmptyState size="compact" icon={<SearchX />} title={t("找不到符合「{query}」的 instance。", { query: query.trim() })} />
        ) : (
          <TreeView
            items={filtered.items}
            label={t("元件庫")}
            selectedId={(currentKey != null && currentKey !== "") ? libraryInstanceId(currentKey) : null}
            expanded={expanded}
            onToggle={(id, open) => {
              const next = new Set(collapsed);
              if (open) next.delete(id);
              else next.add(id);
              setCollapsed(next);
            }}
            onActivate={(item) => {
              const entry = byId.get(item.id);
              if (entry) onChoose(entry);
            }}
          />
        )}
      </div>
      <p className="text-caption text-fg-tertiary">{t("方向鍵移動、→／← 展開收合、Enter 選用。測試元件不列出。")}</p>
    </div>
  );
}

/**
 * 步驟的元件 instance 選擇器：
 *  - 已選元件：只列與它相同 provider 的 instance（任何 Node，依 Node 分組；顯示資料夾、名稱、component_id、狀態與設定摘要），
 *    其他類型收在「改用其他類型的元件」；
 *  - 新步驟或未知元件：Node → 資料夾的元件庫。
 * 測試元件（test.*）只在步驟本來就用測試元件時出現。
 */
export function InstancePicker({
  stepId,
  current,
  currentNodeId,
  currentComponentId,
  currentNodeLabel,
  entries,
  onChoose,
}: {
  stepId: string;
  /** 目前元件在目錄中的資料（未知元件或未選＝null）。 */
  current: ComponentEntry | null;
  currentNodeId: string;
  currentComponentId: string;
  currentNodeLabel: string | null;
  entries: readonly ComponentEntry[];
  onChoose: (entry: ComponentEntry) => void;
}) {
  const currentKey = current?.key ?? null;
  const providerId = current?.descriptor.provider_id ?? null;
  const groups = (providerId != null && providerId !== "") ? compatibleInstances(entries, providerId) : [];
  const library = libraryEntries(entries, providerId);
  const currentButtonRef = useRef<HTMLButtonElement | null>(null);
  const focusAfterChooseRef = useRef(false);
  // 同一個步驟可能同時出現在「步驟與接線」與右側檢視器：ID 用 useId 避免重複。
  const uidId = useId();
  const titleId = `${uidId}-instance-title`;

  // 從元件庫選用後，選擇器換成「相容 instance」清單：焦點移到目前使用的那一列（在換版面的 commit 之後）。
  useEffect(() => {
    if (!focusAfterChooseRef.current) return;
    focusAfterChooseRef.current = false;
    currentButtonRef.current?.focus();
  }, [currentKey]);

  const choose = (entry: ComponentEntry) => {
    if (entry.key === currentKey) return;
    focusAfterChooseRef.current = true;
    onChoose(entry);
  };

  return (
    <section aria-labelledby={titleId} className="grid min-w-0 gap-2">
      <h4 id={titleId} className="text-data font-semibold text-fg">
        {t("元件 instance")}
      </h4>
      {current && (providerId != null && providerId !== "") ? (
        <>
          <p className="text-caption text-fg-tertiary">
            <T source={"只列出與目前相同 provider（<0>{providerId}</0>）的 instance，依 Node 分組；換成其中一個會保留接線與參數。"} values={{ providerId }} slots={[<code key="slot-0" className="machine" />]} />
          </p>
          {groups.map((group) => (
            <div key={group.node.node_id} role="group" aria-label={t("{label} 的相容 instance", { label: group.node.label })} className="grid min-w-0 gap-1">
              <p className="flex min-w-0 items-center gap-1.5 text-caption font-semibold text-fg-secondary">
                <Server aria-hidden className="size-3.5 shrink-0 text-fg-tertiary" />
                <span className="truncate">{group.node.label}</span>
                {group.node.stale ? <Badge tone="warning">{t("離線")}</Badge> : null}
              </p>
              <ul className="grid min-w-0 gap-1">
                {group.entries.map((entry, position) => (
                  <CandidateRow
                    key={entry.key}
                    appear={position}
                    entry={entry}
                    current={entry.key === currentKey}
                    onChoose={choose}
                    {...(entry.key === currentKey ? { buttonRef: (element) => {
                            currentButtonRef.current = element;
                          } } : {})}
                  />
                ))}
              </ul>
            </div>
          ))}
          {groups.reduce((sum, group) => sum + group.entries.length, 0) <= 1 ? (
            <p className="text-caption text-fg-tertiary">{t("沒有其他相同 provider 的 instance；可在元件頁「複製」出新的 instance（例如不同 LoRA、量化或 offload）。")}</p>
          ) : null}
          <Disclosure summary={t("改用其他類型的元件…（不相容的接線與參數會被移除）")}>
            <InstanceLibrary entries={library} currentKey={currentKey} onChoose={choose} />
          </Disclosure>
        </>
      ) : currentComponentId ? (
        <>
          <Callout tone="warning" icon={<Unplug />} title={t("未知元件")}>
            <p>
              <T source={"目錄中找不到 <0>{currentComponentId}</0>（Node {value}）： 可能已刪除，或 Node 離線。步驟 <1>{stepId}</1> 要改選其他 instance 才能執行。"} values={{ currentComponentId, value: currentNodeLabel ?? <code className="machine">{currentNodeId || t("未指定")}</code>, stepId }} slots={[<code key="slot-0" className="machine" />, <code key="slot-1" className="machine" />]} />
            </p>
          </Callout>
          <InstanceLibrary entries={library} currentKey={null} onChoose={choose} />
        </>
      ) : (
        <>
          <p className="text-caption text-fg-tertiary">{t("從元件庫選擇這一步要用的 instance（依 Node 與資料夾分類）。")}</p>
          <InstanceLibrary entries={library} currentKey={null} onChoose={choose} />
        </>
      )}
    </section>
  );
}
