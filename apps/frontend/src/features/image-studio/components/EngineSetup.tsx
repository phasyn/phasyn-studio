// 用範本建立生圖引擎：這台主控還沒有可以生圖（或這個模式）的元件組合時，依圖片的模式用內建的文生圖或圖生圖範本
// （元件組合頁同一套範本與接線），列出範本需要的每一種元件、這台主控上可以用的元件（不只一個時可以換）與它們現在的狀態；
// 按一次「建立生圖引擎」就保存成元件組合（只保存：不載入元件、不生成），並讓這張圖片改用它，焦點回到它的運算路由。
// 建立前先確認接好的元件組合 Image Studio 能用；寫入只送一次，失敗時對話框留著並說明原因（結果可能未知時重新讀取清單，
// 不重送）。畫面上只寫角色名稱（文字條件、DiT 去噪…），不寫元件類型的 id。
import { useQueryClient } from "@tanstack/react-query";
import { Cpu, LayoutTemplate, LoaderCircle, TriangleAlert } from "lucide-react";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Link } from "react-router";
import { useProviderIndex } from "@/api/catalog";
import { qk } from "@/api/keys";
import { usePipelines, useSavePipeline } from "@/api/pipelines";
import type { WirePipeline } from "@/api/types";
import { ActionButton } from "@/components/common/ActionButton";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Select } from "@/components/ui/controls";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CARD, ICON_TILE } from "@/components/ui/look";
import { reveal } from "@/components/ui/motion";
import { componentOptions, type ComponentOption } from "@/features/pipelines";
import { cn } from "@/lib/cn";
import { useImageStudio } from "../imageStudioContext";
import { MODE_LABELS } from "../model/constants";
import { NO_IMAGE_ENGINE } from "../model/engine";
import { engineTemplate, optionUsable, planEngine, slotChoices, slotRoleName, type EnginePlan, type SlotChoice } from "../model/engineTemplate";
import type { ImageMode } from "../types";
import { t } from "@/i18n";

function optionName(option: ComponentOption): string {
  return t("{component_id}・{nodeLabel}", { component_id: option.descriptor.label || option.descriptor.component_id, nodeLabel: option.node.label });
}

function SlotRow({ row, index, loading, onChoose }: { row: SlotChoice; index: number; loading: boolean; onChoose: (value: string) => void }) {
  const labelId = useId();
  const { candidates, chosen } = row;
  return (
    <li ref={reveal(index)} className={cn(CARD, "grid min-h-11 grid-cols-[6rem_minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-1.5")}>
      <span id={labelId} className="truncate text-data text-fg-secondary">
        {slotRoleName(row.slot)}
      </span>
      {loading ? (
        <span role="status" className="flex items-center gap-1.5 text-caption text-fg-tertiary">
          <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
          {t("讀取主控上的元件…")}
        </span>
      ) : chosen && candidates.length > 1 ? (
        <Select compact aria-labelledby={labelId} value={chosen.value} title={optionName(chosen)} onChange={(event) => onChoose(event.target.value)}>
          {candidates.map((option) => (
            <option key={option.value} value={option.value}>
              {optionName(option)}
            </option>
          ))}
        </Select>
      ) : chosen ? (
        <span className="min-w-0 truncate text-data text-fg" title={optionName(chosen)}>
          {optionName(chosen)}
        </span>
      ) : (
        <span className="text-caption text-warning">{t("這台主控沒有這種元件")}</span>
      )}
      {chosen && !loading ? <StatusBadge kind={chosen.node.stale ? "directory" : "component"} value={chosen.node.stale ? "offline" : chosen.descriptor.state} /> : <span />}
    </li>
  );
}

interface SaveState {
  pending: boolean;
  error: unknown;
}

