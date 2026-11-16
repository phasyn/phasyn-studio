// 目前專案的設定（專案對話框內）：名稱、畫面格式、新鏡頭預設時長與路由（元件組合）、專案資訊與刪除。
// 原本在屬性面板的「專案」分頁；改在這裡編輯，屬性面板專心處理鏡頭。
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Settings2, Trash2 } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { isApiError } from "@/api/http";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/controls";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { formatTimestamp } from "@/lib/format";
import { deleteProject, studioKeys } from "@/api/studioProjects";
import { formatDuration, formatTimecode, frameOptions, H3_FPS } from "../model/frames";
import { shotStatus } from "../model/project";
import { findRoute, ROUTE_MISSING } from "../model/routes";
import { useEditor } from "../editor/editorContext";
import { filmOrder } from "../editor/sources";
import { useStudio } from "../studioContext";
import { FormatPicker } from "./FormatPicker";
import { RoutesUnavailable } from "./routeParts";
import { t, tServer } from "@/i18n";

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-1">
      <label htmlFor={htmlFor} className="text-caption font-medium text-fg-secondary">
        {label}
      </label>
      {children}
      {hint ? <p className="text-caption text-pretty text-fg-tertiary">{hint}</p> : null}
    </div>
  );
}

/** 畫面格式（專案設定與「畫質」分頁共用）：推薦尺寸或自訂寬×高；改格式後已渲染的鏡頭會標示「設定已變更」。 */
export function FormatSelect({ id, className }: { id: string; className?: string }) {
  const { project, dispatch } = useStudio();
  return (
    <FormatPicker
      id={id}
      width={project.format.width}
      height={project.format.height}
      onChange={(width, height) => dispatch({ type: "setFormat", width, height })}
      className={className}
    />
  );
}

