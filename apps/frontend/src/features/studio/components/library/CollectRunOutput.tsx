import { useState } from "react";
import { useRunList } from "@/api/runs";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/controls";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { errorText } from "@/lib/errors";
import { publishedMedia } from "../../model/runMedia";
import { useStudio } from "../../studioContext";

function CollectionForm({ close }: { close: () => void }) {
  const { runTimelineCommands } = useStudio();
  const runs = useRunList(25, "include", undefined, "summary");
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const choices = (runs.data?.pages ?? []).flatMap(page => page.items.flatMap(run => publishedMedia(run).map(output => ({
    ...output, run: run.run_id, key: JSON.stringify([run.run_id, output.port]),
    label: `${run.request.label ?? run.request.pipeline.label} · ${output.port} · ${run.run_id}`,
  }))));
  const output = choices.find(row => row.key === selected);
  async function collect() {
    if (!output || !name.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await runTimelineCommands([{ op: "collect_output", name: name.trim(), run_id: output.run,
        output_key: output.port, expected_source_sha256: output.file.sha256 }]);
      close();
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  return <DialogBody className="grid gap-3">
    <label>{t("執行輸出")}<Select value={selected} onChange={e => {
      setSelected(e.target.value);
      const chosen = choices.find(row => row.key === e.target.value);
      if (chosen) setName(chosen.port);
    }}>
      <option value="">{t("選取已完成的影音或圖片")}</option>
      {choices.map(row => <option key={row.key} value={row.key}>{row.label}</option>)}
    </Select></label>
    {runs.hasNextPage && <Button disabled={runs.isFetchingNextPage} onClick={() => { void runs.fetchNextPage(); }}>{t("載入更多執行紀錄")}</Button>}
    <label>{t("素材名稱")}<Input value={name} maxLength={200} onChange={e => { setName(e.target.value); }} /></label>
    {(error || runs.error) && <p role="alert">{error || errorText(runs.error)}</p>}
    <Button pending={busy} disabled={!output || !name.trim()} onClick={() => { void collect(); }}>{t("加入素材庫")}</Button>
  </DialogBody>;
}

export function CollectRunOutput() {
  const [open, setOpen] = useState(false);
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button size="sm">{t("從執行結果加入…")}</Button></DialogTrigger>
    <DialogContent><DialogHeader><DialogTitle>{t("從執行結果加入素材")}</DialogTitle>
      <DialogDescription>{t("保留產生素材的執行紀錄與檔案版本。")}</DialogDescription>
    </DialogHeader>{open && <CollectionForm close={() => { setOpen(false); }} />}</DialogContent>
  </Dialog>;
}
