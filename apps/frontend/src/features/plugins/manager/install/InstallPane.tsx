import { isNonzeroNumber } from "@/lib/json";
// 安裝流程在右欄的畫面：驗證中、安裝預覽（主控 dry run 回報的內容：manifest、會取代的版本、多出的權限、不相容的原因，
// 用與已安裝的包相同的四個分頁檢視，確認後才安裝）、安裝失敗（一次說清楚原因與下一步，主控列出的問題逐項顯示）。
import { CircleAlert, FileArchive, FolderOpen, LoaderCircle, PackageCheck, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import type { StudioPluginInstallResult } from "@/api/generated/contracts";
import { ActionButton } from "@/components/common/ActionButton";
import { RemoteUnknownNotice } from "@/components/common/ErrorCallout";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ICON_TILE } from "@/components/ui/look";
import { t, tServer } from "@/i18n";
import { cn } from "@/lib/cn";
import { toErrorInfo, writeOutcomeUnknown } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { installFailure } from "../../model/issues";
import { versionChange } from "../../model/versions";
import { IssueList } from "../../parts/IssueList";
import { useSlideIn } from "../../parts/motion";
import { DetailBody, DetailHeader } from "../detail/DetailBody";
import type { DetailTab } from "../detail/detailTab";
import { useManager } from "../managerContext";
import type { InstallState } from "./useInstallFlow";

function Checking({ fileName }: { fileName: string }) {
  const { install } = useManager();
  return (
    <div role="status" className="grid flex-1 place-items-center p-6">
      <div className="grid animate-rise-in justify-items-center gap-3 text-center">
        <span aria-hidden className={cn(ICON_TILE, "size-12 rounded-2xl [&_svg]:size-6")}>
          <FileArchive />
        </span>
        <p className="flex items-center gap-2 text-section font-semibold text-fg">
          <LoaderCircle aria-hidden className="size-4 animate-spin text-brand-cyan" />
          {t("正在驗證")}
        </p>
        <p title={fileName} className="machine max-w-[32ch] truncate text-data text-fg-secondary">
          {fileName}
        </p>
        <Button variant="secondary" icon={<X aria-hidden />} onClick={install.dismiss}>
          {t("取消")}
        </Button>
      </div>
    </div>
  );
}

interface ConfirmCopy {
  eyebrow: string;
  action: string;
  version: string | null;
}

/** 依會不會取代目前的版本決定說法：安裝、更新、換回舊版或重新安裝。 */
function confirmCopy(result: StudioPluginInstallResult): ConfirmCopy {
  const next = result.detail.plugin.version ?? "";
  if (!result.replaces) return { eyebrow: t("安裝預覽"), action: t("安裝"), version: null };
  const version = t("{from} → {to}", { from: result.replaces.version, to: next });
  switch (versionChange(result.replaces.version, next)) {
    case "upgrade":
      return { eyebrow: t("更新預覽"), action: t("更新"), version };
    case "downgrade":
      return { eyebrow: t("換回舊版的預覽"), action: t("換回這個版本"), version };
    case "same":
      return { eyebrow: t("重新安裝的預覽"), action: t("重新安裝"), version };
    case "unknown":
    default:
      return { eyebrow: t("取代目前版本的預覽"), action: t("取代目前的版本"), version };
  }
}

function Preview({ result, installing }: { result: StudioPluginInstallResult; installing: boolean }) {
  const { install } = useManager();
  const [tab, setTab] = useState<DetailTab>("overview");
  const copy = confirmCopy(result);
  const plugin = result.detail.plugin;
  const added = result.permissions_added;
  return (
    <>
      <DetailHeader
        plugin={plugin}
        eyebrow={copy.eyebrow}
        version={copy.version ?? undefined}
        actions={
          <>
            <ActionButton variant="primary" icon={<PackageCheck aria-hidden />} pending={installing} onClick={install.confirm}>
              {copy.action}
            </ActionButton>
            <ActionButton variant="secondary" disabledReason={installing ? t("安裝請求已經送出") : null} onClick={install.dismiss}>
              {t("取消")}
            </ActionButton>
            {added.length > 0 ? (
              <button type="button" onClick={() => { setTab("permissions"); }} className="pressable ml-auto rounded-md px-2 py-1 text-data font-medium text-warning hover:bg-raised">
                {t("多要求 {count} 項權限", { count: added.length })}
              </button>
            ) : null}
          </>
        }
      />
      <DetailBody plugin={plugin} tab={tab} onTabChange={setTab} detail={result.detail} state={null} preview permissionsAdded={added} />
    </>
  );
}

function Failed({ state }: { state: Extract<InstallState, { phase: "failed" }> }) {
  const { install, pickFile, installBlocked } = useManager();
  const info = toErrorInfo(state.error);
  const message = tServer(info.message);
  const heading = info.headline ?? message;
  const failure = installFailure(state.error);
  const unknown = state.stage === "install" && writeOutcomeUnknown(state.error);
  return (
    <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto p-4" role="alert">
      <div className="flex min-w-0 items-start gap-3">
        <span aria-hidden className={cn(ICON_TILE, "size-10 rounded-lg border-danger/40 text-danger [&_svg]:size-5")}>
          <CircleAlert />
        </span>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="text-caption font-semibold text-danger">{state.stage === "check" ? t("沒有安裝：驗證沒有通過") : t("安裝沒有完成")}</p>
          <h3 title={state.fileName} className="truncate text-section font-semibold text-fg">
            {state.fileName}
          </h3>
          <p className="machine text-caption text-fg-tertiary">{formatBytes(state.size)}</p>
        </div>
      </div>
      <Callout tone="danger" title={heading}>
        {heading !== message ? <p>{message}</p> : null}
        <p className="machine text-caption text-fg-tertiary">
          {info.code}
          {isNonzeroNumber(info.status) ? ` · HTTP ${String(info.status)}` : ""}
        </p>
        {(info.hint != null && info.hint !== "") && failure.issues.length === 0 ? <p className="text-caption">{info.hint}</p> : null}
      </Callout>
      <IssueList issues={failure.issues} truncated={failure.truncated} tone="danger" label={t("這個包的問題")} />
      {unknown ? <RemoteUnknownNotice /> : null}
      <div className="flex flex-wrap items-center gap-2">
        {state.stage === "install" ? (
          <ActionButton variant="secondary" icon={<RefreshCw aria-hidden />} disabledReason={installBlocked} onClick={() => { install.start(new File([state.file], state.fileName)); }}>
            {t("重新驗證這個檔案")}
          </ActionButton>
        ) : null}
        <ActionButton variant="secondary" icon={<FolderOpen aria-hidden />} disabledReason={installBlocked} onClick={pickFile}>
          {t("選擇其他檔案…")}
        </ActionButton>
        <Button variant="quiet" onClick={install.dismiss}>
          {t("關閉")}
        </Button>
      </div>
    </div>
  );
}

export function InstallPane() {
  const { install } = useManager();
  const slideIn = useSlideIn<HTMLDivElement>();
  const state = install.state;
  if (state.phase === "idle" || state.phase === "done") return null;
  return (
    <div ref={slideIn} key={state.phase === "failed" ? "failed" : "flow"} className="flex min-h-0 flex-1 flex-col">
      {state.phase === "checking" ? <Checking fileName={state.fileName} /> : null}
      {state.phase === "preview" || state.phase === "installing" ? <Preview result={state.result} installing={state.phase === "installing"} /> : null}
      {state.phase === "failed" ? <Failed state={state} /> : null}
    </div>
  );
}
