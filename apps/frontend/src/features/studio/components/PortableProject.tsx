// 專案可攜包: one .zip with the project's shots, takes, media and generation recipes, to go on on another workstation.
// Downloading the open project is the export dialog's 「專案可攜包」 tab (PortableDownload); importing one makes a new
// project, so it sits with the projects: the project list page's 「匯入可攜包」 and the new-project panel
// (PortableImport, or PortableImportDialog around it). The file is chosen with a button (the native file field is
// hidden: its label would follow the browser's language); the package is checked first and reported in plain words,
// with the component and missing-item identifiers behind 「詳細」.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, CircleAlert, FileArchive, FolderInput, PackageOpen } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";
import type { StudioProject, StudioPortableReport } from "@/api/generated/contracts";
import { apiFetch, contractJson } from "@/api/http";
import { studioKeys, useStudioProjects } from "@/api/studioProjects";
import { Disclosure } from "@/components/common/Disclosure";
import { Button } from "@/components/ui/button";
import { CARD } from "@/components/ui/look";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { downloadBlob } from "@/lib/download";
import { errorText } from "@/lib/errors";
import { localId } from "../model/ids";
import { importTitle, missingDigests, portableMissing } from "../model/portableMissing";

/** What the package holds, in words a creator uses. */
function reportLine(report: StudioPortableReport): string {
  return t("{shots} 個版本、{files} 個素材檔、{runs} 筆生成紀錄", { shots: report.take_count, files: report.file_count, runs: report.run_count });
}

