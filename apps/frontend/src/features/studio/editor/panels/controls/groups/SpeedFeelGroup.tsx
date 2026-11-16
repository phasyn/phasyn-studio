// The Speed feel group of Effect Controls, for a clip that plays a shot's take with a @Video1 reference: what its two
// tools do, the last analysis of each for this clip when there is one, and the buttons that open the speed-feel dialog
// on either tool (the analyses and the edits live there): 分析 (shake and impact frames where the take misses the
// original's accents) and 對齊切點 (the take's cuts moved onto the original's).
import { Magnet, Zap } from "lucide-react";
import type { TimelineClip } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { conformSummary, type ConformTone } from "../../../../speedfeel/conformView";
import { useConformResults } from "../../../../speedfeel/conformReader";
import { requestSpeedFeelTool, type SpeedFeelTool } from "../../../../speedfeel/mode";
import { useSpeedFeelResults } from "../../../../speedfeel/reader";
import { speedFeelTarget } from "../../../../speedfeel/target";
import { verdictView } from "../../../../speedfeel/view";
import { formatTimecode } from "../../../../model/frames";
import { useEditor } from "../../../editorContext";
import { Group } from "../Group";
import { ActionRow, TextButton } from "../rows";

const TONE_TEXT: Record<ConformTone, string> = { info: "text-info", success: "text-success", warning: "text-warning" };

export function SpeedFeelGroup({ clip }: { clip: TimelineClip }) {
  const editor = useEditor();
  const results = useSpeedFeelResults();
  const conformResults = useConformResults();
  const target = speedFeelTarget(editor.project, editor.timeline, clip.clip_id);
  const status = target.ok ? results.get(target.key) : undefined;
  const conformStatus = target.ok ? conformResults.get(target.key) : undefined;
  const at = (frame: number) => formatTimecode(clip.start_frame + frame, editor.fps);
  const last = status?.status === "done" ? verdictView(status.analysis, at) : null;
  const lastConform = conformStatus?.status === "done" ? conformSummary(conformStatus.analysis) : null;
  const open = (tool: SpeedFeelTool) => {
    requestSpeedFeelTool(clip.clip_id, tool);
    editor.ui.setSpeedFeelClip(clip.clip_id);
  };
  return (
    <Group
      id="speedfeel"
      title={t("速度感")}
      actions={
        <>
          <TextButton icon={<Zap aria-hidden />} title={t("比對原片的動作重音，在生成沒打到的地方加上震動與負片衝擊格")} onClick={() => open("effects")}>
            {t("分析…")}
          </TextButton>
          <TextButton icon={<Magnet aria-hidden />} title={t("找出原片和生成的切點，把生成的切點移到原片切點的同一格（停格或加快，片段總長不變）")} onClick={() => open("conform")}>
            {t("對齊切點…")}
          </TextButton>
        </>
      }
    >
      <ActionRow>
        <span className="grid min-w-0 flex-1 gap-0.5 py-1 text-caption">
          {last ? (
            <span className={cn("font-medium", TONE_TEXT[last.tone])}>{t("上次分析：{verdict}", { verdict: last.label })}</span>
          ) : status?.status === "running" ? (
            <span className="text-info">{t("分析中…")}</span>
          ) : null}
          {lastConform ? (
            <span className={cn("font-medium", TONE_TEXT[lastConform.tone])}>{t("上次比對切點：{verdict}", { verdict: lastConform.label })}</span>
          ) : conformStatus?.status === "running" ? (
            <span className="text-info">{t("比對切點中…")}</span>
          ) : null}
          <span className="text-fg-tertiary">{target.ok ? t("逐格比對這個片段和原片（@Video1 參考影片），找出生成沒打到的動作重音，一鍵加上震動與負片衝擊格；不需要時會直接說明。") : target.reason}</span>
          {target.ok ? <span className="text-fg-tertiary">{t("「對齊切點」把生成的切點移到原片的切點上：在動作最少的地方停格或加快，片段總長和聲音同步都不變。")}</span> : null}
        </span>
      </ActionRow>
    </Group>
  );
}
