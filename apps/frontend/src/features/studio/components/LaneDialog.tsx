// DiT lanes: choose the routes a project's renders are spread over (model/lanes.ts), for a site with more than one DiT.
// The trigger sits next to 批次渲染 in the shot list. Each route is listed by where its DiT runs, with whether its
// speed is known yet (LaneChoices.tsx). The choice is kept per browser (model/lanePrefs.ts) and applies to every
// render of the project's shots from this browser; the route each shot gets is written into it when a render is sent.
import { Split } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { TOOL_BUTTON_ON } from "@/components/ui/look";
import { cn } from "@/lib/cn";
import { setProjectLanes, useProjectLanes } from "../model/lanePrefs";
import { laneRoutes, lanesProblem, MIN_LANES, readyLanes } from "../model/lanes";
import { useStudio } from "../studioContext";
import { LaneChoices } from "./LaneChoices";
import { t } from "@/i18n";

export function LaneDialog() {
  const id = useId();
  const { project, engine } = useStudio();
  const stored = useProjectLanes(project.project_id);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const listed = laneRoutes(engine.routes);
  // A chosen route that no longer exists stays listed, so it can be unticked
  const unknown = selected.filter((routeId) => !engine.routes.some((route) => route.id === routeId));
  const active = stored.length >= MIN_LANES;
  const storedProblem = active ? lanesProblem(engine.routes, stored) : null;
  const ready = active ? readyLanes(engine.routes, stored).length : 0;
  const problem = selected.length > 0 ? lanesProblem(engine.routes, selected) : null;

  const onOpenChange = (next: boolean) => {
    if (next) setSelected(stored);
    setOpen(next);
  };
  const toggle = (routeId: string, on: boolean) => {
    // Keep the order of the list: a tie between lanes goes to the one listed first
    const wanted = new Set(on ? [...selected, routeId] : selected.filter((item) => item !== routeId));
    setSelected([...engine.routes.map((route) => route.id).filter((item) => wanted.has(item)), ...unknown.filter((item) => wanted.has(item))]);
  };
  const apply = () => {
    setProjectLanes(project.project_id, selected);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button
          size="icon-sm"
          variant="secondary"
          icon={<Split aria-hidden />}
          aria-label={t("DiT 分流")}
          aria-pressed={active}
          title={
            (storedProblem != null && storedProblem !== "")
              ? t("DiT 分流有問題：{problem}", { problem: storedProblem })
              : active
                ? ready === 0
                  ? t("DiT 分流：開，但 {count} 條元件組合都未就緒", { count: stored.length })
                  : t("DiT 分流：開（{count} 條元件組合，{ready} 條就緒）", { count: stored.length, ready })
                : t("DiT 分流：把渲染分配到多條元件組合（多顆 DiT）")
          }
          className={cn("shrink-0", active && TOOL_BUTTON_ON, (storedProblem !== null || (active && ready === 0)) && "ring-1 ring-warning/60 ring-inset")}
        />
      </DialogTrigger>
      <DialogContent onKeyDown={(event) => { event.stopPropagation(); }}>
        <DialogHeader>
          <DialogTitle>{t("DiT 分流")}</DialogTitle>
          <DialogDescription>
            {t(
              "有不只一顆 DiT 時（例如另一台機器），這個專案的渲染會分配到多條元件組合：批次渲染時每個鏡頭交給預估最早算完它的那一條，單獨渲染一個鏡頭時用預估最快的那一條。速度來自主控的耗時紀錄。",
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-3">
          {listed.length < MIN_LANES && unknown.length === 0 ? (
            <Callout tone="info">
              {t("分流至少需要兩條有 DiT 的元件組合。先建立另一條把 DiT 指到另一張 GPU 或另一台機器的元件組合，並啟動它需要的元件。")}
            </Callout>
          ) : (
            <LaneChoices listed={listed} unknown={unknown} selected={selected} onToggle={toggle} describedBy={`${id}-note`} />
          )}
          {(problem != null && problem !== "") ? (
            <Callout tone="warning">{problem}</Callout>
          ) : selected.length >= MIN_LANES ? (
            // The controller stops a run at its first failed step: with lanes every DiT is needed until the batch ends
            <Callout tone="info">{t("分流時整批渲染從頭到尾都會用到每一顆 DiT：其中一顆中途出錯，整個 run 會停下（已完成的鏡頭保留，其餘可以再按一次批次渲染）。長時間、無人看管的批次，先用短批次確認另一顆 DiT 撐得住。")}</Callout>
          ) : null}
          <p id={`${id}-note`} className="text-caption text-fg-tertiary">
            {t(
              "每個鏡頭用哪一條會在送出渲染時決定並寫進鏡頭的元件組合，看得到它在哪裡渲染；下次渲染時會重新選。未就緒的元件組合會略過（例如另一台機器重開後 DiT 還沒載入）。這個設定只存在這個瀏覽器，從其他瀏覽器渲染時不分流。",
            )}
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="quiet" onClick={() => { setSelected([]); }} disabled={selected.length === 0} className="mr-auto">
            {t("不分流")}
          </Button>
          <DialogClose asChild>
            <Button variant="secondary">{t("取消")}</Button>
          </DialogClose>
          <Button variant="primary" onClick={apply} disabled={problem !== null}>
            {t("套用")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
