// The three axes of the variants popover (VariationsControl.tsx), each a section: Seed — the shot's own fixed seed,
// how many new random seeds (the 數量 ×2–×4 of before, now 0–4) and typed fixed seeds as removable chips; 參考檔案 —
// one reference alias and the library files of its kind to try (its own file first; a clip window the new file
// cannot hold goes back to the whole file, as 換成其他檔案 does); 路線 — the shot's route and the other ready routes
// of the same task. They only edit the choices (model/variants.ts); nothing reaches the shot.
// Look and motion: rows are option cards with native checkboxes (Space toggles, Tab moves), revealed one after
// another; the random count is the shared Segmented with its spring thumb; chips pop in.
import { Check, Plus, X } from "lucide-react";
import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import type { StudioLibraryItem, StudioShot } from "@/api/generated/contracts";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/controls";
import { OPTION_CARD, OPTION_IDLE, OPTION_SELECTED } from "@/components/ui/look";
import { reveal } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";
import { T } from "@/i18n/T";
import { RANDOM_SEED } from "../../model/project";
import type { StudioRoute } from "../../model/routes";
import { fileChoices, MAX_VARIANT_TAKES, parseSeeds, RANDOM_SEED_COUNTS, type VariantChoices } from "../../model/variants";
import { itemFacts } from "../../references/display";
import { clipFits } from "../../references/materials";
import { useStudio } from "../../studioContext";
import { Segmented } from "../generation/Segmented";
import { routeFace } from "../generation/modeText";
import { ReadyDot, RouteCaveatLine } from "../routeParts";

interface AxisProps {
  shot: StudioShot;
  choices: VariantChoices;
  onChange: (choices: VariantChoices) => void;
}

export const SECTION_TITLE = "text-caption font-semibold text-fg-secondary";
export const OWN_CHIP = "shrink-0 rounded-sm bg-overlay px-1 text-[11px] leading-4 text-fg-tertiary";

/** One choice: an option card around a native checkbox (the whole card toggles it). */
export function ChoiceRow({ checked, onChange, title, index, children }: { checked: boolean; onChange: (checked: boolean) => void; title?: string; index: number; children: ReactNode }) {
  return (
    <label
      ref={reveal(index)}
      title={title}
      className={cn(
        OPTION_CARD,
        "grid min-h-10 cursor-pointer grid-cols-[0.875rem_minmax(0,1fr)] items-center gap-2.5 px-2.5 py-1 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus",
        checked ? OPTION_SELECTED : OPTION_IDLE,
      )}
    >
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="sr-only" />
      <span aria-hidden className={cn("grid size-3.5 place-items-center rounded-sm border transition-colors duration-(--duration-fast)", checked ? "border-brand-cyan bg-brand-cyan/15" : "border-line-control")}>
        {checked ? <Check className="size-3 text-brand-cyan animate-pop-in" /> : null}
      </span>
      <span className="grid min-w-0 gap-px">{children}</span>
    </label>
  );
}

/** The seed axis of the choices (the single shot's and the multi-selection's). */
type SeedAxis = Pick<VariantChoices, "ownSeed" | "randomSeeds" | "fixedSeeds">;

export interface OwnSeed {
  /** The row of the own-seed checkbox. */
  label: ReactNode;
  /** A typed seed equal to this ticks the box instead of adding a chip (the shot's own); null when no single seed is the own one. */
  seed: number | null;
}

/** The seed section of the single-shot popover. */
export function ShotSeedChoices({ shot, choices, onChange }: AxisProps) {
  const own: OwnSeed | null =
    shot.seed === RANDOM_SEED
      ? null
      : { label: <T source={"鏡頭的 seed <0>{seed}</0>"} values={{ seed: shot.seed }} slots={[<span className="machine" />]} />, seed: shot.seed };
  return <SeedChoices own={own} ownMissing={t("鏡頭的 seed 是每次隨機：用新的隨機 seed，或在下面輸入固定的 seed。")} choices={choices} onChange={onChange} />;
}

/**
 * Seed: the own seed (a checkbox, when there is one), how many new random seeds and typed fixed seeds. `ownMissing`
 * says why there is no own seed to choose.
 */
