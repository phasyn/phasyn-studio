import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { StudioShot } from "@/api/generated/contracts";
import { useRunList } from "@/api/runs";
import { asAsset, type WireRun } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { t } from "@/i18n";
import { errorText } from "@/lib/errors";
import { isRecord } from "@/lib/json";
import { routeDisplayLabel, routeName } from "../model/routes";
import { useStudio } from "../studioContext";
import { RunOutputPicker } from "./RunOutputPicker";

type Adopt = (shotId: string, runId: string, outputKey: string, parentTakeId: string | null) => Promise<void>;
interface Props {
  shot: StudioShot;
  onAdopt: Adopt;
}

function publishedVideos(run: WireRun) {
  if (run.state !== "succeeded") return [];
  return Object.entries(run.outputs).flatMap(([key, output]) => {
    const asset = isRecord(output) && output["type_id"] === "media.asset.v1" ? asAsset(output["value"]) : null;
    if (
      asset?.complete !== true ||
      (asset.kind !== "final" && asset.kind !== "video") ||
      !asset.file.media_type.startsWith("video/") ||
      !asset.fps || Math.min(asset.width, asset.height, asset.frame_count, asset.file.size_bytes) <= 0
    ) return [];
    return [{ asset, key, run, id: run.run_id + "/" + key }];
  });
}

function MediaPicker({ shot, onAdopt }: Props) {
  const runs = useRunList(25, "include", undefined, "summary");
  const { engine } = useStudio();
  const [choice, setChoice] = useState("");
  const [parent, setParent] = useState("");
  const options = useMemo(() => runs.data?.pages.flatMap((page) => page.items.flatMap(publishedVideos)) ?? [], [runs.data]);
  const selected = options.find((entry) => entry.id === choice);
  const already = selected && shot.takes.find((take) =>
    take.run_id === selected.run.run_id && take.output_key === selected.key,
  );
  // Numbered as the take strip numbers them (the position among all of the shot's takes)
  const parents = shot.takes.flatMap((take, index) => take.state === "succeeded" && take.asset?.complete === true ? [{ take, n: index + 1 }] : []);
  const mutation = useMutation({
    mutationFn: async () => {
      if (selected && !already) await onAdopt(shot.shot_id, selected.run.run_id, selected.key, parent || null);
    },
    retry: false,
  });

  return (
    <RunOutputPicker
      shot={shot}
      rows={options}
      selection={choice}
      onSelect={(id) => { setChoice(id); mutation.reset(); }}
      disabled={mutation.isPending}
      label={t("已發布的影片")}
      takenLabel={t("已在候選")}
      emptyText={t("這一批執行紀錄沒有完整影片。")}
      loading={runs.isPending}
      error={runs.error ? errorText(runs.error) : null}
      hasMore={runs.hasNextPage}
      loadingMore={runs.isFetchingNextPage}
      onLoadMore={() => void runs.fetchNextPage()}
    >
      {parents.length > 0 ? (
        <label className="block text-data text-fg">
          {t("剪輯上的父 Take（選用）")}
          <Select
            compact
            className="mt-1"
            value={parent}
            disabled={mutation.isPending}
            onChange={(event) => { setParent(event.target.value); mutation.reset(); }}
          >
            <option value="">{t("獨立候選")}</option>
            {parents.map(({ take, n }) => (
              <option key={take.take_id} value={take.take_id}>
                {[t("Take {n}", { n }), routeName(routeDisplayLabel(engine.routes, take.route)).name, take.seed !== null ? t("seed {seed}", { seed: take.seed }) : null].filter(Boolean).join(" · ")}
              </option>
            ))}
          </Select>
        </label>
      ) : null}
      {mutation.error ? <p role="alert" className="text-caption text-danger">{errorText(mutation.error)}</p> : null}
      {already || mutation.isSuccess ? <p role="status" className="text-caption text-fg-secondary">{t("這份影片已列入鏡頭候選。")}</p> : null}
      <Button
        variant="primary"
        size="sm"
        className="self-start"
        disabled={!selected || !!already || mutation.isPending || mutation.isSuccess}
        pending={mutation.isPending}
        onClick={() => { mutation.mutate(); }}
      >
        {t("採用為候選 Take")}
      </Button>
    </RunOutputPicker>
  );
}

/** 「採用現有影片」: the dialog, opened from the shot's ⋯ menu in the Prompt tab (the caller owns `open`). */
export function AdoptMediaTake({ shot, onAdopt, open, onOpenChange }: Props & { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide onKeyDown={(event) => { event.stopPropagation(); }}>
        <DialogHeader>
          <DialogTitle>{t("採用現有影片")}</DialogTitle>
          <DialogDescription>
            {t("將已發布的影片加入「{shot}」候選，保留來源素材與目前選片。", { shot: shot.title })}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>{open ? <MediaPicker key={shot.shot_id} shot={shot} onAdopt={onAdopt} /> : null}</DialogBody>
      </DialogContent>
    </Dialog>
  );
}
