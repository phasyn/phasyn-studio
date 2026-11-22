// 推理 Studio・圖片反推：沒有 ?study= 時是研究清單，有時開啟那個研究（每次開啟都讀主控上的最新文件）。
// 路由在 app/routes.tsx（/inference/prompt-studies，handle { frame: "self" }）；頁面只用目前 pathname 加 search 切換，不依賴實際路徑。
import { ArrowLeft, LoaderCircle, ScanSearch } from "lucide-react";
import { Link, useLocation, useSearchParams } from "react-router";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { buttonVariants } from "@/components/ui/variants";
import { DockBody } from "@/components/workbench/DockPanel";
import { DocTabs } from "@/components/workbench/DocTabs";
import { WorkbenchPage } from "@/components/workbench/WorkbenchPage";
import { SubBrandNav } from "@/components/flow/SubBrandNav";
import { useStudyQuery } from "./api";
import { StudyListView } from "./components/StudyListView";
import { StudyWorkspace } from "./components/StudyWorkspace";
import { t } from "@/i18n";

function StudyLoader({ studyId }: { studyId: string }) {
  const location = useLocation();
  const query = useStudyQuery(studyId);
  if (query.data) return <StudyWorkspace key={studyId} initial={query.data} />;
  const center = (
    <>
      <SubBrandNav current="prompt-studies" />
      <DocTabs label={t("開啟的文件")} tabs={[{ id: "study", label: t("研究"), icon: ScanSearch, to: `${location.pathname}${location.search}`, active: true, closeTo: location.pathname }]} />
      <DockBody className="p-4">
        {query.isError ? (
          <div className="grid max-w-3xl gap-3 animate-rise-in">
            <ErrorCallout error={query.error} title={t("無法開啟研究 {studyId}", { studyId })} onRetry={() => void query.refetch()} retrying={query.isFetching} />
            <Link to={location.pathname} className={buttonVariants({ variant: "secondary", size: "sm" }) + " w-fit"}>
              <ArrowLeft aria-hidden />
              {t("回到研究清單")}
            </Link>
          </div>
        ) : (
          <p role="status" className="flex items-center gap-2 text-body text-fg-secondary">
            <LoaderCircle aria-hidden className="size-4 text-brand-cyan animate-spin" />
            {t("讀取研究…")}
          </p>
        )}
      </DockBody>
    </>
  );
  return <WorkbenchPage storageKey="inference.promptStudies" centerLabel={t("圖片反推工作區")} center={center} />;
}

export function PromptStudiesPage() {
  const [params] = useSearchParams();
  const studyId = params.get("study");
  return (studyId != null && studyId !== "") ? <StudyLoader key={studyId} studyId={studyId} /> : <StudyListView />;
}
