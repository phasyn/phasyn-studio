import { useState } from "react";
import { uploadFile } from "@/api/files";
import type { StudioTimeline } from "@/api/generated/contracts";
import { contractJson } from "@/api/http";
import { fetchProject } from "@/api/studioProjects";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { errorText } from "@/lib/errors";
import { isRecord, valuesEqual } from "@/lib/json";
import { useEditor } from "../editorContext";

function externalUrls(doc: unknown, tracks: readonly { name: string; kind: string }[] | null): string[] {
  if (!isRecord(doc) || !isRecord(doc["tracks"]) || !Array.isArray(doc["tracks"]["children"])) return [];
  const urls = new Set<string>();
  for (const track of doc["tracks"]["children"]) {
    if (!isRecord(track) || !Array.isArray(track["children"])) continue;
    if (tracks && !tracks.some(t => typeof track["name"] === "string" && t.name.toLowerCase() === track["name"].toLowerCase()
      && typeof track["kind"] === "string" && t.kind === track["kind"].toLowerCase())) continue;
    for (const clip of track["children"]) {
      if (!isRecord(clip) || !isRecord(clip["media_references"]) || typeof clip["active_media_reference_key"] !== "string") continue;
      const ref = clip["media_references"][clip["active_media_reference_key"]];
      if (!isRecord(ref) || typeof ref["target_url"] !== "string") continue;
      if (!/^media\/[a-f0-9]{64}\.[a-z0-9]+$/.test(ref["target_url"])) urls.add(ref["target_url"]);
    }
  }
  return [...urls];
}

export function OtioExchangeImport({ path, revision }: { path: string; revision: number }) {
  const { project, flush, dispatch } = useEditor();
  const [doc, setDoc] = useState<unknown>(null);
  const [media, setMedia] = useState<Record<string, File>>({});
  const [edits, setEdits] = useState<{ base: StudioTimeline; next: StudioTimeline } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<readonly string[] | null>(null);
  const projectTracks = project.timeline?.tracks ?? [];
  const urls = externalUrls(doc, scope === null ? null : projectTracks.filter(track => scope.includes(track.track_id)));
  async function read(file?: File) {
    setEdits(null); setError(""); setMedia({}); setDoc(null);
    if (!file) return;
    setBusy(true);
    try {
      if (file.size > 12 * 1024 * 1024) throw new Error(t("OTIO 文件過大"));
      const parsed: unknown = JSON.parse(await file.text());
      if (!isRecord(parsed) || parsed["OTIO_SCHEMA"] !== "Timeline.1") throw new Error(t("無法讀取 OTIO 時間軸"));
      setDoc(parsed);
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  }
  async function preview() {
    setBusy(true); setError(""); setEdits(null);
    try {
      await flush();
      const saved = await fetchProject(project.project_id);
      if (!saved.timeline || saved.revision !== revision || !valuesEqual(saved.timeline, project.timeline)) throw new Error(t("專案版本已變更，請重新開啟交換視窗。"));
      const relinks: Record<string, string> = {};
      for (const url of urls) {
        const file = media[url];
        if (!file) throw new Error(t("請指定每個外部媒體檔。"));
        relinks[url] = (await uploadFile(file)).file_id;
      }
      const next = await contractJson("StudioTimeline", path + "/edits", { method: "POST", json: { revision, document: doc, relinks, ...(scope !== null ? { track_ids: scope } : {}) } });
      setEdits({ base: saved.timeline, next });
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  }
  return <details className="grid gap-2"><summary>{t("匯回 Kdenlive 剪輯")}</summary><div className="grid gap-2 py-2">
    <p className="text-caption">{t("選擇從 Kdenlive 匯出的 OTIO。支援同名軌的切割、裁切與同內容媒體重新連結，字幕與標記沿用目前專案。")}</p>
    <label>{t("剪輯檔")} <input type="file" accept=".otio,.json" disabled={busy} onChange={e => void read(e.target.files?.[0])} /></label>
    {doc !== null && <fieldset disabled={busy} className="grid gap-1">
      <legend>{t("回剪範圍")}</legend>
      <label><input type="checkbox" checked={scope === null} onChange={e => { setScope(e.target.checked ? null : []); setEdits(null); }} /> {t("全部原始軌道")}</label>
      {scope !== null && projectTracks.map(track => <label key={track.track_id}><input type="checkbox" checked={scope.includes(track.track_id)} onChange={e => {
        setScope(e.target.checked ? [...scope, track.track_id] : scope.filter(id => id !== track.track_id)); setEdits(null);
      }} /> {track.name}</label>)}
      <p className="text-caption">{t("效果素材保有獨立身分。從交付版回剪時，可指定未參與烘焙的原始軌道。")}</p>
    </fieldset>}
    {urls.map(url => <label key={url} className="grid break-all text-caption">{url}<input type="file" disabled={busy} onChange={e => { const file = e.target.files?.[0]; if (file) setMedia(previous => ({ ...previous, [url]: file })); setEdits(null); }} /></label>)}
    <Button size="sm" disabled={doc === null || busy || scope?.length === 0 || urls.some(url => !media[url])} onClick={() => void preview()}>{t("比對素材並預覽回剪")}</Button>
    {edits && <><p>{t("原片段")} {edits.base.clips.length} · {t("回剪片段")} {edits.next.clips.length}</p>
      <ol className="max-h-40 overflow-y-auto text-caption">{edits.next.clips.map(c => <li key={c.clip_id}>{c.track_id} · {c.name} · [{c.in_frame}, {c.out_frame}) → {c.start_frame}</li>)}</ol>
      <Button size="sm" disabled={project.revision !== revision || !valuesEqual(edits.base, project.timeline)} onClick={() => { dispatch({ type: "setTimeline", timeline: edits.next }); setEdits(null); }}>{t("採用預覽的剪輯")}</Button></>}
    {error && <p role="alert" className="text-warning">{error}</p>}
  </div></details>;
}
