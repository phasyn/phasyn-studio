// 「基本」分頁的運算路由（＝含 Qwen-Image DiT 的元件組合）：一個下拉選單，每個圖片元件組合一個選項；用途與圖片模式不符、
// 或還沒就緒時在選項上註明。目前的值不是任何元件組合時明確顯示（欄位標成錯誤），不默默選第一個。下面只留與狀態有關的
// 提醒（模式不符、未就緒、顯存）；路由的特徵（精度、放置、LoRA）在下拉的提示與「生成引擎」裡。這台主控還沒有可以生圖
// （或這個模式）的元件組合時，這裡是用範本建立生圖引擎的入口（EngineSetup）；讀取中或讀取失敗時說明。
import { CircleAlert, LoaderCircle, TriangleAlert } from "lucide-react";
import { useId, useRef, useState, type RefObject } from "react";
import { Select } from "@/components/ui/controls";
import { UNASSIGNED_ROUTE } from "@/features/studio";
import { useImageStudio, type ImageEngine } from "../imageStudioContext";
import { MODE_LABELS } from "../model/constants";
import { NO_IMAGE_ENGINE } from "../model/engine";
import { findImageRoute, modeMismatch, routeFacts, routeModeNotes, type ImageRoute } from "../model/routes";
import type { ImageMode, StudioImageShot } from "../types";
import { EngineMissingForMode, EngineSetupCard, EngineSetupDialog } from "./EngineSetup";
import { Hint } from "./fields";
import { ReadyDot } from "./marks";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

/** 元件組合讀取中或讀不到時的一行；沒有任何圖片元件組合時（生成引擎側欄）指向「基本」分頁的範本。 */
export function RoutesUnavailable({ engine }: { engine: ImageEngine }) {
  if (engine.status === "loading") {
    return (
      <p role="status" className="flex items-center gap-1.5 text-caption text-fg-tertiary">
        <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
        {t("讀取元件組合…")}
      </p>
    );
  }
  if (engine.status === "error") {
    return (
      <p role="alert" className="flex items-start gap-1.5 text-caption text-danger [overflow-wrap:anywhere]">
        <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        {t("無法讀取元件組合或元件目錄：{value}", { value: engine.error ?? t("未知錯誤") })}
      </p>
    );
  }
  if (engine.routes.length > 0) return null;
  return <p className="text-data text-fg-secondary">{t("{value}：在「基本」分頁用範本建立。", { value: NO_IMAGE_ENGINE })}</p>;
}

/** 下拉選項的文字：名稱；用途與圖片模式不符時註明用途，還沒就緒時註明。 */
function optionText(route: ImageRoute, mode: ImageMode): string {
  const purpose = route.capability === mode ? "" : t("（{mode}用）", { mode: MODE_LABELS[route.capability] });
  return `${route.label}${purpose}${route.ready ? "" : t("・未就緒")}`;
}

/** 下拉的提示：元件組合的特徵（用途、精度、放置、LoRA）與它的注意事項（不常駐在面板上）。 */
function routeTitle(route: ImageRoute): string {
  const adapters = route.adapters.length > 0 ? t("・LoRA：{map}", { map: formatList(route.adapters.map((adapter) => `${adapter.name} ×${adapter.scale}`)) }) : "";
  const lines = [`${t("{id}・{route}", { id: route.id, route: routeFacts(route) })}${adapters}`, ...route.notes];
  if (route.variant === "gguf_q4km") lines.push(t("GGUF 不接受 LoRA／slider 與 Transformer 覆寫"));
  return lines.join("\n");
}

function RouteSelect({ shot, selectRef, onSetup }: { shot: StudioImageShot; selectRef: RefObject<HTMLSelectElement | null>; onSetup: () => void }) {
  const { engine, dispatch } = useImageStudio();
  const id = useId();
  const route = findImageRoute(engine.routes, shot.route);
  const fitting = engine.routes.some((item) => item.capability === shot.mode);
  const mismatch = route && fitting ? modeMismatch(route, shot.mode) : null;
  const missing = shot.route === UNASSIGNED_ROUTE ? t("請選擇運算路由") : t("找不到「{value}」（可能已刪除）", { value: shot.route });
  return (
    <div className="grid min-w-0 gap-1">
      <label htmlFor={id} className="text-caption font-medium text-fg-secondary">
        {t("運算路由")}
      </label>
      <Select
        ref={selectRef}
        id={id}
        compact
        value={route ? route.id : shot.route}
        aria-invalid={route ? undefined : true}
        title={route ? routeTitle(route) : missing}
        onChange={(event) => dispatch({ type: "updateImageShot", shotId: shot.image_shot_id, patch: { route: event.target.value } })}
      >
        {route ? null : (
          <option value={shot.route} disabled>
            {missing}
          </option>
        )}
        {engine.routes.map((item) => (
          <option key={item.id} value={item.id}>
            {optionText(item, shot.mode)}
          </option>
        ))}
      </Select>
      {fitting ? null : <EngineMissingForMode mode={shot.mode} onOpen={onSetup} />}
      {mismatch ? <Hint tone="warning" icon={<TriangleAlert aria-hidden />}>{mismatch}</Hint> : null}
      {route && !route.ready ? (
        <p className="flex min-w-0 items-start gap-1.5 text-caption text-warning [overflow-wrap:anywhere]" title={route.problems.join("\n") || undefined}>
          <ReadyDot ready={false} className="mt-1.5" />
          <span className="min-w-0">{t("未就緒：{summary}", { summary: route.summary })}</span>
        </p>
      ) : null}
      {route && !mismatch
        ? routeModeNotes(route, shot.mode).map((note) => (
            <Hint key={note} tone="warning" icon={<TriangleAlert aria-hidden />}>
              {note}
            </Hint>
          ))
        : null}
    </div>
  );
}

export function RouteField({ shot }: { shot: StudioImageShot }) {
  const { engine } = useImageStudio();
  const select = useRef<HTMLSelectElement>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const openSetup = () => setSetupOpen(true);
  // 對話框一直在同一個位置：建立成功後這裡從「還沒有引擎」換成下拉，對話框仍能播完關閉動畫並把焦點交給下拉
  return (
    <>
      {engine.status !== "ready" ? (
        <RoutesUnavailable engine={engine} />
      ) : engine.routes.length === 0 ? (
        <EngineSetupCard onOpen={openSetup} />
      ) : (
        <RouteSelect shot={shot} selectRef={select} onSetup={openSetup} />
      )}
      <EngineSetupDialog open={setupOpen} onOpenChange={setSetupOpen} mode={shot.mode} shotId={shot.image_shot_id} focusAfterCreate={select} />
    </>
  );
}
