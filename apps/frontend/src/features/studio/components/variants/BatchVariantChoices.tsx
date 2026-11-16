// The file and route axes of 渲染變體… for a multi-selection (bin/BatchVariantsDialog.tsx), beside the shared Seed
// section (VariantChoices.tsx): 參考檔案 — one @ name the selected shots use (alias and kind, as 換參考檔案 groups them),
// each shot's own file and the library files of that kind to try; 路線 — each shot's own route and the other ready
// routes of their tasks, each saying how many of the shots can try it. They only edit the choices
// (model/variantBatch.ts); nothing reaches the shots.
// Look and motion: the option cards of the popover (ChoiceRow), revealed one after another.
import { useId } from "react";
import type { Catalog, StudioLibraryItem } from "@/api/generated/contracts";
import { Select } from "@/components/ui/controls";
import { t } from "@/i18n";
import type { StudioRoute } from "../../model/routes";
import type { BatchVariantChoices } from "../../model/variantBatch";
import { itemFacts } from "../../references/display";
import type { AliasGroup } from "../../references/batchReplace";
import { KIND_LABEL, videoLibrary } from "../../references/materials";
import { routeFace } from "../generation/modeText";
import { ReadyDot, RouteCaveatLine } from "../routeParts";
import { ChoiceRow, OWN_CHIP, SECTION_TITLE } from "./VariantChoices";

interface BatchAxisProps {
  choices: BatchVariantChoices;
  onChange: (choices: BatchVariantChoices) => void;
}

export function BatchFileChoices({ choices, onChange, groups, library }: BatchAxisProps & { groups: readonly AliasGroup[]; library: readonly StudioLibraryItem[] }) {
  const id = useId();
  const pick = choices.files;
  const group = pick ? groups.find((item) => item.alias === pick.alias && item.kind === pick.kind) : undefined;
  const names = new Map(library.map((item) => [item.item_id, item.name]));
  const toggle = (itemId: string, checked: boolean) => {
    if (!pick) return;
    onChange({ ...choices, files: { ...pick, itemIds: checked ? [...pick.itemIds, itemId] : pick.itemIds.filter((item) => item !== itemId) } });
  };
  const ownText = (item: AliasGroup) => {
    const only = item.files.length === 1 ? item.files[0] : undefined;
    return only ? (names.get(only.itemId) ?? t("不在素材庫")) : t("{count} 個不同的檔案", { count: item.files.length });
  };
  return (
    <section aria-labelledby={`${id}-title`} className="grid gap-2">
      <h3 id={`${id}-title`} className={SECTION_TITLE}>
        {t("參考檔案")}
      </h3>
      <Select
        compact
        aria-label={t("換哪個參考的檔案")}
        value={group?.key ?? ""}
        onChange={(event) => {
          const next = groups.find((item) => item.key === event.target.value);
          onChange({ ...choices, files: next ? { alias: next.alias, kind: next.kind, own: true, itemIds: [] } : null });
        }}
      >
        <option value="">{t("不換檔案")}</option>
        {groups.map((item) => (
          <option key={item.key} value={item.key}>
            {t("換 @{alias} 的檔案（{kind}，{count} 個鏡頭有）", { alias: item.alias, kind: KIND_LABEL[item.kind], count: item.shotIds.length })}
          </option>
        ))}
      </Select>
      {pick && group ? (
        <div role="group" aria-label={t("@{alias} 要試的檔案", { alias: group.alias })} className="grid gap-1 animate-reveal">
          <ChoiceRow index={0} checked={pick.own} onChange={(own) => onChange({ ...choices, files: { ...pick, own } })} title={ownText(group)}>
            <span className="truncate text-data text-fg">{t("每個鏡頭目前的檔案")}</span>
            <span className="truncate text-caption text-fg-tertiary">{ownText(group)}</span>
          </ChoiceRow>
          {videoLibrary(library)
            .filter((item) => item.kind === group.kind)
            .map((item, index) => {
              const using = group.files.find((file) => file.itemId === item.item_id)?.shots ?? 0;
              return (
                <ChoiceRow key={item.item_id} index={index + 1} checked={pick.itemIds.includes(item.item_id)} onChange={(checked) => toggle(item.item_id, checked)} title={item.name}>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="min-w-0 truncate text-data text-fg">{item.name}</span>
                    {using > 0 ? <span className={OWN_CHIP}>{t("{count} 個鏡頭在用", { count: using })}</span> : null}
                  </span>
                  <span className="truncate text-caption text-fg-tertiary">{itemFacts(item) || t("圖片")}</span>
                </ChoiceRow>
              );
            })}
        </div>
      ) : null}
    </section>
  );
}

/** A route the selected shots' variants can try, and how many of them can. */
export interface BatchRouteOption {
  route: StudioRoute;
  shots: number;
}

export function BatchRouteChoices({ choices, onChange, options, catalog }: BatchAxisProps & { options: readonly BatchRouteOption[]; catalog: Catalog | undefined }) {
  const id = useId();
  const chosen = choices.routes ?? { own: true, others: [] };
  const toggle = (routeId: string, checked: boolean) => {
    const others = options.filter((option) => (option.route.id === routeId ? checked : chosen.others.includes(option.route.id))).map((option) => option.route.id);
    onChange({ ...choices, routes: { ...chosen, others } });
  };
  return (
    <section aria-labelledby={`${id}-title`} className="grid gap-2">
      <h3 id={`${id}-title`} className={SECTION_TITLE}>
        {t("路線")}
      </h3>
      <div role="group" aria-labelledby={`${id}-title`} className="grid gap-1">
        <ChoiceRow index={0} checked={chosen.own} onChange={(own) => onChange({ ...choices, routes: { ...chosen, own } })}>
          <span className="truncate text-data text-fg">{t("每個鏡頭目前的路線")}</span>
        </ChoiceRow>
        {options.map(({ route, shots }, index) => {
          const face = routeFace(route, catalog);
          return (
            <ChoiceRow
              key={route.id}
              index={index + 1}
              checked={chosen.others.includes(route.id)}
              onChange={(checked) => toggle(route.id, checked)}
              title={route.ready ? face.title : `${face.title}\n${route.summary}`}
            >
              <span className="min-w-0 truncate text-data text-fg">{face.name}</span>
              <span className="flex min-w-0 items-center gap-1.5 text-caption text-fg-tertiary">
                <ReadyDot ready={route.ready} />
                <span className="truncate">{t("{machine}・{count} 個鏡頭可用", { machine: face.machine ?? route.capability, count: shots })}</span>
              </span>
              <RouteCaveatLine route={route} />
            </ChoiceRow>
          );
        })}
      </div>
    </section>
  );
}
