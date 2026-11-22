import { studioWrite } from "@/api/studioWrite";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MapPin, Plus, UserRound } from "lucide-react";
import { useState } from "react";
import type {
  StudioCreativeEntrySummary,
  StudioCreativeEntryVersion,
  StudioCreativeEntryWrite,
  StudioProject,
} from "@/api/generated/contracts";
import { Button } from "@/components/ui/button";
import { Input, Select, Checkbox } from "@/components/ui/controls";
import { t } from "@/i18n";
import { creativeRoot, entryRead } from "./api";
import { FieldRows, Status } from "./fields";
import { fieldsOf, rowsOf } from "./fieldValues";

interface EntryProps { project: StudioProject; entries: StudioCreativeEntrySummary[]; reviewShot: (medium: "video" | "image", id: string) => void; refresh: () => Promise<void> }
export function Entries({ project, entries, refresh, reviewShot }: EntryProps) {
  const [selected, setSelected] = useState("");
  const [revision, setRevision] = useState<number>();
  const item = entries.find((e) => e.entry_id === selected);
  const [creating, setCreating] = useState(false);
  const read = useQuery({
    queryKey: ["creative-entry", project.project_id, selected, revision ?? "head"],
    queryFn: ({ signal }) => entryRead(project.project_id, selected, revision, signal),
    enabled: !!item && !creating,
    retry: false,
  });
  function pick(id: string) {
    setSelected(id);
    setRevision(undefined);
    setCreating(false);
  }
  return (
    <div className="grid gap-5 md:grid-cols-[13rem_minmax(0,1fr)]">
      <aside className="space-y-1 border-line md:border-r md:pr-3">
        <Button
          icon={<Plus aria-hidden />}
          variant="secondary"
          size="sm"
          onClick={() => {
            setCreating(true);
            setSelected(crypto.randomUUID());
            setRevision(undefined);
          }}
        >
          {t("新增設定")}
        </Button>
        {entries.map((entry) => (
          <button
            type="button"
            key={entry.entry_id}
            aria-pressed={entry.entry_id === selected}
            className="pressable flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left text-body text-fg-secondary transition-colors hover:bg-raised aria-pressed:bg-raised aria-pressed:text-fg"
            onClick={() => { pick(entry.entry_id); }}
          >
            {entry.kind === "scene" ? (
              <MapPin aria-hidden className="size-4 shrink-0" />
            ) : (
              <UserRound aria-hidden className="size-4 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            <span className="font-mono text-caption">v{entry.revision}</span>
          </button>
        ))}
      </aside>
      <div className="min-w-0 space-y-3">
        {item && !creating ? (
          <label className="block text-caption text-fg-secondary">
            {t("讀取設定版本")}
            <Input
              compact
              type="number"
              min={1}
              max={item.revision}
              value={revision ?? item.revision}
              onChange={(e) => { setRevision(e.target.valueAsNumber || undefined); }}
            />
          </label>
        ) : null}
        {!creating && read.data?.shot_uses && (
          <section className="space-y-2 rounded-md border border-line p-3">
            <h3 className="text-data font-semibold">{t("引用此設定的鏡頭")}</h3>
            {read.data.shot_uses.length === 0 && <p className="text-caption">{t("目前沒有鏡頭套用此設定。")}</p>}
            {read.data.shot_uses.map((use) => (
              <div key={use.medium + use.shot_id} className="grid gap-1 border-t border-line-subtle pt-2 text-caption">
                <Button size="sm" variant="quiet" className="justify-self-start" onClick={() => { reviewShot(use.medium, use.shot_id); }}>
                  {t("{title} · 第 {revision} 版", { title: use.title, revision: use.entry_revision })}
                </Button>
                {use.affected_fields.length > 0 && <p>{t("受變更影響的欄位")} · {use.affected_fields.join(t("、"))}</p>}
                {use.overridden_fields.length > 0 && <p>{t("鏡頭局部覆寫")} · {use.overridden_fields.join(", ")}</p>}
                {use.name_changed && <p>{t("設定名稱有變更")}</p>}
                {use.references_changed && <p>{t("參考圖片有變更")}</p>}
                {(use.active_take_id ?? "").length > 0 && <p>{t("已選好使用中的 Take")}</p>}
              </div>
            ))}
          </section>
        )}
        {creating || (read.data && item) ? (
          <EntryForm
            key={`${selected}:${String(creating ? "new" : read.data?.version.revision)}`}
            project={project}
            id={selected}
            saved={creating ? undefined : read.data?.version}
            head={creating ? 0 : (read.data?.latest_revision ?? 0)}
            refresh={refresh}
            onSave={(id) => { pick(id); }}
          />
        ) : (
          <Status error={read.error} message={item ? t("正在讀取設定") : t("選擇設定，或建立角色與場景設定。")} />
        )}
      </div>
    </div>
  );
}

function EntryForm({
  project,
  id,
  saved,
  head,
  refresh,
  onSave,
}: {
  project: StudioProject;
  id: string;
  saved: StudioCreativeEntryVersion | undefined;
  head: number;
  refresh: () => Promise<void>;
  onSave: (id: string) => void;
}) {
  const client = useQueryClient();
  const [name, setName] = useState(saved?.name ?? "");
  const [kind, setKind] = useState<StudioCreativeEntryWrite["kind"]>(saved?.kind ?? "character");
  const [fields, setFields] = useState(() => rowsOf(saved?.fields));
  const [refs, setRefs] = useState<string[]>(() => saved?.references.map((r) => r.item_id) ?? []);
  const previous = useQuery({
    queryKey: ["creative-entry-previous", project.project_id, id, saved?.revision],
    queryFn: ({ signal }) => entryRead(project.project_id, id, (saved?.revision ?? 1) - 1, signal),
    enabled: !!saved && saved.revision > 1,
    retry: false,
  });
  const save = useMutation({
    mutationFn: () => {
      const body: StudioCreativeEntryWrite = {
        name,
        kind,
        fields: fieldsOf(fields),
        reference_items: refs,
        expected_revision: head,
        project_revision: project.revision,
      };
      return studioWrite("StudioCreativeEntryVersion", project.project_id, `${creativeRoot(project.project_id)}/entries/${encodeURIComponent(id)}`, {
        method: "PUT",
        json: body,
      });
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["creative-entry", project.project_id, id] });
      await refresh();
      onSave(id);
    },
    retry: false,
  });
  const historical = !!saved && saved.revision !== head;
  const prior = previous.data?.version;
  const diff =
    prior && saved
      ? Array.from(new Set([...Object.keys(prior.fields), ...Object.keys(saved.fields)])).filter(
          (f) => prior.fields[f] !== saved.fields[f],
        )
      : [];
  return (
    <div className="space-y-4">
      <fieldset disabled={historical} className="min-w-0 space-y-4">
        <div className="grid grid-cols-[minmax(5rem,0.45fr)_minmax(0,1fr)] gap-3">
          <label className="text-caption text-fg-secondary">
            {t("設定類型")}
            <Select
              compact
              value={kind}
              disabled={!!saved}
              onChange={(e) => { setKind(e.target.value === "scene" ? "scene" : "character"); }}
            >
              <option value="character">{t("角色")}</option>
              <option value="scene">{t("場景")}</option>
            </Select>
          </label>
          <label className="text-caption text-fg-secondary">
            {t("設定名稱")}
            <Input compact maxLength={200} value={name} onChange={(e) => { setName(e.target.value); }} />
          </label>
        </div>
        <FieldRows label={t("固定設定")} rows={fields} onChange={setFields} />
        {(project.library ?? []).some((r) => r.kind === "image") ? (
          <details className="rounded-md border border-line p-2">
            <summary className="cursor-pointer text-caption text-fg-secondary">
              {t("參考圖片")} · {refs.length}
            </summary>
            {project.library
              ?.filter((r) => r.kind === "image")
              .map((r) => (
                <Checkbox
                  key={r.item_id}
                  label={r.name}
                  checked={refs.includes(r.item_id)}
                  onChange={(e) => { setRefs(e.target.checked ? [...refs, r.item_id] : refs.filter((v) => v !== r.item_id)); }}
                />
              ))}
          </details>
        ) : null}
      </fieldset>
      {prior && saved ? (
        <details className="text-caption">
          <summary className="cursor-pointer">{t("與上一版比較")}</summary>
          <div className="mt-2 grid gap-2">
            {prior.name !== saved.name ? (
              <div>
                {prior.name} → {saved.name}
              </div>
            ) : null}
            {diff.map((f) => (
              <div key={f}>
                <b>{f}</b> · {prior.fields[f] ?? "—"} → {saved.fields[f] ?? "—"}
              </div>
            ))}
            {prior.references.map((r) => r.file.file_id).join(",") !== saved.references.map((r) => r.file.file_id).join(",") ? (
              <div>
                {prior.references.map((r) => r.name).join(", ")} → {saved.references.map((r) => r.name).join(", ")}
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
      <Button size="sm" disabled={!name.trim() || historical || save.isPending} onClick={() => { save.mutate(); }}>
        {t("儲存設定版本")}
      </Button>
      <Status
        error={save.error ?? previous.error}
        message={historical ? t("正在檢視歷史版本") : save.isSuccess ? t("已儲存設定版本") : undefined}
      />
    </div>
  );
}
