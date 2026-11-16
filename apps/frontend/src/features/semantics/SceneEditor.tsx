import { ImageOff, Plus, Trash } from "lucide-react";
import { useRef, useState } from "react";
import type { SceneDocument, SceneEntity, SceneEvent } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import { CommitInput } from "@/components/common/CommitInput";
import { Disclosure } from "@/components/common/Disclosure";
import { JsonView } from "@/components/common/JsonView";
import { StringListEditor } from "@/components/common/StringListEditor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/controls";
import { cn } from "@/lib/cn";
import { localIdError } from "@/lib/ids";
import { useStableKeys } from "@/lib/useStableKeys";
import { newEntityId, newEvent, type SceneIssue } from "./sceneModel";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

function SecondsInput({ id, label, value, onChange, invalid }: { id: string; label: string; value: number; onChange: (next: number) => void; invalid?: boolean }) {
  const external = String(value);
  const [draft, setDraft] = useState<{ base: string; text: string } | null>(null);
  const text = draft && draft.base === external ? draft.text : external;
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-caption text-fg-secondary">
        {t("{label}（秒）", { label })}
      </label>
      <Input
        id={id}
        className="machine"
        inputMode="decimal"
        value={text}
        aria-invalid={invalid || undefined}
        onChange={(event) => {
          const raw = event.target.value;
          const parsed = Number(raw);
          if (raw.trim() !== "" && Number.isFinite(parsed)) {
            setDraft({ base: String(parsed), text: raw });
            onChange(parsed);
          } else {
            setDraft({ base: external, text: raw });
          }
        }}
      />
    </div>
  );
}

function pct(seconds: number, duration: number): number {
  if (!(duration > 0)) return 0;
  return Math.max(0, Math.min(100, (seconds / duration) * 100));
}

