import { pageTransition } from "@/lib/dom";
import { Link } from "react-router";
import { EmptyState } from "@/components/common/EmptyState";
import { PageBody, PageHeader } from "@/components/common/PageHeader";
import { buttonVariants } from "@/components/ui/variants";
import { PATHS } from "./paths";
import { t } from "@/i18n";

export function NotFoundPage() {
  return (
    <PageBody>
      <PageHeader title={t("找不到這個頁面")} />
      <EmptyState
        scene
        mark
        title={t("網址不在 Phasyn Studio 的路由中")}
        description={t("請從左側導覽選擇工作區。")}
        action={
          <>
            <Link to={PATHS.studio} {...pageTransition()} className={buttonVariants({ variant: "primary" })}>
              {t("前往 Video Studio")}
            </Link>
            <Link to={PATHS.components} {...pageTransition()} className={buttonVariants({ variant: "secondary" })}>
              {t("回到元件頁")}
            </Link>
          </>
        }
      />
    </PageBody>
  );
}
