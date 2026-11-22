// 角色與場景 → 套用到鏡頭: which character and scene entries (and which of their versions, in which order, with per-shot
// overrides) a shot uses. The generation model is not chosen here (a new binding is portable; an existing one keeps
// its model), and the driving media of 表演影片／音訊驅動 live in the shot's References tab, so this tab only holds the
// creative settings. Saving writes a new binding version.
import { studioWrite } from "@/api/studioWrite";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import type {
  StudioCreativeBindingRead,
  StudioCreativeBindingWrite,
  StudioCreativeEntrySummary,
  StudioProject,
} from "@/api/generated/contracts";
import { Button } from "@/components/ui/button";
import { Checkbox, Input } from "@/components/ui/controls";
import { t } from "@/i18n";
import { FieldRows, Status } from "./fields";
import { fieldsOf, rowsOf, type FieldRow } from "./fieldValues";

interface Pin { id: string; revision: number; overrides: FieldRow[] }
export function Bindings({
  project,
  medium,
  path,
  entries,
  binding,
  saved,
}: {
  project: StudioProject;
  medium: "video" | "image";
  path: string;
  entries: StudioCreativeEntrySummary[];
  binding: StudioCreativeBindingRead | null;
  saved: () => Promise<void>;
}) {
  const model: StudioCreativeBindingWrite["model"] = binding?.version.model ?? (medium === "image" ? "portable.image" : "portable.video");
  const [pins, setPins] = useState<Pin[]>(
    () => binding?.version.entries.map((p) => ({ id: p.entry_id, revision: p.revision, overrides: rowsOf(p.overrides) })) ?? [],
  );
  const [state, setState] = useState(() => rowsOf(binding?.version.state));
  const commit = useMutation({
    mutationFn: () => {
      const body: StudioCreativeBindingWrite = {
        expected_revision: binding?.latest_revision ?? 0,
        project_revision: project.revision,
        model,
        entries: pins.map((p) => ({ entry_id: p.id, revision: p.revision, overrides: fieldsOf(p.overrides) })),
        state: fieldsOf(state),
      };
      return studioWrite("StudioCreativeBindingVersion", project.project_id, path, { method: "PUT", json: body });
    },
    onSuccess: saved,
    retry: false,
  });
  function change(id: string, update: Partial<Pin>) {
    setPins((prev) => prev.map((p) => (p.id === id ? { ...p, ...update } : p)));
  }
  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="mb-1 text-caption font-medium text-fg-secondary">{t("套用設定與順序")}</legend>
        {entries.length === 0 ? <p className="text-caption text-fg-secondary">{t("設定庫尚無角色或場景。")}</p> : null}
        {entries.map((entry) => {
          const index = pins.findIndex((p) => p.id === entry.entry_id);
          const pin = pins[index];
          return (
            <div key={entry.entry_id} className="border-b border-line py-1">
              <div className="flex flex-wrap items-center gap-2">
                <Checkbox
                  label={entry.name}
                  checked={!!pin}
                  onChange={(e) => { setPins(
                      e.target.checked
                        ? [...pins, { id: entry.entry_id, revision: entry.revision, overrides: [] }]
                        : pins.filter((p) => p.id !== entry.entry_id),
                    ); }
                  }
                />
                {pin ? (
                  <>
                    <span className="text-caption text-fg-tertiary">
                      {t("順序")} {index + 1}
                    </span>
                    <label className="flex items-center gap-1 text-caption">
                      {t("設定版本")}
                      <Input
                        compact
                        className="w-18"
                        type="number"
                        min={1}
                        max={entry.revision}
                        value={pin.revision}
                        onChange={(e) => { change(pin.id, { revision: e.target.valueAsNumber || 1 }); }}
                      />
                    </label>
                    <Button
                      size="sm"
                      variant="quiet"
                      disabled={index === 0}
                      onClick={() => {
                        const reordered = pins.slice();
                        reordered.splice(index, 1);
                        reordered.splice(index - 1, 0, pin);
                        setPins(reordered);
                      }}
                    >
                      {t("上移")}
                    </Button>
                  </>
                ) : null}
              </div>
              {pin ? (
                <details className="mb-2 text-caption text-fg-secondary">
                  <summary className="cursor-pointer">{t("鏡頭局部覆寫")}</summary>
                  <FieldRows label={t("覆寫欄位")} rows={pin.overrides} onChange={(overrides) => { change(pin.id, { overrides }); }} />
                </details>
              ) : null}
            </div>
          );
        })}
      </fieldset>
      <FieldRows label={t("鏡頭狀態")} rows={state} onChange={setState} />
      <Button disabled={commit.isPending} onClick={() => { commit.mutate(); }}>
        {t("儲存設定")}
      </Button>
      <Status error={commit.error} message={commit.isSuccess ? t("已儲存") : undefined} />
    </div>
  );
}
