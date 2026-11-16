// Generation-tab memory reminder: shown when a ref2va shot with a reference video goes beyond the swap limit its route's
// DiT declares (limits.swap) in length, reference image count or preprocessed area. A reminder only: it never blocks
// rendering and never guesses whether something fits; without a declaration it says so.
import { MemoryStick } from "lucide-react";
import type { StudioShot } from "@/api/generated/contracts";
import { findRoute } from "../model/routes";
import { useStudio } from "../studioContext";
import { NoteList } from "./fields";
import { refVideoMemoryWarnings } from "./limits";
import { t } from "@/i18n";

export function RefMemoryNote({ shot }: { shot: StudioShot }) {
  const { project, engine } = useStudio();
  const warnings = refVideoMemoryWarnings(shot, project.library ?? [], findRoute(engine.routes, shot.route));
  return <NoteList tone="warning" title={t("顯存提醒（不擋渲染）")} icon={<MemoryStick aria-hidden />} items={warnings} />;
}
