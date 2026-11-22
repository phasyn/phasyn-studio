// The scene tab's screen state (selected version, editor draft, candidate variant, revision instruction) and its
// controller. A draft belongs to one version: switching versions with unsaved changes asks first (switchTo).
import { useMemo, useState } from "react";
import type { SceneController } from "../components/SceneTab";
import { draftChanged, draftDirty, draftFromVersion, sceneIssues, type EditorDraft } from "../model/scene";
import { addVersion, findVersion, latestVersion, localId, newTask } from "../model/study";
import type { PromptStudyVersion, PromptVariant, TaskComponents } from "../types";
import type { StudyDocument } from "./useStudyDocument";
import type { TaskRunner } from "./useTaskRunner";

export function useSceneController({
  doc,
  runner,
  components,
  persistSettings,
}: {
  doc: StudyDocument;
  runner: TaskRunner;
  components: TaskComponents;
  persistSettings: () => Record<string, unknown>;
}) {
  const study = doc.study;
  const busy = runner.state.busy;
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const latest = latestVersion(study);
  const version = findVersion(study, selectedVersionId) ?? latest;
  const [draftState, setDraftState] = useState<EditorDraft | null>(null);
  const baseDraft = useMemo(() => (version ? draftFromVersion(version) : null), [version]);
  const ownDraft = draftState && draftState.versionId === version?.version_id ? draftState : null;
  const editorDraft = ownDraft ?? baseDraft;
  const dirty = draftDirty(ownDraft);
  const [variant, setVariant] = useState<PromptVariant>("core");
  const [instruction, setInstruction] = useState("");
  /** The version to switch to once the user confirms dropping the unsaved draft. */
  const [switchTo, setSwitchTo] = useState<string | null>(null);

  const selectVersion = (versionId: string) => {
    if (version?.version_id === versionId) return;
    if (dirty) setSwitchTo(versionId);
    else {
      setDraftState(null);
      setSelectedVersionId(versionId);
    }
  };

  const confirmSwitch = () => {
    setDraftState(null);
    setSelectedVersionId(switchTo);
    setSwitchTo(null);
  };

  const scene: SceneController = {
    version,
    latest,
    draft: editorDraft,
    setDraft: (next) => {
      // 開始編修時固定在這個版本（新版本出現時不會把草稿藏起來）
      if (selectedVersionId === null) setSelectedVersionId(next.versionId);
      setDraftState(next);
    },
    dirty,
    changed: draftChanged(ownDraft),
    issues: editorDraft ? sceneIssues(editorDraft.scene, editorDraft.intentional, editorDraft.note) : [],
    selectVersion,
    revert: () => { setDraftState(null); },
    variant,
    setVariant,
    instruction,
    setInstruction,
    save: () => {
      const snapshot = ownDraft;
      if (!snapshot || busy) return;
      void (async () => {
        const result = await runner.compile({ scene: snapshot.scene, intentional: snapshot.intentional, componentKey: components.compile });
        if (!result) return;
        // 版本存的 scene 必須正是編譯的那一份（主控核對 candidates.scene_sha256）
        const created: Omit<PromptStudyVersion, "number"> = {
          version_id: localId("v"),
          parent_version_id: snapshot.versionId,
          origin: "manual",
          scene: snapshot.scene,
          intentional_changes: snapshot.intentional,
          candidates: result.candidates,
          provenance: {
            kind: "manual",
            task_id: null,
            run_ids: [result.runId],
            vision: null,
            compile: { compiler_version: result.candidates.compiler_version, compiler_sha256: result.candidates.compiler_sha256, scene_sha256: result.candidates.scene_sha256, component: components.compile },
          },
          note: snapshot.note.trim(),
          created_at: new Date().toISOString(),
        };
        try {
          await doc.update((current) => addVersion(current, created));
          setDraftState(null);
          setSelectedVersionId(created.version_id);
        } catch {
          // 保存失敗或衝突顯示在頁首；草稿保留
        }
      })();
    },
    refine: () => {
      if (!version || busy) return;
      const task = newTask({ request: { kind: "refine", instruction: instruction.trim() }, baseVersionId: version.version_id, now: new Date().toISOString() });
      setSelectedVersionId(null);
      void runner.start(task, { mode: "loop", rounds: "all" }, persistSettings());
    },
  };

  return { scene, dirty, selectVersion, setVariant, switchTo, cancelSwitch: () => { setSwitchTo(null); }, confirmSwitch };
}
