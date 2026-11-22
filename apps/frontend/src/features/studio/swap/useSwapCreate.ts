// 建立換角專案：上傳角色圖（原圖＋白底副本）→ 建立新專案（PUT revision 0）→ 送出批次渲染（既有的 Studio 渲染規劃，
// 一個 run、同一張卡依序執行）→ 把 take 寫回專案 → 開啟新專案。每個寫入只送一次；失敗時停在那一步，畫面說明原因，
// 由使用者按「再試一次」從失敗的步驟繼續（已上傳的檔案、已建立的專案不會重做）。連線中斷的寫入當成遠端結果未知，
// 不提供直接重送。
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { Catalog, FileRef, StudioProject } from "@/api/generated/contracts";
import { uploadBlob, uploadFile } from "@/api/files";
import { isApiError } from "@/api/http";
import { useCreateRun } from "@/api/runs";
import { fetchProject, saveProject, studioKeys } from "@/api/studioProjects";
import type { WireRun } from "@/api/types";
import { writeOutcomeUnknown } from "@/lib/errors";
import { localId } from "../model/project";
import { planRender, renderTakeDrafts } from "../model/renderPlan";
import type { StudioRoute } from "../model/routes";
import type { DraftCharacter } from "./draft";
import { clearDraft } from "./draftStore";
import { errorText } from "./errors";
import { buildSwapProject, swapProjectUrl, type BuildSwapInput, type SwapCharacterInput } from "./job";
import { matteName } from "./whiteMatte";
import { t } from "@/i18n";

export type CreateStepId = "images" | "project" | "render" | "record";
export type CreateStepState = "pending" | "running" | "done" | "failed" | "skipped";

export const CREATE_STEPS: readonly { id: CreateStepId; label: string }[] = [
  { id: "images", label: t("上傳角色圖（原圖與白底副本）") },
  { id: "project", label: t("建立新專案") },
  { id: "render", label: t("開始批次渲染") },
  { id: "record", label: t("把渲染寫進專案") },
];

export interface CreateState {
  phase: "idle" | "running" | "failed" | "done";
  steps: Record<CreateStepId, { state: CreateStepState; detail: string | null }>;
  /** 主控上的新專案（建立之後）。 */
  project: StudioProject | null;
  runId: string | null;
  error: string | null;
  /** 失敗的寫入遠端結果未知：不提供重送，請先確認。 */
  unknown: boolean;
}

export interface CreateRequest {
  build: Omit<BuildSwapInput, "characters">;
  characters: readonly DraftCharacter[];
  startRender: boolean;
  /** Segments the first render sends (the batch size within one run's limit); the swap panel sends the rest. */
  firstBatch: number;
  routes: readonly StudioRoute[];
  catalog: Catalog | undefined;
}

const IDLE: CreateState = {
  phase: "idle",
  steps: { images: { state: "pending", detail: null }, project: { state: "pending", detail: null }, render: { state: "pending", detail: null }, record: { state: "pending", detail: null } },
  project: null,
  runId: null,
  error: null,
  unknown: false,
};

class StepFailure extends Error {
  readonly step: CreateStepId;
  readonly unknown: boolean;

  constructor(step: CreateStepId, message: string, unknown = false) {
    super(message);
    this.step = step;
    this.unknown = unknown;
  }
}