function EngineSetupForm({ mode, save, onCancel, onCreate }: { mode: ImageMode; save: SaveState; onCancel: () => void; onCreate: (pipeline: WirePipeline, notReady: number) => void }) {
  const { catalog } = useImageStudio();
  const pipelines = usePipelines();
  const providers = useProviderIndex((catalog?.nodes ?? []).map((node) => node.node_id));
  const [choices, setChoices] = useState<Record<string, string>>({});
  const spec = engineTemplate(mode);
  const rows = slotChoices(spec, componentOptions(catalog, providers), choices);
  const taken = new Set((pipelines.data?.items ?? []).map((item) => item.pipeline_id));
  const plan: EnginePlan = providers.loading ? { pipeline: null, problem: t("讀取主控上的元件…"), details: [] } : planEngine(spec, rows, taken, catalog, mode);
  const notReady = rows.filter((row) => row.chosen && !optionUsable(row.chosen)).length;

  return (
    <>
      <DialogBody className="grid content-start gap-3">
        <ol aria-label={t("範本需要的元件")} className="grid gap-1.5">
          {rows.map((row, index) => (
            <SlotRow key={row.slot.id} row={row} index={index} loading={providers.loading} onChoose={(value) => setChoices((current) => ({ ...current, [row.slot.id]: value }))} />
          ))}
        </ol>
        {providers.failedNodes.size > 0 ? (
          <p className="flex items-start gap-1.5 text-caption text-warning">
            <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            {t("{count} 個 Node 讀不到元件類型（可能離線），它們的元件沒有列出。", { count: providers.failedNodes.size })}
          </p>
        ) : null}
        {notReady > 0 && !plan.problem ? <p className="text-caption text-fg-secondary">{t("{count} 個元件還沒就緒：建立後在「生成引擎」啟動它們，就能生成。", { count: notReady })}</p> : null}
        {plan.problem && !providers.loading ? (
          <Callout tone="warning" title={plan.problem}>
            {plan.details.length > 0 ? <p className="text-caption text-fg-tertiary [overflow-wrap:anywhere]">{plan.details.join(t("；"))}</p> : null}
            <Link to="/admin/pipelines" className="inline-flex text-caption">
              {t("到「元件修改・元件組合」建立")}
            </Link>
          </Callout>
        ) : null}
        {save.error ? <ErrorCallout error={save.error} write title={t("沒有建立生圖引擎")} /> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="quiet" onClick={onCancel}>
          {t("取消")}
        </Button>
        <ActionButton variant="primary" icon={<LayoutTemplate aria-hidden />} pending={save.pending} disabledReason={plan.problem} onClick={() => (plan.pipeline ? onCreate(plan.pipeline, notReady) : undefined)}>
          {t("建立生圖引擎")}
        </ActionButton>
      </DialogFooter>
    </>
  );
}

/**
 * 建立生圖引擎的對話框。保存在這裡送出（它跟著運算路由一直掛著）：送出後關掉對話框，結果仍會套用到這張圖片並通知。
 * focusAfterCreate：建立之後焦點要去的地方（這張圖片的運算路由；打開對話框的按鈕已經跟著「還沒有引擎」的狀態一起消失）。
 * 取消時焦點照常回到打開它的按鈕。
 */
export function EngineSetupDialog({
  open,
  onOpenChange,
  mode,
  shotId,
  focusAfterCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: ImageMode;
  shotId: string;
  focusAfterCreate: RefObject<HTMLElement | null>;
}) {
  const { dispatch, notify } = useImageStudio();
  const save = useSavePipeline();
  const { reset } = save;
  const client = useQueryClient();
  // 第一次打開後一直掛著：關閉的動畫期間內容不會先消失
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  // 重新打開時不再顯示上一次的失敗
  useEffect(() => {
    if (open) reset();
  }, [open, reset]);
  const created = useRef(false);
  const create = (pipeline: WirePipeline, notReady: number) => {
    if (save.isPending) return;
    save.mutate(pipeline, {
      onSuccess: (saved) => {
        created.current = true;
        dispatch({ type: "updateImageShot", shotId, patch: { route: saved.pipeline_id } });
        notify({
          tone: "success",
          title: t("已建立生圖引擎「{label}」", { label: saved.label || saved.pipeline_id }),
          detail: notReady > 0 ? t("{count} 個元件還沒就緒：在「生成引擎」啟動它們，就能生成。", { count: notReady }) : undefined,
          link: notReady > 0 ? { label: t("開啟生成引擎"), to: "#engine" } : undefined,
        });
        onOpenChange(false);
      },
      // 結果可能未知（逾時、連線中斷）：重新讀取清單，已經建立的話它會出現在運算路由裡；不重送
      onError: () => void client.invalidateQueries({ queryKey: qk.pipelines() }),
    });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl"
        onCloseAutoFocus={(event) => {
          if (!created.current) return;
          created.current = false;
          const target = focusAfterCreate.current;
          if (!target?.isConnected) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("用範本建立生圖引擎")}</DialogTitle>
          <DialogDescription>{t("把這台主控上的元件接成一個{mode}的元件組合，給這張圖片使用。只保存元件組合，不會啟動元件或生成。", { mode: MODE_LABELS[mode] })}</DialogDescription>
        </DialogHeader>
        {mounted ? <EngineSetupForm mode={mode} save={{ pending: save.isPending, error: save.error }} onCancel={() => onOpenChange(false)} onCreate={create} /> : null}
      </DialogContent>
    </Dialog>
  );
}

/** 「基本」分頁在沒有任何圖片元件組合時的狀態：一句話與一個動作。 */
export function EngineSetupCard({ onOpen }: { onOpen: () => void }) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className={cn(CARD, "grid gap-2.5 p-3 animate-rise-in")}>
      <h3 id={titleId} className="flex items-center gap-2 text-body font-semibold text-fg">
        <span aria-hidden className={cn(ICON_TILE, "size-7 text-brand-cyan [&_svg]:size-4")}>
          <Cpu />
        </span>
        {NO_IMAGE_ENGINE}
      </h3>
      <Button size="sm" variant="primary" icon={<LayoutTemplate aria-hidden />} onClick={onOpen} className="justify-self-start">
        {t("用範本建立生圖引擎")}
      </Button>
    </section>
  );
}

/** 有圖片元件組合、但沒有這個模式的：運算路由下面的一行與建立的入口。 */
export function EngineMissingForMode({ mode, onOpen }: { mode: ImageMode; onOpen: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-warning">
      <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
      <span>{mode === "i2i" ? t("還沒有可以圖生圖的引擎") : t("還沒有可以文生圖的引擎")}</span>
      <Button size="sm" variant="secondary" className="min-h-7 px-2" icon={<LayoutTemplate aria-hidden />} onClick={onOpen}>
        {t("用範本建立")}
      </Button>
    </div>
  );
}
