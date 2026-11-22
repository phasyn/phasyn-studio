// The keyboard shortcut list: "?" outside a text field, the Edit workspace's header button or the project manager
// open it. Its rows come from model/shortcuts.ts (the real key map), one tab per group; typing in the search field
// lists the matches of every group instead.
import { Search } from "lucide-react";
import { Fragment, useEffect, useEffectEvent, useState } from "react";
import { EmptyState } from "@/components/common/EmptyState";
import { Input } from "@/components/ui/controls";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { reveal } from "@/components/ui/motion";
import { PanelTabs } from "@/components/workbench/PanelTabs";
import { t } from "@/i18n";
import { detectApplePlatform, isInOverlay, isTextEntry, modifierLabel } from "@/lib/keyboard";
import { isHelpKey, SHORTCUT_GROUPS, SHORTCUTS_OPEN_EVENT, type Shortcut } from "../model/shortcuts";

function Keys({ chords, mac }: { chords: string[][]; mac: boolean }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {chords.map((chord, index) => (
        <Fragment key={chord.join("+")}>
          {index > 0 ? <span className="text-caption text-fg-tertiary">{t("／")}</span> : null}
          <span className="inline-flex items-center gap-0.5">
            {chord.map((key, keyIndex) => (
              <Fragment key={key}>
                {keyIndex > 0 ? <span className="text-caption text-fg-tertiary">+</span> : null}
                <kbd className="machine inline-flex min-w-6 items-center justify-center rounded-md border border-line border-b-2 bg-sunken px-1.5 text-caption leading-5 text-fg">
                  {modifierLabel(key, mac)}
                </kbd>
              </Fragment>
            ))}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

function Rows({ items, mac }: { items: readonly (Shortcut & { group?: string })[]; mac: boolean }) {
  return (
    <dl className="grid content-start gap-x-8 md:grid-cols-2">
      {items.map((item, index) => (
        <div
          key={`${item.group ?? ""}-${item.keys.flat().join(" ")}-${item.action}`}
          ref={reveal(index)}
          className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] items-center gap-3 border-b border-line-subtle py-2"
        >
          <dt>
            <Keys chords={item.keys} mac={mac} />
          </dt>
          <dd className="grid min-w-0 text-data text-fg">
            <span className="[overflow-wrap:anywhere]">{item.action}</span>
            {(item.where ?? "") || (item.group != null && item.group !== "") ? <span className="truncate text-caption text-fg-tertiary">{[item.group, item.where].filter(Boolean).join(t("・"))}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function matches(item: Shortcut, query: string): boolean {
  const text = `${item.action} ${item.where ?? ""} ${item.keys.flat().join(" ")}`.toLowerCase();
  return query.split(/\s+/).every((word) => text.includes(word));
}

function ShortcutList() {
  const mac = detectApplePlatform();
  const [tab, setTab] = useState(SHORTCUT_GROUPS[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const wanted = query.trim().toLowerCase();
  const group = SHORTCUT_GROUPS.find((item) => item.id === tab) ?? SHORTCUT_GROUPS[0];
  const found = wanted ? SHORTCUT_GROUPS.flatMap((item) => item.items.filter((row) => matches(row, wanted)).map((row) => ({ ...row, group: item.title }))) : [];
  return (
    <>
      <div className="flex shrink-0 items-center gap-2 px-6 pb-3">
        <div className="relative min-w-0 flex-1">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-tertiary" />
          <Input type="search" value={query} onChange={(event) => { setQuery(event.target.value); }} placeholder={t("搜尋動作或按鍵")} aria-label={t("搜尋快速鍵")} className="pl-8" />
        </div>
      </div>
      {wanted ? null : (
        <PanelTabs
          variant="studio"
          idPrefix="studio-shortcuts"
          label={t("快速鍵分類")}
          value={group?.id ?? ""}
          onChange={setTab}
          tabs={SHORTCUT_GROUPS.map((item) => ({ id: item.id, label: item.title, count: item.items.length }))}
        />
      )}
      <DialogBody className="h-[min(30rem,60vh)] flex-none">
        {wanted ? (
          found.length > 0 ? (
            <Rows items={found} mac={mac} />
          ) : (
            <EmptyState size="compact" icon={<Search />} title={t("沒有符合的快速鍵")} description={t("換一個詞，或清除搜尋後依分類瀏覽。")} />
          )
        ) : group ? (
          <div key={group.id} role="tabpanel" id={`studio-shortcuts-panel-${group.id}`} aria-labelledby={`studio-shortcuts-tab-${group.id}`}>
            <Rows items={group.items} mac={mac} />
          </div>
        ) : null}
      </DialogBody>
    </>
  );
}

/** Mounted once in the Studio frame (no trigger of its own): "?" or openShortcuts() opens it. */
export function ShortcutsDialog() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => { setOpen(true); };
    window.addEventListener(SHORTCUTS_OPEN_EVENT, show);
    return () => { window.removeEventListener(SHORTCUTS_OPEN_EVENT, show); };
  }, []);

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (open || event.defaultPrevented || !isHelpKey(event) || isTextEntry(event.target) || isInOverlay(event.target)) return;
    event.preventDefault();
    setOpen(true);
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { onKey(event); };
    window.addEventListener("keydown", listener);
    return () => { window.removeEventListener("keydown", listener); };
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent wide onKeyDown={(event) => { event.stopPropagation(); }}>
        <DialogHeader>
          <DialogTitle>{t("鍵盤快速鍵")}</DialogTitle>
          <DialogDescription>{t("播放、導覽、縮放與復原在「鏡頭」和「編輯」都有效，其餘只在「編輯」；按鍵作用在有焦點框的面板上，文字欄位、選單與對話框內不會觸發。")}</DialogDescription>
        </DialogHeader>
        {open ? <ShortcutList /> : null}
      </DialogContent>
    </Dialog>
  );
}
