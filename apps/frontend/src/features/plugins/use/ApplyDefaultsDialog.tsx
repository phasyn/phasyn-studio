// 套用一個生成設定的預設值：先列出每一項「目前 → 套用後」，使用者確認後才寫進專案（看得見的一次寫入；渲染時從不自動
// 套用）。畫面是整個專案的；影格數與步數同時寫進新鏡頭的預設與選定的鏡頭；shift 只有鏡頭有。範圍可以是目前的鏡頭或全部鏡頭：
// 選全部時列出會改變的每一個鏡頭與它目前的值；沒有任何一項會改變時不能套用。這是專案設定的變更，不在剪輯的復原歷程裡。
import { ArrowRight } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { generationLabel } from "../model/evaluate";
import { formatGenerationValue, generationDefaults, type FrameSize, type GenerationDefault } from "../model/generation";
import type { RegistryGeneration } from "../model/registry";

export interface GenerationValues {
  format?: FrameSize;
  frames?: number;
  steps?: number;
  video_shift?: number;
  audio_shift?: number;
}

export type GenerationScope = "shot" | "all";

/** 一個鏡頭目前的生成設定。 */
export interface ShotGenerationValues {
  id: string;
  title: string;
  frames: number;
  steps: number | null;
  video_shift: number | null;
  audio_shift: number | null;
}

/** 專案目前的值與寫入的方法（由 Studio 提供）。 */
export interface GenerationTarget {
  format: FrameSize;
  /** 新鏡頭的預設。 */
  defaults: { frames: number; steps: number | null };
  /** 目前選取的鏡頭；沒有時為 null。 */
  shot: ShotGenerationValues | null;
  /** 專案的每一個鏡頭（範圍選「全部」時要列出哪些會改變）。 */
  shots: readonly ShotGenerationValues[];
  apply: (values: GenerationValues, scope: GenerationScope) => void;
}

interface Row {
  key: string;
  label: string;
  from: string;
  to: string;
  /** 這一項會改變幾個地方（0＝已經是這個值）。 */
  changes: number;
}

/** 範圍是「全部」時，一個鏡頭會改變的值。 */
interface ShotChange {
  id: string;
  title: string;
  parts: string[];
}

const unset = () => t("元件預設");
const shown = (value: number | null) => (value === null ? unset() : String(value));

type ShotField = "frames" | "steps" | "video_shift" | "audio_shift";

function rowsFor(item: GenerationDefault, target: GenerationTarget, scope: GenerationScope): Row[] {
  const to = item.text;
  const one = (key: string, label: string, from: string): Row => ({ key, label, from, to, changes: from === to ? 0 : 1 });
  if (item.field === "format") return [one("format", t("專案的畫面"), formatGenerationValue(target.format))];
  const field: ShotField = item.field;
  const rows: Row[] = [];
  if (field === "frames" || field === "steps") rows.push(one(`${field}:defaults`, t("新鏡頭的{label}", { label: item.label }), shown(target.defaults[field])));
  if (scope === "all") {
    const current = target.shots.map((shot) => shown(shot[field]));
    const distinct = [...new Set(current)];
    rows.push({
      key: `${field}:all`,
      label: t("全部 {count} 個鏡頭的{label}", { count: target.shots.length, label: item.label }),
      from: distinct.length === 1 ? (distinct[0] ?? to) : t("{count} 種不同的值", { count: distinct.length }),
      to,
      changes: current.filter((value) => value !== to).length,
    });
  } else if (target.shot) rows.push(one(`${field}:shot`, t("這個鏡頭的{label}", { label: item.label }), shown(target.shot[field])));
  return rows;
}

/** 範圍是「全部」時會改變的鏡頭，各自列出「欄位 目前的值」。 */
function shotChanges(defaults: readonly GenerationDefault[], shots: readonly ShotGenerationValues[]): ShotChange[] {
  const perShot = defaults.flatMap((item) => (item.field === "format" ? [] : [{ field: item.field, label: item.label, to: item.text }]));
  return shots.flatMap((shot) => {
    const parts = perShot.filter((item) => shown(shot[item.field]) !== item.to).map((item) => t("{label} {value}", { label: item.label, value: shown(shot[item.field]) }));
    return parts.length > 0 ? [{ id: shot.id, title: shot.title, parts }] : [];
  });
}

