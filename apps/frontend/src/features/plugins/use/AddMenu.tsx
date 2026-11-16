// 「加入」選單：專案可以選用的插件項目，依種類分組（限制、風格、效果、生成設定），上方可以搜尋。點一項就加入或拿掉
// （選單不關，可以連續選幾項）；同一組只能選一個的規則會取代原本那條；不能加入的項目說明原因。
// 鍵盤（combobox）：焦點在搜尋欄，↑／↓ 移動、Enter 切換、Esc 關閉並回到按鈕。以 position: fixed 留在原本的 React 樹內。
import { Check, Plus, Search } from "lucide-react";
import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { StudioPluginRef } from "@/api/generated/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/controls";
import { placeMenu } from "@/components/ui/menuModel";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { CONTRIBUTION_KINDS, contributionKindLabel, filterContributions, listContributions, type Contribution } from "../model/contributions";
import { pluginName } from "../model/evaluate";
import type { PluginRegistry } from "../model/registry";
import { addCheck, replaceNote, withoutRef, withRef } from "../model/selection";
import { ContributionIcon } from "../parts/kinds";

interface Option {
  item: Contribution;
  active: boolean;
  /** 不能加入的原因；可以時為 null。 */
  reason: string | null;
  /** 加入時會取代同組的哪一條（說明用）。 */
  note: string | null;
}

function buildOptions(registry: PluginRegistry, refs: readonly StudioPluginRef[], query: string): Option[] {
  const items = filterContributions(listContributions(registry), "all", query);
  return CONTRIBUTION_KINDS.flatMap((kind) =>
    items
      .filter((item) => item.kind === kind)
      .map((item) => {
        const active = refs.includes(item.ref);
        const check = active ? { reason: null, replaces: null } : addCheck(registry, refs, item.ref);
        return { item, active, reason: check.reason, note: check.replaces ? replaceNote(registry, check.replaces) : null };
      }),
  );
}

function OptionRow({ id, option, current, onToggle, onHover }: { id: string; option: Option; current: boolean; onToggle: () => void; onHover: () => void }) {
  const { item, active, reason, note } = option;
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      aria-disabled={reason !== null || undefined}
      title={[item.label, item.description, note ?? ""].filter(Boolean).join("\n")}
      onClick={onToggle}
      onPointerMove={onHover}
      className={cn(
        "flex min-h-10 items-center gap-2.5 rounded-lg px-2 py-1 transition-colors duration-(--duration-fast)",
        reason !== null ? "cursor-not-allowed text-fg-disabled" : "cursor-pointer text-fg",
        current && (reason !== null ? "bg-white/5" : "bg-brand-gradient-soft"),
      )}
    >
      <ContributionIcon kind={item.kind} className={reason !== null ? "text-fg-disabled" : undefined} />
      <span className="grid min-w-0 flex-1">
        <span className="truncate text-data">{item.label}</span>
        <span className="truncate text-caption text-fg-tertiary">{reason ?? pluginName(item.plugin)}</span>
      </span>
      {active ? <Check aria-hidden className="size-4 shrink-0 text-brand-cyan" /> : null}
    </div>
  );
}

