// H3 DiT 的 LoRA 串接欄位（provider_options.loras，schema 關鍵字 x-phasyn-control: lora_stack）：依序列出每個 LoRA、
// 標示哪一個是加速 LoRA（決定採樣合約）、各自的強度、上下移與移除；從 provider 回報的 LoRA 目錄加入，也可手動填 manifest
// 路徑。單一 LoRA 欄位（lora）有設定時，提供「改成串接清單」把它搬進來。不用原生 select：目錄是動作選單。
import { ArrowDown, ArrowUp, Gauge, Layers, ListPlus, PencilLine, Plus, Trash2, Zap } from "lucide-react";
import { use, useRef, useState } from "react";
import { ActionMenu, MenuTriggerButton } from "@/components/ui/action-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/controls";
import type { MenuItem } from "@/components/ui/menuModel";
import { reveal, useFlipList } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { domId } from "@/lib/dom";
import type { JsonObject } from "@/lib/json";
import type { SchemaIssue } from "@/lib/schema";
import { HelpButton, HelpText } from "../HelpTip";
import { SchemaDensityContext } from "../schemaDensity";
import { NumberControl } from "./inputs";
import { LoraCatalogContext } from "./loraCatalogContext";
import {
  addableCatalog,
  addEntry,
  convertLegacy,
  findCatalog,
  legacyEntry,
  MAX_LORA_STACK,
  moveEntry,
  normalizeStack,
  removeEntry,
  SCALE_MAX,
  SCALE_MIN,
  stackEntries,
  stackProblems,
  updateEntry,
  type LoraCatalogEntry,
  type LoraStackEntry,
  type StackProblem,
} from "./loraStackModel";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return (parts[parts.length - 1] ?? path).replace(/\.json$/i, "");
}

function problemText(problem: StackProblem): string {
  switch (problem.kind) {
    case "both_forms":
      return t("單一 LoRA 欄位（lora）也有設定：兩者只能擇一，請先「改成串接清單」");
    case "accelerators":
      return t("最多一個加速 LoRA（各自帶不同的採樣合約）：{ids}", { ids: formatList(problem.ids) });
    case "duplicate":
      return t("{name} 出現兩次；要加強請調整該項的強度", { name: basename(problem.manifestPath) });
    case "variant":
      return t("{name} 只適用 {variants}，與這個 DiT 的 variant 不同", { name: basename(problem.manifestPath), variants: formatList(problem.variants) });
    case "fixed_scale":
      return t("{name} 的強度固定為 {fixed}", { name: basename(problem.manifestPath), fixed: problem.fixed });
    case "zero_scale":
      return t("{name} 的強度是 0，等於沒有套用；請移除該項", { name: basename(problem.manifestPath) });
    case "too_many":
      return t("最多串接 {max} 個 LoRA", { max: MAX_LORA_STACK });
  }
}

let rowCounter = 0;
function nextRowKey(): string {
  rowCounter += 1;
  return `row-${String(rowCounter)}`;
}

function moveKeys(keys: readonly string[], index: number, delta: -1 | 1): string[] {
  const next = [...keys];
  const target = index + delta;
  const a = next[index];
  const b = next[target];
  if (a === undefined || b === undefined) return next;
  next[index] = b;
  next[target] = a;
  return next;
}

function RoleBadge({ known }: { known: LoraCatalogEntry | null }) {
  if (!known) return <Badge title={t("目錄裡沒有這個 manifest：儲存並重新載入後由 Node 判斷")}>{t("未在目錄")}</Badge>;
  return known.role === "acceleration" ? (
    <Badge tone="action" title={t("加速 LoRA：採樣步數與 shift 依它的合約（{steps} 步）", { steps: formatList(known.steps.map(String)) })}>
      <Zap aria-hidden />
      {t("加速")}
    </Badge>
  ) : (
    <Badge tone="info" title={t("疊加的風格／概念 LoRA：依序加在加速 LoRA 之上")}>
      <Layers aria-hidden />
      {t("疊加")}
    </Badge>
  );
}

