// 參考分頁的「無看鏡頭版面參考」開關（選用，預設關閉）：開啟時把片段庫裡最接近鏡頭描述的片段加成影片參考，並在 prompt
// 加一行版面說明；可以換片段；有成功的 take 時可以做照抄檢查（同時間點比對 take 與參考）。開關的狀態就是鏡頭的參考與 prompt
// （./plan），沒有另存的設定。片段庫沒有片段在這個專案的素材庫裡時，開關停用並說明原因。
import { ScanSearch } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { StudioLibraryItem, StudioReference, StudioShot } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import { ActionButton } from "@/components/common/ActionButton";
import { Select, Switch } from "@/components/ui/controls";
import { CARD } from "@/components/ui/look";
import { pluginText } from "@/features/plugins";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { takeUrl } from "../../components/monitor/media";
import { activeTake } from "../../model/project";
import { addBlockedReason } from "../materials";
import { newLocalId } from "../ids";
import type { CopyResult, CopyVerdict } from "./copyCheck";
import { checkCopy } from "./frames";
import { layoutCandidates, type LayoutCandidate } from "./library";
import { activeLayout, rankCandidates, switchClip, turnOff, turnOn } from "./plan";

export interface LayoutReferenceProps {
  shot: StudioShot;
  prompt: string;
  references: readonly StudioReference[];
  library: readonly StudioLibraryItem[];
  onChange: (next: { prompt: string; references: StudioReference[] }) => void;
  /** 非 null＝不能編輯（原因）。 */
  disabledReason: string | null;
}

const VERDICT_TEXT: Record<CopyVerdict, string> = {
  copied: t("可能照抄了參考的構圖：換一個 seed 或換一段參考再渲染"),
  close: t("構圖很接近參考：看一下是不是只有站位相同"),
  loose: t("只跟了大致的站位，沒有照抄"),
};
const VERDICT_TONE: Record<CopyVerdict, string> = { copied: "text-warning", close: "text-fg-secondary", loose: "text-success" };

function clipName(candidate: LayoutCandidate): string {
  return pluginText(candidate.clip.title, candidate.item.name);
}

export function LayoutReference({ shot, prompt, references, library, onChange, disabledReason }: LayoutReferenceProps) {
  const id = useId();
  const candidates = useMemo(() => layoutCandidates(library), [library]);
  const active = useMemo(() => activeLayout(prompt, references, library, candidates), [prompt, references, library, candidates]);
  const { ranked, suggested } = useMemo(() => rankCandidates(prompt, candidates), [prompt, candidates]);
  const take = activeTake(shot);
  const takeSource = takeUrl(take);

  const unavailable =
    disabledReason ??
    (candidates.length === 0
      ? t("專案素材庫裡還沒有內建的版面參考片段")
      : active
        ? null
        : addBlockedReason("video", references));

  const toggle = (on: boolean) => {
    if (on) {
      const first = suggested ?? ranked[0];
      const next = first ? turnOn(prompt, references, first, newLocalId("ref")) : null;
      if (next) onChange(next);
    } else if (active) {
      onChange(turnOff(prompt, references, active.reference));
    }
  };

  // 照抄檢查：take 或參考換了就清掉舊結果；離開時取消進行中的檢查
  const [check, setCheck] = useState<{ key: string; result: CopyResult | null; error: string | null } | null>(null);
  const [pending, setPending] = useState(false);
  const runningRef = useRef<AbortController | null>(null);
  useEffect(() => () => { runningRef.current?.abort(); }, []);
  const checkKey = active && take ? `${take.take_id}:${active.reference.item_id}:${String(active.reference.start_seconds ?? 0)}:${String(active.reference.end_seconds ?? "")}` : "";
  const shown = check?.key === checkKey ? check : null;

  const runCheck = async () => {
    if (!active || takeSource === null || runningRef.current) return;
    const controller = new AbortController();
    runningRef.current = controller;
    setPending(true);
    const file = active.candidate.item.file;
    const start = active.reference.start_seconds ?? 0;
    const span = (active.reference.end_seconds ?? active.candidate.clip.spanSeconds) - start;
    try {
      const result = await checkCopy(takeSource, mediaUrl(file.node_id, file.file_id), start, span, controller.signal);
      if (!controller.signal.aborted) setCheck({ key: checkKey, result, error: result ? null : t("take 太短，無法比對") });
    } catch (cause) {
      if (!controller.signal.aborted) setCheck({ key: checkKey, result: null, error: errorText(cause) });
    } finally {
      runningRef.current = null;
      setPending(false);
    }
  };

  const description = active
    ? t("參考 @{alias} 的前 {seconds} 秒：只跟分鏡順序、構圖與站位", { alias: active.reference.alias, seconds: ((active.reference.end_seconds ?? 0) - (active.reference.start_seconds ?? 0)).toFixed(1) })
    : (unavailable ?? t("選用：給一段沒有人看鏡頭的短片當版面參考，壓住角色看鏡頭；成品的構圖會跟著它走"));
  const numbers = shown?.result ? shown.result.pairs.map((pair) => t("{seconds} 秒：輪廓 {edge}、結構 {ssim}", { seconds: pair.seconds.toFixed(1), edge: pair.edge.toFixed(2), ssim: pair.ssim.toFixed(2) })).join("\n") : undefined;

  return (
    <section aria-labelledby={`${id}-switch`} className={cn(CARD, "grid gap-2 px-2.5 py-1")}>
      <Switch
        id={`${id}-switch`}
        label={t("無看鏡頭版面參考")}
        description={description}
        checked={active !== null}
        disabled={unavailable !== null && active === null}
        title={t("加了沒有人看鏡頭的版面參考，角色比較不會正面看鏡頭，代價是構圖跟著參考走。片段庫只收每格檢查過、沒有人看鏡頭、沒有私人或受版權保護角色的自製站位片段。")}
        onChange={(event) => { toggle(event.target.checked); }}
      />
      {active ? (
        <div className="flex flex-wrap items-end gap-2 pb-2">
          <label className="grid min-w-48 flex-1 gap-1 text-caption text-fg-secondary">
            {t("版面片段")}
            <Select
              compact
              value={active.candidate.clip.id}
              disabled={disabledReason !== null}
              onChange={(event) => {
                const chosen = candidates.find((entry) => entry.clip.id === event.target.value);
                if (chosen) onChange({ prompt, references: switchClip(references, active.reference, chosen) });
              }}
            >
              {ranked.map((candidate) => (
                <option key={candidate.clip.id} value={candidate.clip.id}>
                  {candidate === suggested ? t("{name}（建議）", { name: clipName(candidate) }) : clipName(candidate)}
                </option>
              ))}
            </Select>
          </label>
          <ActionButton
            size="sm"
            variant="secondary"
            icon={<ScanSearch aria-hidden />}
            aria-busy={pending}
            disabledReason={takeSource === null ? t("這個鏡頭還沒有成功的 take") : pending ? t("正在比對") : null}
            onClick={() => { void runCheck(); }}
          >
            {t("照抄檢查")}
          </ActionButton>
          {shown ? (
            <p role="status" title={numbers} className={cn("basis-full text-caption", shown.result ? VERDICT_TONE[shown.result.verdict] : "text-danger")}>
              {shown.result ? VERDICT_TEXT[shown.result.verdict] : shown.error}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
