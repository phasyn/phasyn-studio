// 語意頁各步驟的狀態：選擇的元件、參數、建立 run 的 mutation、上傳中／錯誤、Scene 草稿。
// 放在頁面層級（以前四個區塊同時掛載，狀態本來就跟著頁面），切換步驟分頁時不會遺失。
// 寫入一律不自動重送：失敗只顯示錯誤（連線中斷＝遠端結果未知），由使用者決定是否再按一次。
import { useState } from "react";
import { uploadJson, useFileJson } from "@/api/files";
import type { FileRef, SceneDocument } from "@/api/generated/contracts";
import { useCreateRun } from "@/api/runs";
import { asSceneDocument, type WireRun, type WireTypedValue } from "@/api/types";
import { isRecord, valuesEqual } from "@/lib/json";
import { validateValue } from "@/lib/schema";
import { useKindComponent } from "@/features/pipelines";
import { datasetRowsDocument, findRunInputFile, findRunValue, sceneIssues, singleStepPipeline, suggestedParameters, type DatasetRow } from "./sceneModel";
import { captionBlockReason, captionSceneInput, datasetBlockReason, describeBlockReason, sceneSaveBlock } from "./stepModel";
import { t } from "@/i18n";

const DESCRIBE_SUGGESTIONS = { sampling_fps: 4, fast_motion_fps: 12, preserve_endpoints: true };
const CAPTION_SUGGESTIONS = { include_uncertain: false, language: "en" };

interface ParamDraft {
  /** 參數草稿屬於哪個元件（node_id::component_id）；換元件時改回該元件的建議值。 */
  key: string;
  value: Record<string, unknown>;
}

function schemaIssues(schema: unknown, value: Record<string, unknown>, enabled: boolean) {
  return enabled ? validateValue(schema, value, isRecord(schema) ? schema : undefined) : [];
}

/** 1. 反推：來源影片（使用者選擇優先，否則沿用反推 run 的輸入）、video.describe 元件與抽樣參數。 */
export function useDescribeStep(describeRun: WireRun | undefined, onCreated: (runId: string) => void) {
  const [sourceChoice, setSourceChoice] = useState<WireTypedValue | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [params, setParams] = useState<ParamDraft | null>(null);
  const create = useCreateRun();
  const runSource = findRunInputFile(describeRun, "media.video.v1");
  const source = sourceChoice ?? runSource;
  const descriptor = useKindComponent("video.describe", choice);
  const key = descriptor ? `${descriptor.node_id}::${descriptor.component_id}` : "";
  const parameters = params?.key === key ? params.value : suggestedParameters(descriptor, DESCRIBE_SUGGESTIONS);
  const schema = descriptor?.settings.parameters_schema ?? {};
  const issues = schemaIssues(schema, parameters, descriptor !== null);
  const blockReason = describeBlockReason({ source, hasDescriptor: descriptor !== null, issueCount: issues.length });

  const submit = () => {
    if ((blockReason ?? "") || !descriptor || !source || !("file" in source) || create.isPending) return;
    const pipeline = singleStepPipeline("semantics-describe", t("反推語意（video.describe）"), "describe", descriptor, "video", "media.video.v1", parameters);
    if (!pipeline) return;
    create.mutate(
      { pipeline, inputs: { video: { type_id: "media.video.v1", file: source.file } }, label: t("反推語意") },
      { onSuccess: (run) => { onCreated(run.run_id); } },
    );
  };

  return {
    source,
    /** 目前用的是反推 run 的來源影片（使用者沒有另選）。 */
    usingRunSource: runSource !== null && sourceChoice === null,
    setSource: setSourceChoice,
    choice,
    setChoice,
    descriptor,
    parameters,
    setParameters: (value: Record<string, unknown>) => { setParams({ key, value }); },
    schema,
    issues,
    blockReason,
    create,
    submit,
  };
}