function values(defaults: readonly GenerationDefault[]): GenerationValues {
  const out: GenerationValues = {};
  for (const item of defaults) {
    if (item.field === "format" && typeof item.value === "object") out.format = item.value;
    else if (item.field !== "format" && typeof item.value === "number") out[item.field] = item.value;
  }
  return out;
}

export function ApplyDefaultsDialog({ entry, target, onClose }: { entry: RegistryGeneration | null; target: GenerationTarget; onClose: () => void }) {
  const scopeName = useId();
  const [scope, setScope] = useState<GenerationScope>("shot");
  const defaults = entry ? generationDefaults(entry.generation) : [];
  const perShot = defaults.some((item) => item.field !== "format");
  const effective: GenerationScope = target.shot ? scope : "all";
  const rows = defaults.flatMap((item) => rowsFor(item, target, effective));
  const changed = rows.filter((row) => row.changes > 0);
  const affected = effective === "all" ? shotChanges(defaults, target.shots) : [];
  const options: { id: GenerationScope; label: string }[] = [
    ...(target.shot ? [{ id: "shot" as const, label: t("這個鏡頭「{title}」", { title: target.shot.title }) }] : []),
    { id: "all", label: t("全部 {count} 個鏡頭", { count: target.shots.length }) },
  ];
  return (
    <Dialog
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {entry ? (
        <DialogContent onKeyDown={(event) => event.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>{t("套用「{label}」的設定？", { label: generationLabel(entry) })}</DialogTitle>
            <DialogDescription>
              {t("這些值會寫進專案；已經渲染的鏡頭會標示「設定已變更」，重新渲染才會反映。這不是剪輯步驟，不能用復原還原。")}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-4">
            {perShot && target.shots.length > 0 ? (
              <fieldset className="grid gap-1.5">
                <legend className="pb-1 text-caption font-semibold text-fg-tertiary">{t("鏡頭的範圍")}</legend>
                {options.map((option) => (
                  <label key={option.id} className="flex min-h-9 cursor-pointer items-center gap-2.5 text-body text-fg">
                    <input type="radio" name={scopeName} checked={effective === option.id} onChange={() => setScope(option.id)} className="size-4 accent-action" />
                    <span className="truncate">{option.label}</span>
                  </label>
                ))}
              </fieldset>
            ) : null}
            <table className="w-full border-collapse text-left text-data">
              <thead>
                <tr className="text-caption text-fg-tertiary">
                  <th className="pb-1.5 font-medium">{t("項目")}</th>
                  <th className="pb-1.5 font-medium">{t("目前")}</th>
                  <th aria-hidden className="w-6" />
                  <th className="pb-1.5 font-medium">{t("套用後")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const same = row.changes === 0;
                  return (
                    <tr key={row.key} className={cn("border-t border-line-subtle", same && "text-fg-tertiary")}>
                      <td className="py-2 pr-3 text-fg-secondary">{row.label}</td>
                      <td className="machine py-2 pr-2">{row.from}</td>
                      <td aria-hidden className="py-2 text-fg-tertiary">
                        <ArrowRight className="size-3.5" />
                      </td>
                      <td className={cn("machine py-2 font-semibold", same ? "" : "text-fg")}>{same ? t("已相同") : row.to}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {affected.length > 0 ? (
              <section className="grid gap-1.5">
                <h3 className="text-caption font-semibold text-fg-tertiary">{t("會改變的鏡頭（{count}）與它們目前的值", { count: affected.length })}</h3>
                <ul className="grid max-h-40 divide-y divide-line-subtle overflow-y-auto rounded-lg border border-line-subtle bg-canvas/60">
                  {affected.map((shot) => (
                    <li key={shot.id} className="flex min-w-0 items-baseline gap-3 px-3 py-1.5 text-data">
                      <span title={shot.title} className="min-w-0 flex-1 truncate text-fg">
                        {shot.title}
                      </span>
                      <span className="machine shrink-0 text-caption text-fg-tertiary">{shot.parts.join(t("・"))}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button>{t("取消")}</Button>
            </DialogClose>
            <Button
              variant="primary"
              disabled={changed.length === 0}
              title={changed.length === 0 ? t("專案已經是這些值") : undefined}
              onClick={() => {
                target.apply(values(defaults), effective);
                onClose();
              }}
            >
              {t("套用")}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
