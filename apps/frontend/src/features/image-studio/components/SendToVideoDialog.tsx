// 「用在影片鏡頭」：選同一個專案的影片鏡頭（或新增一個），把這個 take 的白底版當 ref2va 參考圖或 fl2va 首幀（比例必須與專案
// 畫面相同，否則 H3 會把首幀拉伸變形：停用並說明）。白底版還不在素材庫時一併加入。鏡頭的運算路由不是對應的元件組合時，可以一起
// 改成使用者選的元件組合（預設選第一個就緒的；也可以選「不改」）。套用後可以先保存再切到影片 Studio 的那個鏡頭。
import { CircleCheck, Clapperboard, Film, ImagePlus, Link2, Plus } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CHOICE_BASE, CHOICE_IDLE, CHOICE_SELECTED, RISE_IN } from "@/components/ui/look";
import { cn } from "@/lib/cn";
import { defaultRouteFor, newLocalId, newShot } from "@/features/studio";
import { useImageStudio } from "../imageStudioContext";
import { whiteItemId } from "../model/reconcile";
import { attachFirstFrame, attachReference, firstFrameBlockedReason, routesFor, videoShotOptions, whiteLibraryItem, type VideoUse } from "../model/sendToVideo";
import { imageShots, takeNumber } from "../model/shots";
import type { StudioImageShot, StudioImageTake } from "../types";
import { ImageThumb } from "./ImageThumb";
import { ReadyDot } from "./marks";
import { t } from "@/i18n";

const NEW_SHOT = "__new__";
const KEEP_ROUTE = "__keep__";

interface Done {
  videoShotId: string;
  title: string;
  alias: string | null;
  use: VideoUse;
}

