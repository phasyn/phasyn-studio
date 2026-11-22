import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookUser } from "lucide-react";
import { useState } from "react";
import type { StudioProject } from "@/api/generated/contracts";
import { contractJson } from "@/api/http";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { t } from "@/i18n";
import { useStudio } from "../studioContext";
import { Bindings } from "./Bindings";
import { Entries } from "./Entries";
import { bindingRead, creativeRoot, shotPath } from "./api";
import { Status } from "./fields";

// 角色與場景: the project's character and scene settings (設定庫) and which of them each shot uses (套用到鏡頭). Driving
// media for 表演影片／音訊驅動 are chosen in the shot's References tab and render with 渲染鏡頭, so the old media binding
// and its separate run submission (版本與執行) are gone.
type CreativeTab = "entries" | "bind";

export function CreativeLauncher({ compact }: { compact: boolean }) {
  const { project, flush, selectedShotId } = useStudio();
  const [open, setOpen] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [ready, setReady] = useState(false);
  async function enter() {
    setReady(false);
    setFailure(null);
    try {
      await flush();
      setReady(true);
    } catch (e) {
      setFailure(e);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) void enter();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="secondary" size="md" title={t("角色與場景")} icon={<BookUser aria-hidden />}>
          <span className={compact ? "sr-only" : undefined}>{t("角色與場景")}</span>
        </Button>
      </DialogTrigger>
      <DialogContent wide onKeyDown={(e) => { e.stopPropagation(); }}>
        <DialogHeader>
          <DialogTitle>{t("角色與場景")}</DialogTitle>
          <DialogDescription>{project.title}</DialogDescription>
        </DialogHeader>
        <DialogBody className="min-h-0">
          {open && ready ? (
            <Workspace key={project.project_id} project={project} shotId={selectedShotId} />
          ) : (
            <Status error={failure} message={t("正在讀取設定")} />
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
function Workspace({ project, shotId }: { project: StudioProject; shotId: string | null }) {
  const client = useQueryClient();
  const [tab, setTab] = useState<CreativeTab>("entries");
  const [target, setTarget] = useState(() => {
    const first = project.shots.find((item) => item.shot_id === shotId) ?? project.shots[0];
    if (first) return "video/" + first.shot_id;
    const image = project.image_shots?.[0];
    return image ? "image/" + image.image_shot_id : "";
  });
  const split = target.indexOf("/");
  const medium = target.slice(0, split) === "image" ? "image" : "video";
  const shot = target.slice(split + 1);
  const path = shotPath(project.project_id, medium, shot);
  const list = useQuery({
    queryKey: ["creative-entries", project.project_id],
    queryFn: ({ signal }) => contractJson("StudioCreativeEntryList", creativeRoot(project.project_id) + "/entries", { signal }),
    retry: false,
  });
  const binding = useQuery({
    queryKey: ["creative-binding", path],
    queryFn: ({ signal }) => bindingRead(path, undefined, signal),
    enabled: !!shot,
    retry: false,
  });
  const refresh = async () => {
    await Promise.all([
      list.refetch(),
      shot ? binding.refetch() : undefined,
      client.invalidateQueries({ queryKey: ["creative-entry", project.project_id] }),
    ]);
  };
  return (
    <div className="space-y-4">
      <nav aria-label={t("創作設定頁籤")} className="flex gap-1 rounded-lg border border-line bg-sunken p-1">
        {(
          [
            ["entries", t("設定庫")],
            ["bind", t("套用到鏡頭")],
          ] as const
        ).map(([key, label]) => (
          <Button
            key={key}
            type="button"
            size="sm"
            aria-pressed={tab === key}
            disabled={key !== "entries" && !shot}
            variant={tab === key ? "secondary" : "quiet"}
            onClick={() => { setTab(key); }}
          >
            {label}
          </Button>
        ))}
      </nav>
      <Status error={list.error} />
      {tab === "bind" ? (
        <label className="block text-caption text-fg-secondary">
          {t("目標鏡頭")}
          <Select compact value={target} onChange={(e) => { setTarget(e.target.value); }}>
            <optgroup label={t("影片鏡頭")}>
              {project.shots.map((s) => (
                <option key={s.shot_id} value={`video/${s.shot_id}`}>
                  {s.title}
                </option>
              ))}
            </optgroup>
            <optgroup label={t("圖像鏡頭")}>
              {project.image_shots?.map((s) => (
                <option key={s.image_shot_id} value={`image/${s.image_shot_id}`}>
                  {s.title}
                </option>
              ))}
            </optgroup>
          </Select>
        </label>
      ) : null}
      <div key={tab + path} className="animate-fade-in">
        {tab === "entries" ? (
          <Entries project={project} entries={list.data?.items ?? []} refresh={refresh}
            reviewShot={(kind, id) => { setTarget(kind + "/" + id); setTab("bind"); }} />
        ) : binding.isPending ? (
          <Status message={t("正在讀取設定")} />
        ) : binding.error ? (
          <Status error={binding.error} />
        ) : (
          <Bindings
            key={binding.data?.latest_revision ?? 0}
            project={project}
            entries={list.data?.items ?? []}
            path={path}
            medium={medium}
            binding={binding.data ?? null}
            saved={refresh}
          />
        )}
      </div>
    </div>
  );
}