function EntryRow({
  entry,
  index,
  count,
  known,
  idPrefix,
  path,
  disabled,
  issues,
  onChange,
  onMove,
  onRemove,
}: {
  entry: LoraStackEntry;
  index: number;
  count: number;
  known: LoraCatalogEntry | null;
  idPrefix: string;
  path: string;
  disabled: boolean;
  issues: readonly SchemaIssue[];
  onChange: (patch: Partial<LoraStackEntry>) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const rowPath = `${path}[${String(index)}]`;
  const pathId = domId(idPrefix, `${rowPath}.manifest_path`);
  const scaleId = domId(idPrefix, `${rowPath}.scale`);
  const own = issues.filter((issue) => issue.path === rowPath || issue.path.startsWith(`${rowPath}.`));
  const name = known?.label ?? basename(entry.manifest_path);
  const fixed = known?.fixed_scale ?? null;
  return (
    <li ref={reveal(index)} className="grid min-w-0 gap-2 rounded-md border border-line-subtle bg-sunken/60 px-2.5 py-2" data-path={rowPath}>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="machine w-5 shrink-0 text-caption text-fg-tertiary" aria-hidden>
          {index + 1}
        </span>
        <RoleBadge known={known} />
        <span className="min-w-0 flex-1 truncate text-data text-fg" title={name}>
          {name}
        </span>
        <span className="ml-auto flex shrink-0 items-center">
          <Button size="icon-sm" variant="quiet" icon={<ArrowUp aria-hidden />} disabled={disabled || index === 0} onClick={() => { onMove(-1); }} aria-label={t("把 {name} 往上移", { name })} title={t("往上移")} />
          <Button size="icon-sm" variant="quiet" icon={<ArrowDown aria-hidden />} disabled={disabled || index === count - 1} onClick={() => { onMove(1); }} aria-label={t("把 {name} 往下移", { name })} title={t("往下移")} />
          <Button size="icon-sm" variant="quiet" icon={<Trash2 aria-hidden />} disabled={disabled} onClick={onRemove} aria-label={t("移除 {name}", { name })} title={t("移除")} className="hover:text-danger" />
        </span>
      </div>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(5.5rem,7rem)] items-end gap-2">
        <div className="grid min-w-0 gap-0.5">
          <label htmlFor={pathId} className="text-caption text-fg-tertiary">
            manifest
          </label>
          <Input
            id={pathId}
            compact
            className="machine"
            value={entry.manifest_path}
            disabled={disabled}
            aria-invalid={own.length > 0 || undefined}
            onChange={(event) => { onChange({ manifest_path: event.target.value }); }}
          />
        </div>
        <div className="grid min-w-0 gap-0.5">
          <label htmlFor={scaleId} className="flex items-center gap-1 text-caption text-fg-tertiary">
            <Gauge aria-hidden className="size-3" />
            {t("強度")}
          </label>
          <NumberControl
            id={scaleId}
            compact
            value={entry.scale ?? 1}
            integer={false}
            emptyValue={1}
            invalid={own.length > 0}
            disabled={disabled || fixed !== null}
            onChange={(next) => { onChange({ scale: typeof next === "number" ? Math.min(SCALE_MAX, Math.max(SCALE_MIN, next)) : 1 }); }}
          />
        </div>
      </div>
      {fixed !== null ? <p className="text-caption text-fg-tertiary">{t("強度固定為 {fixed}（PDD 輸出頭依訓練時的權重融合）", { fixed })}</p> : null}
      {own.length > 0 ? <p className="text-caption text-danger">{own.map((issue) => issue.message).join(t("；"))}</p> : null}
    </li>
  );
}

export interface LoraStackFieldProps {
  name: string;
  path: string;
  idPrefix: string;
  /** provider_options（這個欄位的上一層）：需要讀寫旁邊的單一 LoRA 欄位 lora。 */
  parent: JsonObject;
  onParentChange: (next: JsonObject) => void;
  disabled: boolean;
  issues: readonly SchemaIssue[];
  description?: string | undefined;
}