function Body({ shot, take, onDone, onCancel }: { shot: StudioImageShot; take: StudioImageTake; onDone: (done: Done) => void; onCancel: () => void }) {
  const { project, engine, dispatch, notify } = useImageStudio();
  const id = useId();
  const [use, setUse] = useState<VideoUse>("ref2va");
  const white = useMemo(() => whiteLibraryItem(project, shot, take, whiteItemId(take), new Date().toISOString()), [project, shot, take]);
  const itemId = white.item?.item_id ?? null;
  const options = videoShotOptions(project, use, white.existing ? itemId : null, engine.videoRoutes);
  const firstOpen = options.find((option) => option.blocked === null)?.shot.shot_id ?? NEW_SHOT;
  const [target, setTarget] = useState<string>(firstOpen);
  const selected = options.find((option) => option.shot.shot_id === target) ?? null;
  const targetId = selected && selected.blocked === null ? selected.shot.shot_id : target === NEW_SHOT ? NEW_SHOT : null;
  const candidates = routesFor(use, engine.videoRoutes);
  const needsRoute = target === NEW_SHOT || (selected?.route?.capability ?? null) !== use;
  const preferred = candidates.find((route) => route.ready) ?? candidates[0];
  const [routeChoice, setRouteChoice] = useState<string | null>(null);
  const route = needsRoute ? (routeChoice ?? preferred?.id ?? KEEP_ROUTE) : KEEP_ROUTE;
  const fl2vaBlocked = firstFrameBlockedReason(project, white.item);
  const blocked = white.problem ?? (use === "fl2va" ? fl2vaBlocked : null) ?? (targetId === null ? t("選一個可以使用的影片鏡頭") : null);

  const apply = () => {
    const item = white.item;
    if (blocked || !item || !targetId) return;
    const routeId = route === KEEP_ROUTE ? null : route;
    if (targetId === NEW_SHOT) {
      const base = newShot(project, { route: routeId ?? defaultRouteFor(project, engine.videoRoutes) });
      const prepared = use === "ref2va" ? attachReference(base, item, newLocalId("ref")) : { shot: attachFirstFrame(base, item.item_id), alias: null, problem: null };
      if (!prepared.shot) {
        notify({ tone: "warning", title: t("沒有新增影片鏡頭"), detail: prepared.problem ?? undefined });
        return;
      }
      dispatch({ type: "addVideoShotWith", shot: prepared.shot, item, afterShotId: project.shots.at(-1)?.shot_id ?? null });
      onDone({ videoShotId: prepared.shot.shot_id, title: prepared.shot.title, alias: prepared.alias, use });
      return;
    }
    const current = project.shots.find((item2) => item2.shot_id === targetId);
    if (!current) return;
    const refId = newLocalId("ref");
    const alias = use === "ref2va" ? attachReference(current, item, refId).alias : null;
    dispatch({ type: "attachToVideoShot", videoShotId: targetId, use, item, refId, route: routeId });
    onDone({ videoShotId: targetId, title: current.title, alias, use });
  };

  return (
    <>
      <DialogBody className="grid gap-4">
        <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3">
          <ImageThumb file={take.image_white?.file ?? take.image?.file} className="aspect-square w-24 rounded-lg shadow-raised" backdrop="white" fit="contain" alt={t("白底版")} />
          <div className="grid gap-1 text-data">
            <p className="text-fg">{t("「{value}」take {takeNumber}・seed {seed}", { value: shot.title || t("未命名圖片"), takeNumber: takeNumber(shot, take.take_id), seed: take.seed })}</p>
            <p className="text-caption text-fg-tertiary">{white.existing ? t("一律使用白底版（H3 讀透明 PNG 時也是鋪白底）。已在素材庫（「{value}」）。", { value: white.item?.name ?? "" }) : t("一律使用白底版（H3 讀透明 PNG 時也是鋪白底）。會先加入專案素材庫。")}</p>
            {white.problem ? (
              <p role="alert" className="text-caption text-danger">
                {white.problem}
              </p>
            ) : null}
          </div>
        </div>

        <fieldset className="grid gap-1.5">
          <legend className="pb-1 text-caption font-medium text-fg-secondary">{t("用途")}</legend>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {(
              [
                { value: "ref2va", label: t("當 ref2va 參考圖"), hint: t("加到鏡頭的參考素材（@Image）"), icon: ImagePlus, disabled: null },
                { value: "fl2va", label: t("當 fl2va 首幀"), hint: t("影片從這張圖開始"), icon: Link2, disabled: fl2vaBlocked },
              ] as const
            ).map((option) => (
              <label
                key={option.value}
                title={option.disabled ?? undefined}
                className={cn(
                  "flex cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus",
                  CHOICE_BASE,
                  use === option.value ? CHOICE_SELECTED : CHOICE_IDLE,
                  option.disabled && "cursor-not-allowed opacity-70",
                )}
              >
                <input type="radio" name={`${id}-use`} checked={use === option.value} disabled={option.disabled !== null} onChange={() => setUse(option.value)} className="mt-0.5 accent-action" aria-describedby={option.disabled ? `${id}-${option.value}-reason` : undefined} />
                <span className="grid min-w-0 gap-0.5">
                  <span className="flex items-center gap-1.5 text-data text-fg">
                    <option.icon aria-hidden className="size-3.5 text-fg-tertiary" />
                    {option.label}
                  </span>
                  <span className="text-caption text-fg-tertiary">{option.hint}</span>
                  {option.disabled ? (
                    <span id={`${id}-${option.value}-reason`} className="text-caption text-warning">
                      {option.disabled}
                    </span>
                  ) : null}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="grid gap-1.5">
          <legend className="pb-1 text-caption font-medium text-fg-secondary">{t("影片鏡頭（同一個專案）")}</legend>
          <ul className="grid max-h-60 gap-1 overflow-y-auto" aria-label={t("影片鏡頭")}>
            {options.map((option) => (
              <li key={option.shot.shot_id}>
                <label
                  className={cn(
                    "flex items-start gap-2 rounded-lg px-2.5 py-1.5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus",
                    CHOICE_BASE,
                    option.blocked ? "cursor-not-allowed border-line-subtle bg-canvas opacity-70" : "cursor-pointer",
                    target === option.shot.shot_id && !option.blocked ? CHOICE_SELECTED : !option.blocked ? CHOICE_IDLE : "",
                  )}
                >
                  <input type="radio" name={`${id}-target`} checked={target === option.shot.shot_id} disabled={option.blocked !== null} onChange={() => setTarget(option.shot.shot_id)} className="mt-0.5 accent-action" />
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="flex min-w-0 items-center gap-1.5 text-data text-fg">
                      <span className="machine shrink-0 text-caption text-fg-tertiary">{String(option.index + 1).padStart(2, "0")}</span>
                      <Film aria-hidden className="size-3.5 shrink-0 text-entity" />
                      <span className="truncate">{option.shot.title || t("未命名鏡頭")}</span>
                    </span>
                    <span className="truncate text-caption text-fg-tertiary">
                      {t("{value}・參考素材 {valueCount} 個", { value: option.route ? t("{label}（{capability}）", { label: option.route.label, capability: option.route.capability }) : t("路由 {route}", { route: option.shot.route }), valueCount: (option.shot.references ?? []).length })}
                    </span>
                    {option.blocked ? <span className="text-caption text-fg-tertiary">{option.blocked}</span> : option.note ? <span className="text-caption text-warning">{option.note}</span> : null}
                  </span>
                </label>
              </li>
            ))}
            <li>
              <label className={cn("flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus", CHOICE_BASE, target === NEW_SHOT ? CHOICE_SELECTED : "border-dashed border-line bg-canvas hover:border-line-strong hover:bg-raised/60")}>
                <input type="radio" name={`${id}-target`} checked={target === NEW_SHOT} onChange={() => setTarget(NEW_SHOT)} className="accent-action" />
                <Plus aria-hidden className="size-3.5 text-fg-tertiary" />
                <span className="text-data text-fg">{t("新增一個影片鏡頭（放在最後）")}</span>
              </label>
            </li>
          </ul>
        </fieldset>

        {needsRoute ? (
          <label className="grid gap-1 text-caption font-medium text-fg-secondary">
            {target === NEW_SHOT ? t("新鏡頭的運算路由") : t("同時把這個鏡頭的運算路由改成 {use} 元件組合", { use })}
            <Select compact value={route} onChange={(event) => setRouteChoice(event.target.value)}>
              <option value={KEEP_ROUTE}>{target === NEW_SHOT ? t("專案預設（之後在 Video Studio 改）") : t("不改（之後在 Video Studio 改）")}</option>
              {candidates.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                  {item.ready ? "" : t("（未就緒）")}
                </option>
              ))}
            </Select>
            {candidates.length === 0 ? <span className="font-normal text-warning">{t("還沒有 {use} 的元件組合：到「元件修改・元件組合」建立後才能渲染。", { use })}</span> : null}
            {route !== KEEP_ROUTE && preferred ? (
              <span className="flex items-center gap-1.5 font-normal text-fg-tertiary">
                <ReadyDot ready={candidates.find((item) => item.id === route)?.ready ?? false} />
                {candidates.find((item) => item.id === route)?.summary ?? ""}
              </span>
            ) : null}
          </label>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onCancel}>
          {t("取消")}
        </Button>
        <Button variant="primary" icon={<Clapperboard aria-hidden />} disabled={blocked !== null} title={blocked ?? undefined} onClick={apply}>
          {target === NEW_SHOT ? t("新增鏡頭並套用") : t("套用到鏡頭")}
        </Button>
      </DialogFooter>
      {blocked && !white.problem ? <p className="sr-only">{blocked}</p> : null}
    </>
  );
}

export function SendToVideoDialog() {
  const { project, sendTarget, setSendTarget, openVideoStudio } = useImageStudio();
  const [done, setDone] = useState<Done | null>(null);
  const [leaving, setLeaving] = useState(false);
  const shot = sendTarget ? imageShots(project).find((item) => item.image_shot_id === sendTarget.shotId) : undefined;
  const take = sendTarget ? shot?.takes.find((item) => item.take_id === sendTarget.takeId) : undefined;
  const open = sendTarget !== null;
  const close = () => {
    setSendTarget(null);
    setDone(null);
  };
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("用在影片鏡頭")}</DialogTitle>
          <DialogDescription>{t("同一個專案的 Video Studio：把這張圖當角色參考圖（ref2va）或首幀（fl2va）。")}</DialogDescription>
        </DialogHeader>
        {done ? (
          <>
            <DialogBody className="grid gap-2">
              <p role="status" className={cn("flex items-start gap-2 text-data text-success", RISE_IN)}>
                <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 animate-pop-in" />
                <span>
                  {done.alias
                    ? t("已套用到影片鏡頭「{value}」：參考素材 @{alias}，在影片的 prompt 用 @{alias2} 引用這張圖。", { value: done.title || t("未命名鏡頭"), alias: done.alias, alias2: done.alias })
                    : done.use === "fl2va"
                      ? t("已套用到影片鏡頭「{value}」：首幀改成這張圖（fl2va；在影片鏡頭「生成」分頁的「首幀」可以查看或改回）。", { value: done.title || t("未命名鏡頭") })
                      : t("已套用到影片鏡頭「{value}」。", { value: done.title || t("未命名鏡頭") })}
                </span>
              </p>
              <p className="text-caption text-fg-tertiary">{t("專案會自動保存；切到 Video Studio 前會先等保存完成。")}</p>
            </DialogBody>
            <DialogFooter>
              <Button variant="secondary" onClick={close}>
                {t("留在 Image Studio")}
              </Button>
              <Button
                variant="primary"
                icon={<Clapperboard aria-hidden />}
                pending={leaving}
                onClick={() => {
                  if (leaving) return;
                  setLeaving(true);
                  const shotId = done.videoShotId;
                  void openVideoStudio(shotId).finally(() => {
                    setLeaving(false);
                    close();
                  });
                }}
              >
                {t("到 Video Studio 的這個鏡頭")}
              </Button>
            </DialogFooter>
          </>
        ) : shot && take ? (
          <Body key={take.take_id} shot={shot} take={take} onDone={setDone} onCancel={close} />
        ) : (
          <DialogBody>
            <p className="text-data text-fg-tertiary">{t("找不到這個 take（可能已被刪除）。")}</p>
          </DialogBody>
        )}
      </DialogContent>
    </Dialog>
  );
}