function Report({ report }: { report: StudioPortableReport }) {
  const unavailable = report.requirements.filter((item) => item.component_available === false).length;
  return (
    <div className={cn(CARD, "grid gap-2 px-3 py-2.5 animate-fade-in")}>
      <p className="flex min-w-0 items-center gap-2 text-body font-semibold text-fg">
        <PackageOpen aria-hidden className="size-4 shrink-0 text-brand-cyan" />
        <span className="truncate" title={report.title}>{report.title || t("未命名專案")}</span>
      </p>
      <p className="text-data text-fg-secondary">{reportLine(report)}</p>
      {unavailable > 0 ? (
        <p className="flex items-start gap-1.5 text-data text-warning">
          <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {t("這台工作站少了 {count} 個生成元件：可以匯入並剪輯，但要重新生成前得先安裝它們。", { count: unavailable })}
        </p>
      ) : null}
      {report.missing.length > 0 ? (
        <p className="flex items-start gap-1.5 text-data text-warning">
          <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {report.importable
            ? t("包裡缺少 {count} 個項目，匯入後這些地方會是空的。", { count: report.missing.length })
            : t("包裡缺少 {count} 個必要項目，無法匯入。請重新從原工作站下載可攜包。", { count: report.missing.length })}
        </p>
      ) : null}
      {report.requirements.length + report.missing.length > 0 ? (
        <Disclosure summary={t("詳細")} summaryClassName="text-caption">
          <ul className="grid gap-0.5 text-caption text-fg-tertiary">
            {report.requirements.map((item) => (
              <li key={`${item.node_id}:${item.component_id}`} className="machine truncate">
                {t("需要元件：{component}", { component: item.component_id })}
                {item.component_available === false ? t("（這台沒有）") : ""}
              </li>
            ))}
            {report.missing.map((item) => (
              <li key={`${item.kind}:${item.id}`} className="machine truncate">
                {t("缺少：{kind} {id}", { kind: item.kind, id: item.id })}
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </div>
  );
}

/** Choose a package, check it, import it as a new project. */
export function PortableImport({ onImported }: { onImported: (projectId: string) => void }) {
  const client = useQueryClient();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<StudioPortableReport | null>(null);
  const [target, setTarget] = useState(() => localId("p"));
  const options = (body: File) => ({ method: "POST" as const, headers: { "Content-Type": "application/zip" }, body });
  const inspect = useMutation({
    mutationFn: (body: File) => contractJson("StudioPortableReport", "/api/studio/portable/inspect", options(body)),
    onSuccess: setReport,
    retry: false,
  });
  const projects = useStudioProjects();
  const restore = useMutation({
    // The copy gets its own name (「原名（匯入）」, numbered when that is taken), so the list never shows two identical titles
    mutationFn: (body: File) => contractJson("StudioPortableImport", "/api/studio/portable/import/" + encodeURIComponent(target), {
      ...options(body),
      query: { title: importTitle(report?.title ?? "", (projects.data?.items ?? []).map((item) => item.title)) },
    }),
    onSuccess: ({ project }) => {
      client.setQueryData(studioKeys.project(project.project_id), project);
      void client.invalidateQueries({ queryKey: studioKeys.projects() });
      onImported(project.project_id);
    },
    retry: false,
  });
  const busy = inspect.isPending || restore.isPending;
  const error = inspect.error ?? restore.error;
  return (
    <section aria-label={t("匯入可攜包")} className="grid content-start gap-3">
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept=".zip,application/zip"
        className="sr-only"
        tabIndex={-1}
        disabled={busy}
        onChange={(event) => {
          const next = event.target.files?.[0] ?? null;
          event.target.value = "";
          setFile(next);
          setTarget(localId("p"));
          setReport(null);
          inspect.reset();
          restore.reset();
          if (next) inspect.mutate(next);
        }}
      />
      <div className="flex min-w-0 items-center gap-2">
        <Button size="sm" variant="secondary" icon={<FileArchive aria-hidden />} disabled={busy} onClick={() => inputRef.current?.click()}>
          {file ? t("換一個檔案…") : t("選擇可攜包…")}
        </Button>
        <span className="min-w-0 truncate text-data text-fg-secondary" title={file?.name}>
          {file ? file.name : t("尚未選擇檔案（.zip）")}
        </span>
      </div>
      {inspect.isPending ? (
        <p role="status" className="text-data text-fg-tertiary">
          {t("正在檢查可攜包…")}
        </p>
      ) : null}
      {report ? <Report report={report} /> : null}
      {report?.importable === true ? (
        <p className="text-caption text-fg-secondary">
          {t("會建立新專案「{title}」", { title: importTitle(report.title, (projects.data?.items ?? []).map((item) => item.title)) })}
        </p>
      ) : null}
      {report ? (
        <Button variant="primary" icon={<FolderInput aria-hidden />} disabled={busy || !report.importable || !file} pending={restore.isPending} onClick={() => { if (file) restore.mutate(file); }} className="justify-self-start">
          {t("匯入為新專案")}
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="text-data text-danger">
          {errorText(error)}
        </p>
      ) : null}
    </section>
  );
}

/** The project list's 「匯入可攜包」 button and its dialog. */
export function PortableImportDialog({ onImported, trigger }: { onImported: (projectId: string) => void; trigger: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("匯入可攜包")}</DialogTitle>
          <DialogDescription>{t("把另一個工作站下載的專案可攜包（.zip）匯入成新專案，鏡頭、版本、素材與生成配方都會一起帶進來。")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {open ? (
            <PortableImport
              onImported={(projectId) => {
                setOpen(false);
                onImported(projectId);
              }}
            />
          ) : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/** The file name the Controller gives the package (Content-Disposition), else one built from the project. */
function packageName(response: Response, projectId: string, revision: number): string {
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const quoted = /filename="([^"]+)"/u.exec(disposition)?.[1];
  return quoted ?? `project-${projectId}-r${String(revision)}.zip`;
}

/** Why the package was refused, in words: the missing library items and takes by name, else the Controller's reason. */
function DownloadError({ project, error }: { project: StudioProject; error: unknown }) {
  const digests = missingDigests(error);
  if (digests === null) {
    return (
      <p role="alert" className="text-data text-danger">
        {errorText(error)}
      </p>
    );
  }
  const { names, others } = portableMissing(project, digests, (shot, take) => t("「{shot}」take {take}", { shot, take }));
  const shown = names.slice(0, 5);
  const more = names.length - shown.length + others;
  return (
    <div role="alert" className="grid gap-1.5 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 animate-fade-in">
      <p className="flex items-center gap-1.5 text-data font-medium text-danger">
        <CircleAlert aria-hidden className="size-4 shrink-0" />
        {t("沒有打包：有 {count} 個檔案找不到", { count: digests.length })}
      </p>
      {shown.length > 0 ? (
        <ul className="grid list-disc gap-0.5 pl-6 text-data text-fg-secondary">
          {shown.map((name) => (
            <li key={name} className="truncate" title={name}>{name}</li>
          ))}
        </ul>
      ) : null}
      {more > 0 ? <p className="text-caption text-fg-tertiary">{shown.length > 0 ? t("另外還有 {count} 個生成中間檔", { count: more }) : t("找不到的都是生成中間檔（{count} 個）", { count: more })}</p> : null}
      <p className="text-caption text-fg-secondary">{t("可攜包不會缺件帶走：這些檔案可能已被清理，或存放它們的 Node 離線。讓 Node 上線，或移除、重新產生用到它們的素材與 take 後再下載。")}</p>
    </div>
  );
}

/** The export dialog's 「專案可攜包」 tab: download the open project (saved first, at its latest revision). */
export function PortableDownload({ project, flush }: { project: StudioProject; flush: () => Promise<void> }) {
  // The package is read here instead of through a plain link: a refused package (missing media) then says why in the
  // dialog, instead of the browser saving the error as a file or failing silently in its download list
  const download = useMutation({
    mutationFn: async () => {
      await flush();
      const projectPath = "/api/studio/projects/" + encodeURIComponent(project.project_id);
      const latest = await contractJson("StudioProject", projectPath);
      const response = await apiFetch(projectPath + "/portable", { query: { revision: latest.revision }, headers: { Accept: "application/zip" } });
      downloadBlob(packageName(response, project.project_id, latest.revision), await response.blob());
    },
    retry: false,
  });
  return (
    <section className="grid content-start gap-4">
      <div className="grid gap-2 rounded-lg border border-line-subtle p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4">
        <div className="grid gap-1">
          <h3 className="text-body font-semibold text-fg">{t("下載專案可攜包")}</h3>
          <p className="text-caption text-fg-secondary">{t("把鏡頭、版本、素材與生成配方打包成一個 .zip，帶到另一個工作站繼續製作。")}</p>
        </div>
        <Button size="sm" variant="primary" icon={<Archive aria-hidden />} pending={download.isPending} onClick={() => { download.mutate(); }}>
          {download.isPending ? t("正在打包…") : t("下載 .zip")}
        </Button>
      </div>
      {download.isPending ? (
        <p role="status" className="text-caption text-fg-secondary">
          {t("正在打包鏡頭、版本與素材；專案越大越久，完成後瀏覽器會開始下載。")}
        </p>
      ) : null}
      {download.isSuccess ? (
        <p role="status" className="text-caption text-success">
          {t("已打包完成，檔案交給瀏覽器下載。")}
        </p>
      ) : null}
      <p className="text-caption text-fg-tertiary">{t("在另一個工作站：到專案列表按「匯入可攜包」，它會成為一個新專案。")}</p>
      {download.error ? <DownloadError project={project} error={download.error} /> : null}
    </section>
  );
}