/** 來源影片＋時間軸：事件條依 start/end 落在影片時間上；點事件或證據幀跳到該時間。 */
function SceneTimeline({ scene, issues }: { scene: SceneDocument; issues: readonly SceneIssue[] }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [current, setCurrent] = useState(0);
  const [failed, setFailed] = useState(false);
  const duration = scene.duration_seconds;
  const seek = (seconds: number) => {
    const video = videoRef.current;
    if (video) video.currentTime = seconds;
    setCurrent(seconds);
  };
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => fraction * duration);
  return (
    <div className="grid min-w-0 gap-3">
      {failed ? (
        <p className="grid min-h-24 place-items-center rounded-xl border border-line-subtle bg-sunken p-4 text-caption text-fg-secondary">
          {t("無法播放來源影片（檔案不存在、持有的 Node 離線或格式不支援）。時間軸仍可編輯。")}
        </p>
      ) : (
        <video
          ref={videoRef}
          controls
          preload="metadata"
          src={mediaUrl(scene.source.node_id, scene.source.file_id)}
          aria-label={t("來源影片")}
          onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
          onError={() => setFailed(true)}
          className="max-h-[50vh] w-full rounded-xl border border-line-subtle bg-stage object-contain shadow-raised"
        />
      )}
      <div className="grid gap-1" role="group" aria-label={t("事件時間軸（相對來源影片時間）")}>
        <div className="relative h-5 border-b border-line-subtle">
          {ticks.map((tick) => (
            <span key={tick} className="absolute top-0 machine text-caption text-fg-tertiary" style={{ left: `calc(${pct(tick, duration)}% - ${tick === duration ? 2.5 : 0}rem)` }}>
              {`${tick.toFixed(2)}s`}
            </span>
          ))}
        </div>
        <div className="relative h-7" aria-label={t("證據幀")}>
          {scene.evidence.map((frame) => (
            <button
              key={frame.frame_id}
              type="button"
              title={`${frame.frame_id} · ${frame.time_seconds.toFixed(3)} s`}
              aria-label={t("跳到證據幀 {frame_id}（{time_seconds} 秒）", { frame_id: frame.frame_id, time_seconds: frame.time_seconds.toFixed(3) })}
              onClick={() => seek(frame.time_seconds)}
              className="pressable absolute top-1 h-5 w-2 -translate-x-1/2 rounded-full bg-file hover:bg-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
              style={{ left: `${pct(frame.time_seconds, duration)}%` }}
            />
          ))}
          <span aria-hidden className="pointer-events-none absolute top-0 bottom-0 w-0.5 -translate-x-1/2 rounded-full bg-brand-cyan shadow-glow-sm" style={{ left: `${pct(current, duration)}%` }}>
            <span className="absolute -top-1 left-1/2 size-2 -translate-x-1/2 rounded-full bg-brand-cyan shadow-glow-sm" />
          </span>
        </div>
        <ol className="grid gap-1">
          {scene.events.map((event, index) => {
            const outOfRange = event.end_seconds > duration || event.start_seconds < 0 || event.end_seconds < event.start_seconds;
            const left = pct(event.start_seconds, duration);
            const width = Math.max(0.8, pct(event.end_seconds, duration) - left);
            const hasIssue = issues.some((issue) => issue.path.startsWith(`events[${index}]`));
            return (
              <li key={`${event.event_id}-${index}`} className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-2">
                <code className="machine truncate text-caption text-fg-secondary" title={event.event_id}>
                  {event.event_id}
                </code>
                <div className="relative h-7 rounded-md bg-sunken shadow-[inset_0_0_0_1px_var(--color-line-subtle)]">
                  <button
                    type="button"
                    onClick={() => seek(Math.max(0, event.start_seconds))}
                    aria-label={t("事件 {event_id}：{start_seconds}–{end_seconds} 秒，{value}；跳到開始時間", { event_id: event.event_id, start_seconds: event.start_seconds, end_seconds: event.end_seconds, value: event.certainty === "uncertain" ? t("不確定") : t("已觀測") })}
                    title={event.description}
                    className={cn(
                      "pressable absolute top-1 h-5 rounded-md border text-left hover:brightness-125 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus",
                      event.certainty === "uncertain"
                        ? "border-dashed border-warning bg-warning/20"
                        : "border-brand-blue/70 bg-linear-to-r from-brand-blue/50 to-brand-violet/50 shadow-[inset_0_1px_0_rgb(255_255_255/0.12)]",
                      (outOfRange || hasIssue) && "border-danger bg-danger/20 bg-none",
                    )}
                    style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ol>
        <p className="text-caption text-fg-tertiary">{t("時間是來源影片時間（0–{duration} s）。實線＝已觀測；虛線＝不確定（caption 預設排除）；紅框＝時間或引用有錯。", { duration })}</p>
      </div>
    </div>
  );
}

function EntitiesEditor({ scene, onChange }: { scene: SceneDocument; onChange: (next: SceneDocument) => void }) {
  const stable = useStableKeys(scene.entities.length);
  const update = (index: number, entity: SceneEntity) => onChange({ ...scene, entities: scene.entities.map((item, position) => (position === index ? entity : item)) });
  return (
    <section className="grid gap-2" aria-labelledby="scene-entities-title">
      <div className="flex items-center justify-between gap-2">
        <h4 id="scene-entities-title" className="text-data font-semibold text-fg">
          {t("主體（entities，{entitiesCount}）", { entitiesCount: scene.entities.length })}
        </h4>
        <Button
          size="sm"
          icon={<Plus aria-hidden />}
          onClick={() => {
            stable.append();
            onChange({ ...scene, entities: [...scene.entities, { entity_id: newEntityId(scene), kind: "", description: "" }] });
          }}
        >
          {t("新增主體")}
        </Button>
      </div>
      <ul className="grid gap-2">
        {scene.entities.map((entity, index) => (
          <li key={stable.keys[index]} className="grid gap-2 rounded-lg border border-line-subtle p-2 animate-rise-in @xl:grid-cols-[10rem_8rem_minmax(0,1fr)_auto]">
            <CommitInput
              id={`entity-${index}-id`}
              label={t("主體 {index} 的 entity_id", { index: index + 1 })}
              value={entity.entity_id}
              onCommit={(next) => {
                const error = localIdError(next, "entity_id ");
                if (error) return error;
                if (scene.entities.some((other, position) => position !== index && other.entity_id === next)) return t("entity_id 重複");
                onChange({
                  ...scene,
                  entities: scene.entities.map((item, position) => (position === index ? { ...item, entity_id: next } : item)),
                  events: scene.events.map((event) => ({ ...event, entity_ids: event.entity_ids.map((id) => (id === entity.entity_id ? next : id)) })),
                });
                return null;
              }}
            />
            <Input aria-label={t("主體 {entity_id} 的種類", { entity_id: entity.entity_id })} placeholder="person" value={entity.kind} onChange={(event) => update(index, { ...entity, kind: event.target.value })} />
            <Input aria-label={t("主體 {entity_id} 的描述", { entity_id: entity.entity_id })} value={entity.description} onChange={(event) => update(index, { ...entity, description: event.target.value })} />
            <Button
              size="icon"
              variant="danger"
              aria-label={t("刪除主體 {entity_id}（事件中的引用一併移除）", { entity_id: entity.entity_id })}
              onClick={() => {
                stable.remove(index);
                onChange({
                  ...scene,
                  entities: scene.entities.filter((_, position) => position !== index),
                  events: scene.events.map((event) => ({ ...event, entity_ids: event.entity_ids.filter((id) => id !== entity.entity_id) })),
                });
              }}
            >
              <Trash aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function toggle(list: readonly string[], id: string, on: boolean): string[] {
  return on ? [...new Set([...list, id])] : list.filter((item) => item !== id);
}

function EventsEditor({ scene, onChange, issues }: { scene: SceneDocument; onChange: (next: SceneDocument) => void; issues: readonly SceneIssue[] }) {
  const stable = useStableKeys(scene.events.length);
  const update = (index: number, event: SceneEvent) => onChange({ ...scene, events: scene.events.map((item, position) => (position === index ? event : item)) });
  return (
    <section className="grid gap-2" aria-labelledby="scene-events-title">
      <div className="flex items-center justify-between gap-2">
        <h4 id="scene-events-title" className="text-data font-semibold text-fg">
          {t("事件（events，{eventsCount}）", { eventsCount: scene.events.length })}
        </h4>
        <Button
          size="sm"
          icon={<Plus aria-hidden />}
          onClick={() => {
            stable.append();
            onChange({ ...scene, events: [...scene.events, newEvent(scene)] });
          }}
        >
          {t("新增事件")}
        </Button>
      </div>
      <ol className="grid gap-3">
        {scene.events.map((event, index) => {
          const eventIssues = issues.filter((issue) => issue.path.startsWith(`events[${index}]`));
          const base = `event-${index}`;
          return (
            <li key={stable.keys[index]} className="grid gap-3 rounded-xl border border-line-subtle bg-sunken/40 p-3 animate-rise-in">
              <div className="grid gap-3 @md:grid-cols-2 @2xl:grid-cols-[9rem_8rem_8rem_10rem_auto]">
                <div className="grid gap-1">
                  <label htmlFor={`${base}-id`} className="text-caption text-fg-secondary">
                    event_id
                  </label>
                  <Input id={`${base}-id`} className="machine" value={event.event_id} onChange={(e) => update(index, { ...event, event_id: e.target.value })} />
                </div>
                <SecondsInput id={`${base}-start`} label={t("開始")} value={event.start_seconds} onChange={(next) => update(index, { ...event, start_seconds: next })} invalid={eventIssues.some((issue) => issue.path.endsWith("start_seconds"))} />
                <SecondsInput id={`${base}-end`} label={t("結束")} value={event.end_seconds} onChange={(next) => update(index, { ...event, end_seconds: next })} invalid={eventIssues.some((issue) => issue.path.endsWith("end_seconds"))} />
                <div className="grid gap-1">
                  <label htmlFor={`${base}-certainty`} className="text-caption text-fg-secondary">
                    {t("確定性")}
                  </label>
                  <Select id={`${base}-certainty`} value={event.certainty} onChange={(e) => update(index, { ...event, certainty: e.target.value === "uncertain" ? "uncertain" : "observed" })}>
                    <option value="observed">{t("observed（已觀測）")}</option>
                    <option value="uncertain">{t("uncertain（不確定）")}</option>
                  </Select>
                </div>
                <Button
                  size="icon"
                  variant="danger"
                  className="self-end"
                  aria-label={t("刪除事件 {event_id}", { event_id: event.event_id })}
                  onClick={() => {
                    stable.remove(index);
                    onChange({ ...scene, events: scene.events.filter((_, position) => position !== index) });
                  }}
                >
                  <Trash aria-hidden />
                </Button>
              </div>
              <div className="grid gap-1">
                <label htmlFor={`${base}-description`} className="text-caption text-fg-secondary">
                  {t("描述（只寫看得到的事實）")}
                </label>
                <Textarea id={`${base}-description`} rows={2} className="min-h-16" value={event.description} onChange={(e) => update(index, { ...event, description: e.target.value })} />
              </div>
              <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <legend className="mb-1 text-caption text-fg-secondary">{t("主體")}</legend>
                {scene.entities.length === 0 ? <span className="text-caption text-fg-tertiary">{t("尚無主體")}</span> : null}
                {scene.entities.map((entity) => (
                  <label key={entity.entity_id} className="inline-flex min-h-8 cursor-pointer items-center gap-1.5 text-data text-fg-secondary">
                    <input
                      type="checkbox"
                      className="accent-action"
                      checked={event.entity_ids.includes(entity.entity_id)}
                      onChange={(e) => update(index, { ...event, entity_ids: toggle(event.entity_ids, entity.entity_id, e.target.checked) })}
                    />
                    <code className="machine">{entity.entity_id}</code>
                  </label>
                ))}
              </fieldset>
              <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <legend className="mb-1 text-caption text-fg-secondary">{t("證據幀")}</legend>
                {scene.evidence.length === 0 ? <span className="text-caption text-fg-tertiary">{t("Scene 沒有證據幀")}</span> : null}
                {scene.evidence.map((frame) => (
                  <label key={frame.frame_id} className="inline-flex min-h-8 cursor-pointer items-center gap-1.5 text-data text-fg-secondary">
                    <input
                      type="checkbox"
                      className="accent-action"
                      checked={event.evidence_frame_ids.includes(frame.frame_id)}
                      onChange={(e) => update(index, { ...event, evidence_frame_ids: toggle(event.evidence_frame_ids, frame.frame_id, e.target.checked) })}
                    />
                    <code className="machine">
                      {frame.frame_id}@{frame.time_seconds.toFixed(2)}s
                    </code>
                  </label>
                ))}
              </fieldset>
              {eventIssues.length > 0 ? (
                <ul className="grid gap-0.5 text-caption text-danger">
                  {eventIssues.map((issue, position) => (
                    <li key={position}>{issue.message}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function EvidenceGallery({ scene }: { scene: SceneDocument }) {
  if (scene.evidence.length === 0) return <p className="text-caption text-fg-tertiary">{t("Scene 沒有證據幀。")}</p>;
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
      {scene.evidence.map((frame) => (
        <li key={frame.frame_id} className="group grid gap-1">
          {frame.file ? (
            <span className="block overflow-hidden rounded-lg border border-line-subtle bg-sunken transition-[border-color,box-shadow] duration-(--duration-fast) group-hover:border-line-strong group-hover:shadow-raised">
              <img
                src={mediaUrl(frame.file.node_id, frame.file.file_id)}
                alt={t("證據幀 {frame_id}，{time_seconds} 秒", { frame_id: frame.frame_id, time_seconds: frame.time_seconds.toFixed(3) })}
                loading="lazy"
                className="aspect-video w-full object-contain transition-[scale] duration-(--duration-spring-snappy) ease-(--ease-spring-snappy) group-hover:scale-[1.03]"
              />
            </span>
          ) : (
            <div className="grid aspect-video place-items-center rounded-lg border border-line-subtle bg-sunken text-caption text-fg-tertiary">
              <ImageOff aria-hidden className="size-4" />
              {t("無縮圖")}
            </div>
          )}
          <p className="machine text-caption text-fg-secondary">{`${frame.frame_id} · ${frame.time_seconds.toFixed(3)} s`}</p>
          <p className="machine text-caption text-fg-tertiary">{`pts ${frame.source_pts} · ${frame.time_base.num}/${frame.time_base.den}`}</p>
        </li>
      ))}
    </ul>
  );
}

/** Scene 編修：觀測事實與 generation edits 分開編輯；原檔不變，另存為新檔。版面依自身寬度（container query）而非視窗寬度切換欄數。 */
export function SceneEditor({ scene, onChange, issues }: { scene: SceneDocument; onChange: (next: SceneDocument) => void; issues: readonly SceneIssue[] }) {
  return (
    <div className="@container grid min-w-0 gap-5">
      <div className="grid min-w-0 gap-5 @4xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <SceneTimeline scene={scene} issues={issues} />
        <div className="grid content-start gap-4">
          <p className="flex flex-wrap items-center gap-2 text-data text-fg-secondary">
            <T source={"長度 <0>{duration_seconds} s</0>{badge}{badge2}{badge3}"} values={{ duration_seconds: scene.duration_seconds, badge: <Badge>{t("{eventsCount} 個事件", { eventsCount: scene.events.length })}</Badge>, badge2: <Badge>{t("{entitiesCount} 個主體", { entitiesCount: scene.entities.length })}</Badge>, badge3: <Badge>{t("{evidenceCount} 個證據幀", { evidenceCount: scene.evidence.length })}</Badge> }} slots={[<code className="machine text-fg" />]} />
          </p>
          <div className="grid gap-1">
            <label htmlFor="scene-camera" className="text-data font-medium text-fg-secondary">
              {t("鏡頭（camera）")}
            </label>
            <Textarea id="scene-camera" rows={2} className="min-h-16" value={scene.camera} onChange={(event) => onChange({ ...scene, camera: event.target.value })} />
          </div>
          <div className="grid gap-3 @lg:grid-cols-2">
            <div className="grid gap-1">
              <label htmlFor="scene-initial" className="text-data font-medium text-fg-secondary">
                {t("開始狀態")}
              </label>
              <Textarea id="scene-initial" rows={2} className="min-h-16" value={scene.initial_state} onChange={(event) => onChange({ ...scene, initial_state: event.target.value })} />
            </div>
            <div className="grid gap-1">
              <label htmlFor="scene-final" className="text-data font-medium text-fg-secondary">
                {t("結束狀態")}
              </label>
              <Textarea id="scene-final" rows={2} className="min-h-16" value={scene.final_state} onChange={(event) => onChange({ ...scene, final_state: event.target.value })} />
            </div>
          </div>
          <StringListEditor
            id="scene-unknowns"
            label={t("未知／看不清楚（unknowns，一行一項）")}
            value={scene.unknowns}
            onChange={(next) => onChange({ ...scene, unknowns: next })}
            help={t("模型沒看見或無法確定的內容留在這裡，不要寫成事實。")}
          />
        </div>
      </div>
      <EntitiesEditor scene={scene} onChange={onChange} />
      <EventsEditor scene={scene} onChange={onChange} issues={issues} />
      <section className="grid gap-2 rounded-xl border border-entity/40 bg-surface p-3" aria-labelledby="scene-edits-title">
        <h4 id="scene-edits-title" className="text-data font-semibold text-entity">
          {t("生成用修改（generation_edits）")}
        </h4>
        <p className="text-caption text-fg-tertiary">{t("只影響 generation prompt；不會進入 training caption，也不改變上面的觀測事實。")}</p>
        <StringListEditor
          id="scene-generation-edits"
          label={t("generation edits（一行一項）")}
          value={scene.generation_edits}
          onChange={(next) => onChange({ ...scene, generation_edits: next })}
          placeholder={t("例：將灰衣改為紅衣（僅生成）")}
        />
      </section>
      <section className="grid gap-2" aria-labelledby="scene-evidence-title">
        <h4 id="scene-evidence-title" className="text-data font-semibold text-fg">
          {t("證據幀（實際 PTS）")}
        </h4>
        <EvidenceGallery scene={scene} />
      </section>
      <Disclosure summary={t("caption_model 與完整 Scene JSON")}>
        <div className="grid gap-2">
          <JsonView value={scene.caption_model} label="caption_model" maxHeightClass="max-h-40" />
          <JsonView value={scene} label="SceneDocument" fileName="scene-draft.json" maxHeightClass="max-h-80" />
        </div>
      </Disclosure>
    </div>
  );
}