export function SeedChoices<C extends SeedAxis>({ own, ownMissing, choices, onChange }: { own: OwnSeed | null; ownMissing: string; choices: C; onChange: (choices: C) => void }) {
  const id = useId();
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const ownSeed = own?.seed ?? null;
  const add = () => {
    const parsed = parseSeeds(draft);
    if (parsed.problem !== null) {
      setProblem(parsed.problem);
      return;
    }
    // The shot's own seed is its own choice: typing it ticks that box instead of adding a chip
    const typedOwn = ownSeed !== null && parsed.seeds.includes(ownSeed);
    const seeds = [...new Set([...choices.fixedSeeds, ...parsed.seeds.filter((seed) => seed !== ownSeed)])];
    if (seeds.length > MAX_VARIANT_TAKES) {
      setProblem(t("固定的 seed 最多 {max} 個", { max: MAX_VARIANT_TAKES }));
      return;
    }
    onChange({ ...choices, fixedSeeds: seeds, ownSeed: choices.ownSeed || typedOwn });
    setDraft("");
    setProblem(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    add();
  };
  return (
    <section aria-labelledby={`${id}-title`} className="grid gap-2">
      <h3 id={`${id}-title`} className={SECTION_TITLE}>
        Seed
      </h3>
      {own ? (
        <ChoiceRow index={0} checked={choices.ownSeed} onChange={(checked) => onChange({ ...choices, ownSeed: checked })}>
          <span className="truncate text-data text-fg">{own.label}</span>
        </ChoiceRow>
      ) : (
        <p className="text-caption text-fg-tertiary">{ownMissing}</p>
      )}
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
        <span id={`${id}-random`} className="text-caption text-fg-secondary">
          {t("新的隨機 seed")}
        </span>
        <Segmented<number>
          autofocus
          name={`${id}-random-count`}
          label={t("新的隨機 seed 幾個")}
          value={choices.randomSeeds}
          options={RANDOM_SEED_COUNTS.map((value) => ({ value, label: <span className="machine">{value}</span> }))}
          onChange={(randomSeeds) => onChange({ ...choices, randomSeeds })}
        />
      </div>
      <div className="grid gap-1.5">
        <label htmlFor={`${id}-typed`} className="text-caption text-fg-secondary">
          {t("固定的 seed")}
        </label>
        <div className="flex items-start gap-1.5">
          <Input
            id={`${id}-typed`}
            compact
            inputMode="numeric"
            autoComplete="off"
            value={draft}
            placeholder={t("例如 42 20261116（可一次輸入多個）")}
            aria-invalid={problem !== null || undefined}
            aria-describedby={problem ? `${id}-problem` : undefined}
            onChange={(event) => {
              setDraft(event.target.value);
              setProblem(null);
            }}
            onKeyDown={onKeyDown}
            className="min-w-0 flex-1"
          />
          <Button size="sm" variant="secondary" icon={<Plus aria-hidden />} disabled={draft.trim() === ""} onClick={add}>
            {t("加入")}
          </Button>
        </div>
        {problem ? (
          <p id={`${id}-problem`} role="alert" className="text-caption text-warning animate-fade-in">
            {problem}
          </p>
        ) : null}
        {choices.fixedSeeds.length > 0 ? (
          <ul aria-label={t("固定的 seed")} className="flex flex-wrap gap-1">
            {choices.fixedSeeds.map((seed) => (
              <li key={seed} className="inline-flex items-center gap-0.5 rounded-full border border-brand-blue/40 bg-brand-soft py-px pr-0.5 pl-2 text-caption text-fg animate-pop-in">
                <span className="machine">{seed}</span>
                <button
                  type="button"
                  aria-label={t("移除 seed {seed}", { seed })}
                  title={t("移除 seed {seed}", { seed })}
                  onClick={() => onChange({ ...choices, fixedSeeds: choices.fixedSeeds.filter((item) => item !== seed) })}
                  className="pressable grid size-5 place-items-center rounded-full text-fg-tertiary hover:bg-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-focus"
                >
                  <X aria-hidden className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

export function FileChoices({ shot, choices, onChange, library }: AxisProps & { library: readonly StudioLibraryItem[] }) {
  const id = useId();
  const refs = shot.references ?? [];
  const items = new Map(library.map((item) => [item.item_id, item]));
  const ref = choices.files ? refs.find((item) => item.ref_id === choices.files?.refId) : undefined;
  const chosen = choices.files?.itemIds ?? [];
  const toggle = (itemId: string, checked: boolean) => {
    if (!ref) return;
    onChange({ ...choices, files: { refId: ref.ref_id, itemIds: checked ? [...chosen, itemId] : chosen.filter((item) => item !== itemId) } });
  };
  return (
    <section aria-labelledby={`${id}-title`} className="grid gap-2">
      <h3 id={`${id}-title`} className={SECTION_TITLE}>
        {t("參考檔案")}
      </h3>
      <Select
        compact
        aria-label={t("換哪個參考的檔案")}
        value={ref?.ref_id ?? ""}
        onChange={(event) => {
          const next = refs.find((item) => item.ref_id === event.target.value);
          onChange({ ...choices, files: next ? { refId: next.ref_id, itemIds: [next.item_id] } : null });
        }}
      >
        <option value="">{t("不換檔案")}</option>
        {refs.map((item) => (
          <option key={item.ref_id} value={item.ref_id}>
            {t("換 @{alias} 的檔案（目前：{name}）", { alias: item.alias, name: items.get(item.item_id)?.name ?? t("不在素材庫") })}
          </option>
        ))}
      </Select>
      {ref ? (
        <div role="group" aria-label={t("@{alias} 要試的檔案", { alias: ref.alias })} className="grid gap-1 animate-reveal">
          {fileChoices(ref, library).map((item, index) => {
            const own = item.item_id === ref.item_id;
            const facts = itemFacts(item);
            // The clip window goes back to the whole file when this one cannot hold it (replacedReference)
            const unclipped = !own && ref.kind !== "image" && !clipFits(ref, item.duration_seconds);
            return (
              <ChoiceRow key={item.item_id} index={index} checked={chosen.includes(item.item_id)} onChange={(checked) => toggle(item.item_id, checked)} title={item.name}>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate text-data text-fg">{item.name}</span>
                  {own ? <span className={OWN_CHIP}>{t("目前")}</span> : null}
                </span>
                <span className={cn("truncate text-caption", unclipped ? "text-warning" : "text-fg-tertiary")}>
                  {unclipped ? t("片段放不下：這個檔案用整段") : facts || t("圖片")}
                </span>
              </ChoiceRow>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

export function RouteChoices({ shot, choices, onChange, routes }: AxisProps & { routes: readonly StudioRoute[] }) {
  const id = useId();
  const { catalog } = useStudio();
  const chosen = choices.routes ?? [shot.route];
  const toggle = (routeId: string, checked: boolean) => {
    onChange({ ...choices, routes: routes.filter((route) => (route.id === routeId ? checked : chosen.includes(route.id))).map((route) => route.id) });
  };
  return (
    <section aria-labelledby={`${id}-title`} className="grid gap-2">
      <h3 id={`${id}-title`} className={SECTION_TITLE}>
        {t("路線")}
      </h3>
      <div role="group" aria-labelledby={`${id}-title`} className="grid gap-1">
        {routes.map((route, index) => {
          const face = routeFace(route, catalog);
          return (
            <ChoiceRow key={route.id} index={index} checked={chosen.includes(route.id)} onChange={(checked) => toggle(route.id, checked)} title={route.ready ? face.title : `${face.title}\n${route.summary}`}>
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="min-w-0 truncate text-data text-fg">{face.name}</span>
                {route.id === shot.route ? <span className={OWN_CHIP}>{t("目前")}</span> : null}
              </span>
              <span className="flex min-w-0 items-center gap-1.5 text-caption text-fg-tertiary">
                <ReadyDot ready={route.ready} />
                <span className="truncate">{face.machine ?? route.capability}</span>
              </span>
              <RouteCaveatLine route={route} />
            </ChoiceRow>
          );
        })}
      </div>
    </section>
  );
}