export function LoraStackField({ name, path, idPrefix, parent, onParentChange, disabled, issues, description }: LoraStackFieldProps) {
  const { entries: catalog, variant } = use(LoraCatalogContext);
  const compact = use(SchemaDensityContext) === "compact";
  const entries = stackEntries(parent[name]);
  const legacy = legacyEntry(parent);
  const [helpOpen, setHelpOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  // Row identities survive typing (the path is edited in place) and follow moves; a change made elsewhere (the JSON
  // tab) that alters the count starts a fresh set.
  const [keyState, setKeyState] = useState<string[]>(() => entries.map(nextRowKey));
  let keys = keyState;
  if (keyState.length !== entries.length) {
    keys = entries.map(nextRowKey);
    setKeyState(keys);
  }
  useFlipList(listRef, keys.join("␟"));

  const helpId = `${domId(idPrefix, path)}-help`;
  const setEntries = (next: readonly LoraStackEntry[], nextKeys: string[] = keys) => {
    setKeyState(nextKeys);
    onParentChange({ ...parent, [name]: normalizeStack(next) });
  };
  const problems = stackProblems(entries, catalog, { variant, legacy: legacy !== null });
  const full = entries.length >= MAX_LORA_STACK;
  const addable = addableCatalog(entries, catalog, variant);
  const own = issues.filter((issue) => issue.path === path);
  const menuItems: MenuItem[] = [
    ...addable.map((item) => ({
      id: `add-${item.manifest_path}`,
      label: t("{role}・{label}", { role: item.role === "acceleration" ? t("加速") : t("疊加"), label: item.label }),
      icon: item.role === "acceleration" ? Zap : Layers,
      onSelect: () => { setEntries(addEntry(entries, item.manifest_path, catalog), [...keys, nextRowKey()]); },
    })),
    {
      id: "add-manual",
      label: t("手動輸入 manifest 路徑"),
      icon: PencilLine,
      separatorBefore: addable.length > 0,
      onSelect: () => { setEntries(addEntry(entries, "", catalog), [...keys, nextRowKey()]); },
    },
  ];
  const help = description ?? t("依序套用多個 LoRA：最多一個加速 LoRA（決定步數與 shift），其他是疊加的風格／概念 LoRA，各自有強度。");

  return (
    <div className={cn("grid min-w-0", compact ? "gap-1.5 py-1" : "gap-2")} data-path={path}>
      <div className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-data font-medium text-fg-secondary">
          <code className="machine">{name}</code>
          <span className="ml-2 font-normal">{t("LoRA 串接")}</span>
        </span>
        <Badge>{t("{count}／{max}", { count: entries.length, max: MAX_LORA_STACK })}</Badge>
        <HelpButton open={helpOpen} onToggle={() => { setHelpOpen((open) => !open); }} controls={helpId} label={name} text={help} />
      </div>
      <HelpText id={helpId} open={helpOpen}>
        {help}
      </HelpText>
      {legacy !== null ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-line-subtle bg-raised/60 px-2.5 py-2 text-caption text-fg-secondary">
          <span className="min-w-0 flex-1">
            {t("目前用單一 LoRA 欄位 lora：{name}", { name: basename(legacy.manifest_path) })}
          </span>
          <Button size="sm" icon={<ListPlus aria-hidden />} disabled={disabled || entries.length >= MAX_LORA_STACK} onClick={() => { onParentChange(convertLegacy(parent)); }}>
            {t("改成串接清單")}
          </Button>
        </div>
      ) : null}
      {entries.length > 0 ? (
        <ol ref={listRef} className="grid min-w-0 gap-1.5" aria-label={t("LoRA 串接順序")}>
          {entries.map((entry, index) => (
            <EntryRow
              key={keys[index]}
              entry={entry}
              index={index}
              count={entries.length}
              known={findCatalog(catalog, entry.manifest_path)}
              idPrefix={idPrefix}
              path={path}
              disabled={disabled}
              issues={issues}
              onChange={(patch) => { setEntries(updateEntry(entries, index, patch)); }}
              onMove={(delta) => { setEntries(moveEntry(entries, index, delta), moveKeys(keys, index, delta)); }}
              onRemove={() => { setEntries(removeEntry(entries, index), keys.filter((_key, i) => i !== index)); }}
            />
          ))}
        </ol>
      ) : legacy === null ? (
        <p className="text-caption text-fg-tertiary">{t("沒有串接 LoRA。")}</p>
      ) : null}
      {problems.length > 0 || own.length > 0 ? (
        <ul className="grid gap-0.5 text-caption text-warning" role="status">
          {problems.map((problem) => (
            <li key={`${problem.kind}-${"manifestPath" in problem ? problem.manifestPath : ""}`}>{problemText(problem)}</li>
          ))}
          {own.map((issue) => (
            <li key={issue.message} className="text-danger">
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {disabled || full || legacy !== null ? (
          <Button size="sm" icon={<Plus aria-hidden />} disabled>
            {t("加入 LoRA")}
          </Button>
        ) : (
          <MenuTriggerButton
            menuId={`${domId(idPrefix, path)}-menu`}
            open={menuAnchor !== null}
            label={t("加入 LoRA")}
            onOpen={(element) => { setMenuAnchor(element); }}
            onClose={() => { setMenuAnchor(null); }}
            className="pressable inline-flex min-h-8 items-center gap-2 rounded-md border border-line-strong bg-raised px-3 text-data font-medium text-fg shadow-edge hover:border-action/60 hover:bg-overlay [&_svg]:size-4"
          >
            <Plus aria-hidden />
            {t("加入 LoRA")}
          </MenuTriggerButton>
        )}
        <span className="text-caption text-fg-tertiary">
          {full
            ? t("已達上限 {max} 個", { max: MAX_LORA_STACK })
            : legacy !== null
              ? t("先改成串接清單才能加入")
              : catalog.length === 0
                ? t("Node 沒有回報 LoRA 目錄：可手動輸入 manifest 路徑")
                : t("順序即套用順序；採樣合約由加速 LoRA 決定")}
        </span>
      </div>
      {menuAnchor ? (
        <ActionMenu
          id={`${domId(idPrefix, path)}-menu`}
          label={t("加入 LoRA")}
          anchor={{ kind: "element", element: menuAnchor }}
          returnFocus={menuAnchor}
          onClose={() => { setMenuAnchor(null); }}
          items={menuItems}
        />
      ) : null}
    </div>
  );
}