export function useSwapCreate() {
  const client = useQueryClient();
  const { mutateAsync: postRun } = useCreateRun();
  const navigate = useNavigate();
  const [state, setState] = useState<CreateState>(IDLE);
  const runningRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  /** 這次建立的進度（再試一次時沿用）：上傳過的檔案、草稿文件、已保存的專案、已建立的 run 與帶 take 的文件。 */
  const memoRef = useRef<{ uploads: Map<string, FileRef>; doc: StudioProject | null; saved: StudioProject | null; runId: string | null }>({
    uploads: new Map(),
    doc: null,
    saved: null,
    runId: null,
  });

  /** 還掛載著（切換專案或離開 Studio 後，進行中的寫入照樣完成，但不再把使用者帶到新專案）。 */
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const setStep = (id: CreateStepId, step: CreateState["steps"][CreateStepId]) => { setState((current) => ({ ...current, steps: { ...current.steps, [id]: step } })); };

  const publish = (project: StudioProject) => {
    client.setQueryData(studioKeys.project(project.project_id), project);
    void client.invalidateQueries({ queryKey: studioKeys.projects() });
  };

  const uploadImages = async (characters: readonly DraftCharacter[], signal: AbortSignal): Promise<SwapCharacterInput[]> => {
    const out: SwapCharacterInput[] = [];
    let count = 0;
    for (const character of characters) {
      const image = character.image;
      if (!image) throw new StepFailure("images", t("有角色還沒有圖片"));
      const cached = (suffix: string) => memoRef.current.uploads.get(`${image.key}:${suffix}`);
      let original = cached("original");
      if (!original) {
        original = image.origin.kind === "library" ? image.origin.file : await uploadFile(image.origin.file, signal);
        memoRef.current.uploads.set(`${image.key}:original`, original);
        if (image.origin.kind === "local") count += 1;
      }
      let matte: FileRef | undefined;
      if (image.matte) {
        matte = cached("matte");
        if (!matte) {
          matte = await uploadBlob(image.matte, "image/png", signal);
          memoRef.current.uploads.set(`${image.key}:matte`, matte);
          count += 1;
        }
      }
      out.push({
        id: character.id,
        who: character.who,
        appearance: character.appearance,
        mustNot: character.mustNot,
        original: { name: image.name, file: original, width: image.width, height: image.height },
        matte: matte ? { name: matteName(image.name), file: matte, width: image.width, height: image.height } : null,
      });
    }
    setStep("images", { state: "done", detail: count > 0 ? t("上傳 {count} 個檔案；原圖不修改", { count }) : t("沿用素材庫的檔案") });
    return out;
  };

  const createProject = async (doc: StudioProject): Promise<StudioProject> => {
    try {
      return await saveProject(doc);
    } catch (error) {
      // 上一次的保存其實成功了（回應遺失）：主控已有這個專案 → 讀回來用，不重建
      if (isApiError(error) && error.code === "REVISION_CONFLICT") {
        const existing = await fetchProject(doc.project_id);
        if (existing.title === doc.title && existing.shots.length === doc.shots.length) return existing;
      }
      throw new StepFailure("project", t("建立專案失敗：{error}", { error: errorText(error) }), writeOutcomeUnknown(error));
    }
  };

  const execute = async (request: CreateRequest) => {
    if (runningRef.current) return;
    runningRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    setState((current) => ({ ...current, phase: "running", error: null, unknown: false }));
    try {
      // 1. 角色圖
      if (!memoRef.current.doc) {
        setStep("images", { state: "running", detail: null });
        const characters = await uploadImages(request.characters, controller.signal);
        memoRef.current.doc = buildSwapProject({ ...request.build, characters });
      }
      const doc = memoRef.current.doc;
      // 2. 專案
      if (!memoRef.current.saved) {
        setStep("project", { state: "running", detail: null });
        const saved = await createProject(doc);
        memoRef.current.saved = saved;
        publish(saved);
        setStep("project", { state: "done", detail: t("「{title}」・{shotsCount} 段", { title: saved.title, shotsCount: saved.shots.length }) });
        setState((current) => ({ ...current, project: saved }));
      }
      const saved = memoRef.current.saved;
      // 3. 批次渲染
      if (!request.startRender) {
        setStep("render", { state: "skipped", detail: t("沒有勾選「建立後立即開始渲染」：之後在專案的「一鍵換角」開始") });
        setStep("record", { state: "skipped", detail: null });
      } else if (!(memoRef.current.runId != null && memoRef.current.runId !== "")) {
        setStep("render", { state: "running", detail: null });
        const shots = saved.shots.slice(0, Math.max(1, request.firstBatch));
        const takeIds = shots.map(() => localId("t"));
        const label =
          shots.length < saved.shots.length
            ? t("一鍵換角：{title}・第一批 {batchCount}／{shotsCount} 段", { title: saved.title, batchCount: shots.length, shotsCount: saved.shots.length })
            : t("一鍵換角：{title}・{shotsCount} 段", { title: saved.title, shotsCount: saved.shots.length });
        const { plan, problem } = planRender(saved, shots, takeIds, { routes: request.routes, catalog: request.catalog }, { label });
        if (!plan) throw new StepFailure("render", t("專案已建立，但不能開始渲染：{problem}", { problem }));
        let run: WireRun;
        try {
          run = await postRun({ studioProjectId: saved.project_id, submission: {
            expected_revision: saved.revision, medium: "video", run: plan.body, takes: renderTakeDrafts(saved, shots, plan, takeIds),
          } });
        } catch (error) {
          const active = isApiError(error) && error.code === "RUN_ACTIVE";
          throw new StepFailure("render", active ? t("專案已建立；主控目前有其他 run 在執行，渲染還沒開始。等它結束後，在專案的「一鍵換角」按「渲染剩下的段落」") : t("專案已建立，但無法開始渲染：{error}", { error: errorText(error) }), writeOutcomeUnknown(error));
        }
        memoRef.current.runId = run.run_id;
        setStep("render", { state: "done", detail: t("run {run_id}・{shotsCount} 段依序執行", { run_id: run.run_id.slice(0, 8), shotsCount: shots.length }) });
        setState((current) => ({ ...current, runId: run.run_id }));
      }
      // 4. 寫回 take
      if (request.startRender && memoRef.current.runId !== null) {
        setStep("record", { state: "running", detail: null });
        const recorded = await fetchProject(saved.project_id).catch((error: unknown) => { throw new StepFailure("record", errorText(error)); });
        memoRef.current.saved = recorded;
        publish(recorded);
        setStep("record", { state: "done", detail: null });
      }
      setState((current) => ({ ...current, phase: "done" }));
      // The draft became this project: the next wizard starts empty (the toolbar remounts on the new project)
      clearDraft();
      if (mountedRef.current) void navigate(swapProjectUrl(saved.project_id));
    } catch (error) {
      if (controller.signal.aborted) return;
      const failure = error instanceof StepFailure ? error : new StepFailure("images", t("上傳角色圖失敗：{error}", { error: errorText(error) }), writeOutcomeUnknown(error));
      setStep(failure.step, { state: "failed", detail: failure.message });
      setState((current) => ({ ...current, phase: "failed", error: failure.message, unknown: failure.unknown }));
    } finally {
      runningRef.current = false;
    }
  };

  /** 新的建立（換了草稿內容時）：清掉上一次的進度。已上傳的檔案留在主控（沒有被任何專案引用）。 */
  const start = (request: CreateRequest) => {
    if (runningRef.current) return;
    memoRef.current = { uploads: memoRef.current.uploads, doc: null, saved: null, runId: null };
    setState({ ...IDLE, phase: "running" });
    void execute(request);
  };

  /** 從失敗的步驟繼續（使用者按下才送）。 */
  const retry = (request: CreateRequest) => void execute(request);

  /** 專案已建立但渲染沒開始（或沒寫進專案）時，直接開啟專案。 */
  const openProject = () => {
    const saved = memoRef.current.saved;
    if (saved) void navigate(swapProjectUrl(saved.project_id));
  };

  const reset = () => {
    if (runningRef.current) return;
    memoRef.current = { uploads: memoRef.current.uploads, doc: null, saved: null, runId: null };
    setState(IDLE);
  };

  return { state, start, retry, openProject, reset };
}
