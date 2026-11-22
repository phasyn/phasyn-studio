// The 修正 menu of a library video (asset library details): the same task-based tools as a take, with the video file as
// the input. Results join the library next to the item (FixRunWatcher), packages and subtitles download in the dialog.
// Tools that need a shot (局部重製, 草稿精修, 比較 and the ones taking a recorded take) stay listed with their reason.
// Picking a tool closes the asset library and opens the tool's dialog at the page level (LibraryFixHost, mounted once by
// the EditorProvider), so there is only ever one dialog; closing it opens the library again on the same item.
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import type { StudioLibraryItem } from "@/api/generated/contracts";
import { usePipelines } from "@/api/pipelines";
import type { WirePipeline } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { closeAssetLibrary, openAssetLibrary } from "../components/library/libraryOpen";
import { RetakeMaskEditor } from "../editor/timeline/RetakeMaskEditor";
import { useStudio } from "../studioContext";
import { requestLibraryFix, useLibraryFixRequest } from "./fixStore";
import { FixMenu } from "./FixMenu";
import { FixRunDialog } from "./FixRunDialog";
import { FixRunWatcher } from "./FixRunWatcher";
import { FIX_ICON, FIX_TOOLS, fixTool, noteMatches, sourceValue, type FixSource, type FixTool, type PipelineTool } from "./tools";
import { useFixRuns } from "./useFixRuns";

function pipelineFor(tool: PipelineTool, pipelines: readonly WirePipeline[]): WirePipeline | null {
  for (const id of tool.pipelines) {
    const found = pipelines.find((item) => item.pipeline_id === id);
    if (found) return found;
  }
  return null;
}

export function LibraryFixButton({ item }: { item: StudioLibraryItem }) {
  const { project } = useStudio();
  const pipelines = usePipelines();
  const fixRuns = useFixRuns(project.project_id);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  if (item.kind !== "video") return null;
  const source: FixSource = { kind: "library", item };
  const items = pipelines.data?.items ?? [];
  const reasons: Record<string, string | null> = {};
  const pipelineIds: Record<string, string | undefined> = {};
  for (const tool of FIX_TOOLS) {
    if (tool.kind === "flow") {
      reasons[tool.id] = tool.flow === "mask" ? null : t("只能用在鏡頭的 take");
      continue;
    }
    const pipeline = pipelineFor(tool, items);
    pipelineIds[tool.id] = pipeline?.pipeline_id ?? tool.pipelines[0];
    const port = pipeline?.inputs.find((input) => input.name === tool.input);
    const running = fixRuns.runs.some((entry) => entry.tool.id === tool.id && noteMatches(entry.note, source) && entry.run.state === "running");
    reasons[tool.id] = pipelines.isPending ? t("正在讀取流程…")
      : !pipeline ? t("這台 Studio 還沒有這個流程")
      : tool.pairInput !== undefined || (port && !sourceValue(source, port.type_id)) ? t("只能用在鏡頭的 take")
      : tool.id === "art-return" && !fixRuns.runs.some((entry) => entry.tool.id === "art-export" && noteMatches(entry.note, source) && entry.run.state === "succeeded") ? t("請先用「在 Krita 修稿」匯出這個素材的工作包")
      : running ? t("這個素材正在執行這項修正")
      : null;
  }
  const pick = (tool: FixTool) => {
    closeAssetLibrary();
    requestLibraryFix({ itemId: item.item_id, toolId: tool.id });
  };
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        icon={<FIX_ICON aria-hidden />}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        title={t("用修正工具處理這段影片：畫質修復、補幀、超分、遮罩…")}
        onClick={(event) => { setAnchor(anchor ? null : event.currentTarget); }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          event.stopPropagation();
          setAnchor(event.currentTarget);
        }}
      >
        {t("修正")}
        <ChevronDown aria-hidden className={anchor ? "rotate-180 transition-[rotate]" : "transition-[rotate]"} />
      </Button>
      {anchor ? (
        <FixMenu
          label={t("修正「{name}」", { name: item.name })}
          anchor={{ kind: "element", element: anchor }}
          reasons={reasons}
          pipelineIds={pipelineIds}
          returnFocus={anchor}
          onPick={pick}
          onClose={() => { setAnchor(null); }}
        />
      ) : null}
    </>
  );
}

/** The dialog of the tool picked in a library item's 修正 menu, and the page's fix-run watcher. */
export function LibraryFixHost() {
  const { project, notify } = useStudio();
  const pipelines = usePipelines();
  const request = useLibraryFixRequest();
  const item = request ? (project.library ?? []).find((entry) => entry.item_id === request.itemId) ?? null : null;
  const tool = request ? fixTool(request.toolId) : null;
  const pipeline = tool?.kind === "pipeline" ? pipelineFor(tool, pipelines.data?.items ?? []) : null;
  const close = () => {
    const itemId = request?.itemId ?? null;
    requestLibraryFix(null);
    openAssetLibrary(itemId);
  };
  return (
    <>
      <FixRunWatcher />
      <FixRunDialog target={item && tool?.kind === "pipeline" && pipeline ? { tool, pipeline, source: { kind: "library", item } } : null} onClose={close} />
      <Dialog open={item !== null && tool?.kind === "flow" && tool.flow === "mask"} onOpenChange={(open) => { if (!open) close(); }}>
        <DialogContent wide onKeyDown={(event) => { event.stopPropagation(); }}>
          <DialogHeader>
            <DialogTitle>{t("遮罩")}</DialogTitle>
            <DialogDescription>{t("在畫面上點選要保留或排除的人物、物件，產生逐幀遮罩；採用後加入素材庫，可在局部重製中使用。")}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {item ? <RetakeMaskEditor key={item.item_id} source={item.file} onAdopt={() => {
              notify({ tone: "success", title: t("遮罩已加入素材庫"), detail: t("在局部重製中選這個遮罩即可使用。") });
              close();
            }} /> : null}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