function DeleteProject() {
  const { project, notify } = useStudio();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [deleting, setDeleting] = useState(false);
  const remove = async () => {
    setDeleting(true);
    try {
      await deleteProject(project.project_id, project.revision);
      client.removeQueries({ queryKey: studioKeys.project(project.project_id) });
      await client.invalidateQueries({ queryKey: studioKeys.projects() });
      void navigate("/studio/edit", { replace: true });
    } catch (error) {
      notify({ tone: "danger", title: t("無法刪除專案"), detail: isApiError(error) ? t("{code}：{message}", { code: error.code, message: tServer(error.message) }) : String(error) });
      setDeleting(false);
    }
  };
  const takes = project.shots.reduce((sum, shot) => sum + shot.takes.length, 0);
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" variant="danger" icon={<Trash2 aria-hidden />} className="justify-self-start">
          {t("刪除專案…")}
        </Button>
      </DialogTrigger>
      <DialogContent onKeyDown={(event) => event.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>{t("刪除專案「{title}」？", { title: project.title })}</DialogTitle>
          <DialogDescription>{t("只刪除專案文件（鏡頭、prompt、素材庫與 take 參照）。已產生的影片檔、上傳的參考檔、run 與效能紀錄仍保留在主控與 Node。")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <p className="text-data text-fg-secondary">
            {t("{shotsCount} 個鏡頭、{takes} 個 take 的參照會消失，無法復原。", { shotsCount: project.shots.length, takes })}
          </p>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button>{t("取消")}</Button>
          </DialogClose>
          <Button variant="danger-confirm" icon={<Trash2 aria-hidden />} pending={deleting} onClick={() => void remove()}>
            {t("刪除專案")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ProjectSettings({ onNavigate }: { onNavigate?: () => void }) {
  const { project, dispatch, engine, timeline, totalFrames, fps } = useEditor();
  const id = useId();
  const [title, setTitle] = useState<string | null>(null);
  const placed = filmOrder(project, timeline).placed.length;
  const rendered = project.shots.filter((shot) => shotStatus(shot, project) === "ready").length;
  const defaultRoute = findRoute(engine.routes, project.defaults.route);
  return (
    <section aria-labelledby={`${id}-heading`} className="grid gap-3 rounded-lg border border-line-subtle bg-canvas/60 p-3">
      <h3 id={`${id}-heading`} className="flex items-center gap-2 text-data font-semibold text-fg">
        <Settings2 aria-hidden className="size-4 text-brand-cyan/80" />
        {t("目前專案的設定")}
      </h3>
      <Field label={t("專案名稱")} htmlFor={`${id}-title`} hint={title !== null && !title.trim() ? t("名稱不能是空白；保留原本的名稱") : undefined}>
        <Input
          id={`${id}-title`}
          compact
          value={title ?? project.title}
          maxLength={200}
          onChange={(event) => {
            // 每次輸入都寫進專案（空白不套用）；關閉對話框也不會遺失已輸入的名稱
            setTitle(event.target.value);
            dispatch({ type: "rename", title: event.target.value });
          }}
          onBlur={() => setTitle(null)}
        />
      </Field>
      <Field label={t("畫面格式")} htmlFor={`${id}-format`} hint={t("套用到專案中所有鏡頭；改格式後，已渲染的鏡頭會標示「設定已變更」，需要重新渲染。")}>
        <FormatSelect id={`${id}-format`} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("新鏡頭預設時長")} htmlFor={`${id}-frames`}>
          <Select id={`${id}-frames`} compact value={project.defaults.frames} onChange={(event) => dispatch({ type: "setDefaults", patch: { frames: Number(event.target.value) } })}>
            {frameOptions().map((frames) => (
              <option key={frames} value={frames}>
                {formatDuration(frames)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("新鏡頭預設路由")} htmlFor={`${id}-route`} hint={engine.status === "ready" && !defaultRoute ? undefined : t("新增鏡頭時使用的元件組合")}>
          <Select
            id={`${id}-route`}
            compact
            value={project.defaults.route}
            disabled={engine.status !== "ready" || engine.routes.length === 0}
            onChange={(event) => dispatch({ type: "setDefaults", patch: { route: event.target.value } })}
          >
            {defaultRoute ? null : <option value={project.defaults.route}>{engine.status === "ready" ? t("路由不存在（{route}）", { route: project.defaults.route }) : t("讀取元件組合…")}</option>}
            {engine.routes.map((route) => (
              <option key={route.id} value={route.id}>
                {t("{label}（{capability}）{value}", { label: route.label, capability: route.capability, value: route.ready ? "" : t("・未就緒") })}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {engine.status === "ready" && !defaultRoute && engine.routes.length > 0 ? (
        <p className="flex items-start gap-1.5 text-caption text-warning">
          <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {t("{routeMissing}：新鏡頭會改用第一個就緒的元件組合，直到這裡選定一個。", { routeMissing: ROUTE_MISSING })}
        </p>
      ) : null}
      <RoutesUnavailable engine={engine} onNavigate={onNavigate} />
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg border border-line-subtle bg-surface px-2.5 py-2 text-caption">
        <dt className="text-fg-tertiary">{t("影格率")}</dt>
        <dd className="machine text-fg">{t("{h3Fps} fps（H3 固定）", { h3Fps: H3_FPS })}</dd>
        <dt className="text-fg-tertiary">{t("鏡頭")}</dt>
        <dd className="text-fg">
          {t("{shotsCount} 個（時間軸上 {placed}、已渲染 {rendered}）", { shotsCount: project.shots.length, placed, rendered })}
        </dd>
        <dt className="text-fg-tertiary">{t("序列長度")}</dt>
        <dd className="machine text-fg">
          {t("{totalFrames}（{totalFrames2}）", { totalFrames: formatTimecode(totalFrames, fps), totalFrames2: formatDuration(totalFrames, fps) })}
        </dd>
        <dt className="text-fg-tertiary">{t("版本")}</dt>
        <dd className="machine text-fg">{t("r{revision}・{updated_at}", { revision: project.revision, updated_at: formatTimestamp(project.updated_at) })}</dd>
      </dl>
      <DeleteProject />
    </section>
  );
}