function Panel({
  registry,
  refs,
  onChange,
  anchor,
  onClose,
}: {
  registry: PluginRegistry;
  refs: readonly StudioPluginRef[];
  onChange: (refs: StudioPluginRef[]) => void;
  anchor: HTMLElement;
  onClose: (restoreFocus: boolean) => void;
}) {
  const baseId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const options = buildOptions(registry, refs, query);
  const index = Math.min(cursor, Math.max(0, options.length - 1));
  const optionId = (at: number) => `${baseId}-option-${at}`;

  // 每次 render 後重新定位（搜尋會改變高度）；放不下時翻到按鈕上方
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const position = placeMenu(anchor.getBoundingClientRect(), { width: panel.offsetWidth, height: panel.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
    panel.style.left = `${position.left}px`;
    panel.style.top = `${position.top}px`;
  });

  const onOutsidePointer = useEffectEvent((event: PointerEvent) => {
    const target = event.target;
    if (!(target instanceof Node) || panelRef.current?.contains(target) || anchor.contains(target)) return;
    onClose(false);
  });
  const onResize = useEffectEvent(() => onClose(false));
  useEffect(() => {
    const pointer = (event: PointerEvent) => onOutsidePointer(event);
    const resize = () => onResize();
    document.addEventListener("pointerdown", pointer, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      window.removeEventListener("resize", resize);
    };
  }, []);

  const toggle = (option: Option | undefined) => {
    if (!option || option.reason !== null) return;
    onChange(option.active ? withoutRef(refs, option.item.ref) : withRef(registry, refs, option.item.ref));
  };
  const move = (to: number) => {
    const next = Math.max(0, Math.min(options.length - 1, to));
    setCursor(next);
    document.getElementById(optionId(next))?.scrollIntoView({ block: "nearest" });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // 選單內的按鍵不往外傳（不觸發監看器或時間軸的快速鍵）
    event.stopPropagation();
    // 輸入法選字中的 Enter 與方向鍵屬於輸入法，不是選單的操作
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(options.length - 1);
    else if (event.key === "Enter") toggle(options[index]);
    else if (event.key === "Escape") onClose(true);
    else return;
    event.preventDefault();
  };

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t("加入插件項目")}
      onKeyDown={onKeyDown}
      className="material-popover fixed top-0 left-0 z-50 flex max-h-[min(30rem,calc(100vh-1rem))] w-80 animate-pop-in flex-col rounded-xl text-fg"
    >
      <label className="relative m-2 mb-1 block shrink-0">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-tertiary" />
        <Input
          compact
          autoFocus
          type="search"
          role="combobox"
          aria-expanded
          aria-controls={`${baseId}-list`}
          aria-activedescendant={options.length > 0 ? optionId(index) : undefined}
          aria-label={t("搜尋插件項目")}
          placeholder={t("搜尋名稱、說明或插件")}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
          }}
          className="pl-8"
        />
      </label>
      <div id={`${baseId}-list`} role="listbox" aria-multiselectable aria-label={t("插件項目")} className="grid min-h-0 flex-1 content-start gap-0.5 overflow-y-auto p-1.5 pt-0.5">
        {options.map((option, at) => {
          const heading = at === 0 || options[at - 1]?.item.kind !== option.item.kind ? contributionKindLabel(option.item.kind) : null;
          return (
            <div key={option.item.ref} role="presentation" className="grid gap-0.5">
              {heading ? (
                <p role="presentation" className="px-2 pt-2 pb-0.5 text-caption font-semibold text-fg-tertiary">
                  {heading}
                </p>
              ) : null}
              <OptionRow id={optionId(at)} option={option} current={at === index} onToggle={() => toggle(option)} onHover={() => setCursor(at)} />
            </div>
          );
        })}
        {options.length === 0 ? <p className="px-2 py-4 text-center text-data text-fg-tertiary">{t("沒有符合的項目")}</p> : null}
      </div>
    </div>
  );
}

export function AddMenu({
  registry,
  refs,
  onChange,
  disabledReason,
}: {
  registry: PluginRegistry;
  refs: readonly StudioPluginRef[];
  onChange: (refs: StudioPluginRef[]) => void;
  /** 現在不能加入的原因（登錄表還沒讀到）；可以時為 null。 */
  disabledReason: string | null;
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const open = anchor !== null;
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        icon={<Plus aria-hidden />}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-disabled={disabledReason !== null || undefined}
        title={disabledReason ?? undefined}
        onClick={(event) => {
          if (disabledReason !== null) return;
          setAnchor(open ? null : event.currentTarget);
        }}
        className={cn("shrink-0", disabledReason !== null && "cursor-not-allowed text-fg-disabled")}
      >
        {t("加入")}
      </Button>
      {anchor ? (
        <Panel
          registry={registry}
          refs={refs}
          onChange={onChange}
          anchor={anchor}
          onClose={(restoreFocus) => {
            if (restoreFocus && anchor.isConnected) anchor.focus();
            setAnchor(null);
          }}
        />
      ) : null}
    </>
  );
}