interface SceneEdit {
  originKey: string;
  draft: SceneDocument;
  saved: { ref: FileRef; scene: SceneDocument } | null;
}

/** 2. Scene：讀反推輸出（FileRef 讀 JSON 或 inline），編修草稿；另存會上傳成新檔，原 Scene 不變。 */
export function useSceneStep(describeRun: WireRun | undefined, describeRunId: string | null) {
  const [sceneEdit, setSceneEdit] = useState<SceneEdit | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  const sceneValue = findRunValue(describeRun, "video.scene.v1");
  const sceneFile = sceneValue && "file" in sceneValue ? sceneValue.file : null;
  const sceneJson = useFileJson(sceneFile);
  const originalScene = sceneValue ? asSceneDocument("file" in sceneValue ? sceneJson.data : sceneValue.value) : null;
  const originKey = sceneValue ? ("file" in sceneValue ? `file:${sceneValue.file.node_id}/${sceneValue.file.file_id}` : `inline:${describeRunId ?? ""}`) : null;
  const edit = sceneEdit?.originKey === originKey ? sceneEdit : null;
  const draft = edit?.draft ?? originalScene;
  const issues = draft ? sceneIssues(draft) : [];
  const changed = edit !== null && originalScene !== null && !valuesEqual(edit.draft, originalScene);
  const savedCurrent = edit?.saved && valuesEqual(edit.saved.scene, edit.draft) ? edit.saved : null;
  const captionInput = captionSceneInput({ sceneValue, hasOriginal: originalScene !== null, changed, saved: savedCurrent?.ref ?? null });

  const save = async () => {
    if (!draft || !(originKey != null && originKey !== "") || issues.length > 0 || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const ref = await uploadJson(draft);
      setSceneEdit({ originKey, draft, saved: { ref, scene: draft } });
    } catch (cause) {
      setSaveError(cause);
    } finally {
      setSaving(false);
    }
  };

  return {
    sceneValue,
    sceneFile,
    sceneJson,
    originalScene,
    originKey,
    draft,
    issues,
    changed,
    savedCurrent,
    /** 有修改但尚未另存（離開頁面前要確認）。 */
    unsavedEdits: changed && savedCurrent === null,
    captionScene: captionInput.scene,
    captionSceneBlock: captionInput.block,
    saveBlock: sceneSaveBlock({ hasDraft: draft !== null, issueCount: issues.length, changed, savedCurrent: savedCurrent !== null }),
    saving,
    saveError,
    setDraft: (next: SceneDocument) => {
      if (originKey != null && originKey !== "") setSceneEdit({ originKey, draft: next, saved: edit?.saved ?? null });
    },
    /** 還原為原 Scene（也用於建立新的反推 run 之後）。 */
    revert: () => { setSceneEdit(null); },
    save,
  };
}

