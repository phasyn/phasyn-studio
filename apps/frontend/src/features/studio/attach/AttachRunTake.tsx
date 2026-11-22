import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { StudioShot } from "@/api/generated/contracts";
import { useRunList } from "@/api/runs";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { t } from "@/i18n";
import { toErrorInfo, errorText } from "@/lib/errors";
import { useStudio } from "../studioContext";
import { finishedGenerationOutputs } from "./api";
import { RunOutputPicker, type PickerRow } from "./RunOutputPicker";

/** 「附加歷史輸出」: the dialog, opened from the shot's ⋯ menu in the Prompt tab (the caller owns `open`). */
export function AttachRunTake({ shot, open, onOpenChange }: { shot: StudioShot; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide onKeyDown={(event) => { event.stopPropagation(); }}>
        <DialogHeader>
          <DialogTitle>{t("附加歷史輸出")}</DialogTitle>
          <DialogDescription>{shot.title}</DialogDescription>
        </DialogHeader>
        <DialogBody>{open ? <Picker shot={shot} /> : null}</DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function conflictText(reason: string) {
  switch (reason) {
    case "shot_prompt_reference_or_generation_settings_do_not_match":
      return t("鏡頭的提示詞、參考素材或生成設定與這份輸出不同。");
    case "ambiguous_unscoped_generation":
      return t("有多個鏡頭符合這份歷史輸出，無法確認歸屬。");
    case "output_already_bound_elsewhere":
    case "output_already_bound_elsewhere_or_inconsistent":
      return t("這份輸出已綁定其他鏡頭，或與既有 Take 紀錄不同。");
    default:
      return reason;
  }
}

function Picker({ shot }: { shot: StudioShot }) {
  const runs = useRunList(25, "include", undefined, "summary");
  const { attachRunTake } = useStudio();
  const rows = useMemo<PickerRow[]>(
    () => runs.data?.pages.flatMap((page) => page.items.flatMap(finishedGenerationOutputs)).map((row) => ({ ...row, id: row.run.run_id + "/" + row.key })) ?? [],
    [runs.data],
  );
  const [selection, setSelection] = useState("");
  const selected = rows.find((item) => item.id === selection);
  const existing = selected ? shot.takes.find((take) => take.run_id === selected.run.run_id && take.output_key === selected.key) : undefined;
  const mutation = useMutation({
    mutationFn: async () => {
      if (selected) await attachRunTake(shot.shot_id, selected.run.run_id, selected.key);
    },
    retry: false,
  });
  const reason = mutation.error ? toErrorInfo(mutation.error).details["reason"] : null;
  return (
    <RunOutputPicker
      shot={shot}
      rows={rows}
      selection={selection}
      onSelect={(id) => {
        setSelection(id);
        mutation.reset();
      }}
      disabled={mutation.isPending}
      label={t("已完成的生成影片")}
      takenLabel={t("已附加")}
      emptyText={t("這一批紀錄沒有可附加的生成影片。")}
      loading={runs.isPending}
      error={runs.error ? errorText(runs.error) : null}
      hasMore={runs.hasNextPage}
      loadingMore={runs.isFetchingNextPage}
      onLoadMore={() => void runs.fetchNextPage()}
    >
      <p className="text-caption text-fg-secondary">{t("附加後保留目前選用的 Take。")}</p>
      {mutation.error ? (
        <div role="alert" className="space-y-1 rounded-md border border-danger/40 p-3 text-caption text-danger">
          <p>{errorText(mutation.error)}</p>
          {typeof reason === "string" ? <p className="break-words">{conflictText(reason)}</p> : null}
        </div>
      ) : null}
      {existing ? (
        <p role="status" className="text-caption text-fg-secondary">
          {t("已附加至這個鏡頭")}
        </p>
      ) : null}
      <Button
        variant="primary"
        size="sm"
        className="self-start"
        disabled={!selected || !!existing || mutation.isPending}
        pending={mutation.isPending}
        onClick={() => { mutation.mutate(); }}
      >
        {t("附加至鏡頭")}
      </Button>
    </RunOutputPicker>
  );
}
