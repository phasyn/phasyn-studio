// The shot's seed: 每次隨機 (-1: every render draws one, kept on its take) or 固定 (0–2147483647). Switching to 固定
// starts from the active take's seed (rendering again reproduces that take) or, without a take, a newly drawn seed —
// shown in the field at once. The field takes -1 as well (back to random), as before; an invalid entry keeps the old
// value and says why.
import { Dices } from "lucide-react";
import { useId } from "react";
import type { StudioShot } from "@/api/generated/contracts";
import { Button } from "@/components/ui/button";
import { activeTake, MAX_SEED, RANDOM_SEED, randomSeed } from "../../model/project";
import { useStudio } from "../../studioContext";
import { NumberField } from "../fields";
import { Segmented } from "./Segmented";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

type SeedMode = "random" | "fixed";

export function SeedForm({ shot }: { shot: StudioShot }) {
  const { dispatch } = useStudio();
  const id = useId();
  const random = shot.seed === RANDOM_SEED;
  const recordedSeed = activeTake(shot)?.seed ?? null;
  const update = (seed: number) => { dispatch({ type: "updateShot", shotId: shot.shot_id, patch: { seed } }); };
  return (
    <div className="grid gap-3 p-3">
      <p className="text-data font-semibold text-fg">Seed</p>
      <Segmented<SeedMode>
        name={`${id}-mode`}
        label={t("Seed 的方式")}
        value={random ? "random" : "fixed"}
        options={[
          { value: "random", label: t("每次隨機"), title: t("每次渲染抽一個新的 seed，記在 take 上") },
          { value: "fixed", label: t("固定"), title: t("每次渲染都用同一個 seed：相同設定可以重現同一個 take") },
        ]}
        onChange={(next) => { update(next === "random" ? RANDOM_SEED : (recordedSeed ?? randomSeed())); }}
      />
      {random ? (
        <p className="text-caption text-fg-tertiary">
          {recordedSeed !== null ? (
            <T source={"每次渲染抽一個新的 seed，記在 take 上；使用中 take 的 seed 是 <0>{seed}</0>。"} values={{ seed: recordedSeed }} slots={[<span key="slot-0" className="machine text-fg-secondary" />]} />
          ) : (
            t("每次渲染抽一個新的 seed，記在 take 上。")
          )}
        </p>
      ) : (
        <div className="grid gap-1.5 animate-reveal">
          <label htmlFor={`${id}-value`} className="text-caption font-medium text-fg-secondary">
            {t("固定的 seed")}
          </label>
          <div className="flex items-start gap-1.5">
            <NumberField id={`${id}-value`} integer value={shot.seed} min={RANDOM_SEED} max={MAX_SEED} onCommit={(value) => { update(value ?? RANDOM_SEED); }} describedBy={`${id}-rule`} className="min-w-0 flex-1" />
            <Button size="icon-sm" variant="secondary" icon={<Dices aria-hidden />} aria-label={t("換一個新的 seed")} title={t("換一個新的 seed")} onClick={() => { update(randomSeed()); }} />
          </div>
          <p id={`${id}-rule`} className="text-caption text-fg-tertiary">
            {t("0–{max}；輸入 -1 改回每次隨機。", { max: MAX_SEED })}
          </p>
          {recordedSeed !== null && recordedSeed !== shot.seed ? (
            <Button size="sm" variant="quiet" className="justify-self-start px-2" onClick={() => { update(recordedSeed); }}>
              <T source={"改用使用中 take 的 seed（<0>{seed}</0>）"} values={{ seed: recordedSeed }} slots={[<span key="slot-0" className="machine" />]} />
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