/** 3. caption.compile：輸入 Scene（FileRef 或 inline，依輸入埠 transport 轉換），參數 language／include_uncertain（預設 false）。 */
export function useCaptionStep(scene: WireTypedValue | null, sceneBlockReason: string | null, onCreated: (runId: string) => void) {
  const [choice, setChoice] = useState<string | null>(null);
  const [params, setParams] = useState<ParamDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState<unknown>(null);
  const create = useCreateRun();
  const descriptor = useKindComponent("caption.compile", choice);
  const key = descriptor ? `${descriptor.node_id}::${descriptor.component_id}` : "";
  const parameters = params?.key === key ? params.value : suggestedParameters(descriptor, CAPTION_SUGGESTIONS);
  const port = descriptor?.inputs.find((item) => item.type_id === "video.scene.v1") ?? null;
  const schema = descriptor?.settings.parameters_schema ?? {};
  const issues = schemaIssues(schema, parameters, descriptor !== null);
  const blockReason = captionBlockReason({ sceneBlock: sceneBlockReason, hasScene: scene !== null, hasDescriptor: descriptor !== null, hasScenePort: port !== null, issueCount: issues.length });

  const submit = async () => {
    if ((blockReason ?? "") || !scene || !descriptor || !port || busy || create.isPending) return;
    setBusy(true);
    setUploadError(null);
    try {
      const pipeline = singleStepPipeline("caption-compile", t("組裝 caption（caption.compile）"), "caption", descriptor, "scene", "video.scene.v1", parameters);
      if (!pipeline) return;
      let input: WireTypedValue = scene;
      if (port.transport === "file" && "value" in scene) input = { type_id: "video.scene.v1", file: await uploadJson(scene.value) };
      if (port.transport === "inline" && "file" in scene) {
        setUploadError(new Error(t("此元件只接受 inline Scene，但目前的 Scene 是檔案；請改用接受檔案的 caption.compile 元件。")));
        return;
      }
      create.mutate({ pipeline, inputs: { scene: input }, label: t("組裝 caption") }, { onSuccess: (run) => { onCreated(run.run_id); } });
    } catch (cause) {
      setUploadError(cause);
    } finally {
      setBusy(false);
    }
  };

  return {
    choice,
    setChoice,
    descriptor,
    parameters,
    setParameters: (value: Record<string, unknown>) => { setParams({ key, value }); },
    schema,
    issues,
    blockReason,
    pending: busy || create.isPending,
    uploadError,
    create,
    submit,
  };
}

/** 4. dataset.export：資料列文件依輸入埠 transport 上傳成檔或 inline；空 caption 是資料錯誤會阻擋。 */
export function useDatasetStep(rows: readonly DatasetRow[], onCreated: (runId: string) => void) {
  const [choice, setChoice] = useState<string | null>(null);
  const [params, setParams] = useState<ParamDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState<unknown>(null);
  const create = useCreateRun();
  const descriptor = useKindComponent("dataset.export", choice);
  const key = descriptor ? `${descriptor.node_id}::${descriptor.component_id}` : "";
  const parameters = params?.key === key ? params.value : {};
  const port = descriptor ? (descriptor.inputs.find((item) => item.required) ?? descriptor.inputs[0] ?? null) : null;
  const schema = descriptor?.settings.parameters_schema ?? {};
  const issues = schemaIssues(schema, parameters, descriptor !== null);
  const emptyCaptions = rows.filter((row) => !row.caption.trim()).length;
  const blockReason = datasetBlockReason({ rowCount: rows.length, emptyCaptions, hasDescriptor: descriptor !== null, hasPort: port !== null, issueCount: issues.length });

  const submit = async () => {
    if ((blockReason ?? "") || !descriptor || !port || busy || create.isPending) return;
    setBusy(true);
    setUploadError(null);
    try {
      const pipeline = singleStepPipeline("dataset-export", t("資料集匯出（dataset.export）"), "export", descriptor, "rows", port.type_id, parameters);
      if (!pipeline) return;
      const document = datasetRowsDocument(rows);
      const value: WireTypedValue = port.transport === "file" ? { type_id: port.type_id, file: await uploadJson(document) } : { type_id: port.type_id, value: document };
      create.mutate({ pipeline, inputs: { rows: value }, label: t("資料集匯出（{rowsCount} 列）", { rowsCount: rows.length }) }, { onSuccess: (run) => { onCreated(run.run_id); } });
    } catch (cause) {
      setUploadError(cause);
    } finally {
      setBusy(false);
    }
  };

  return {
    choice,
    setChoice,
    descriptor,
    parameters,
    setParameters: (value: Record<string, unknown>) => { setParams({ key, value }); },
    schema,
    issues,
    blockReason,
    pending: busy || create.isPending,
    uploadError,
    create,
    submit,
  };
}

export type DescribeStepState = ReturnType<typeof useDescribeStep>;
export type SceneStepState = ReturnType<typeof useSceneStep>;
export type CaptionStepState = ReturnType<typeof useCaptionStep>;
export type DatasetStepState = ReturnType<typeof useDatasetStep>;
