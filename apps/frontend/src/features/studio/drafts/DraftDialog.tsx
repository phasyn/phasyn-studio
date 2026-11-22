import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StudioDraftPlan } from "@/api/generated/contracts";
import { contractJson } from "@/api/http";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { useStudio } from "../studioContext";
import { Failure } from "./fields";
import { NewPlan } from "./NewPlan";
import { planStatus } from "./status";
import { PlanDetail, type Operation } from "./PlanDetail";

export function DraftDialog({ open, setOpen }: { open: boolean; setOpen: (b: boolean) => void }) {
  const { project } = useStudio();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent wide onKeyDown={(e) => { e.stopPropagation(); }}>
        <DialogHeader>
          <DialogTitle>{t("批次草稿")}</DialogTitle>
          <DialogDescription>{project.title}</DialogDescription>
        </DialogHeader>
        <DialogBody>{open && <Workspace key={project.project_id} />}</DialogBody>
      </DialogContent>
    </Dialog>
  );
}
function Workspace() {
  const { project, flush } = useStudio();
  const client = useQueryClient();
  const [id, setId] = useState("");
  const root = "/api/studio/projects/" + encodeURIComponent(project.project_id) + "/draft-plans";
  const path = root + "/" + encodeURIComponent(id);
  const list = useInfiniteQuery({
    queryKey: ["draft-plans", root],
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) =>
      contractJson("StudioDraftPlanList", root + (pageParam ? "?after=" + encodeURIComponent(pageParam) : ""), { signal }),
    getNextPageParam: (p) => p.next_cursor ?? undefined,
    retry: false,
  });
  const plans = list.data?.pages.flatMap((p) => p.items) ?? [];
  const detail = useQuery({
    queryKey: ["draft-plan", path],
    queryFn: ({ signal }) => contractJson("StudioDraftPlan", path, { signal }),
    enabled: !!id,
    refetchInterval: (q) => (["running", "stopping"].includes(q.state.data?.status ?? "") ? 900 : false),
    retry: false,
  });
  function receive(doc: StudioDraftPlan) {
    client.setQueryData(["draft-plan", root + "/" + encodeURIComponent(doc.plan_id)], doc);
    setId(doc.plan_id);
    void client.invalidateQueries({ queryKey: ["draft-plans", root] });
  }
  const action = useMutation({
    mutationFn: ({ op, doc, cid }: { op: Operation; doc: StudioDraftPlan; cid?: string | undefined }) =>
      contractJson("StudioDraftPlan", root + "/" + encodeURIComponent(doc.plan_id) + "/" + op, {
        method: "POST",
        json: { digest: doc.digest, ...((cid != null && cid !== "") ? { candidate_id: cid } : {}) },
      }),
    onSuccess: receive,
    retry: false,
  });
  return (
    <div className="grid min-w-0 gap-4">
      <div className="flex flex-wrap items-end gap-2 border-b border-line-subtle pb-3">
        <label className="grid min-w-0 flex-1 gap-1 text-caption text-fg-secondary">
          {t("已儲存的草稿計畫")}
          <Select
            compact
            value={id}
            disabled={action.isPending}
            onChange={(e) => {
              action.reset();
              setId(e.target.value);
            }}
          >
            <option value="">{t("建立新計畫")}</option>
            {id && !plans.some((p) => p.plan_id === id) && <option value={id}>{id}</option>}
            {plans.map((p) => (
              <option key={p.plan_id} value={p.plan_id}>
                {p.plan_id} · {planStatus(p.plan_id === id && detail.data ? detail.data.status : p.status)}
              </option>
            ))}
          </Select>
        </label>
        {list.hasNextPage && (
          <Button size="sm" variant="secondary" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            {t("載入更多計畫")}
          </Button>
        )}
      </div>
      <Failure error={list.error ?? detail.error ?? action.error} />
      {id ? (
        detail.data ? (
          <PlanDetail
            doc={detail.data}
            project={project}
            busy={action.isPending}
            act={(op, cid) => {
              action.mutate({ op, doc: detail.data, cid });
            }}
          />
        ) : (
          !detail.isError && <p role="status">{t("讀取中…")}</p>
        )
      ) : (
        <NewPlan root={root} project={project} flush={flush} onSave={receive} />
      )}
    </div>
  );
}
