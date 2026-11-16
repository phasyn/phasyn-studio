// Responsible-use note of the swap wizard (MiniMax H3 acceptable use policy).
import { ShieldCheck } from "lucide-react";
import { NoteList } from "../fields";
import { t } from "@/i18n";

/** Responsible use (MiniMax H3 acceptable use policy): shown on the first step, before any material is chosen. */
export function ResponsibleUseNote() {
  return (
    <NoteList
      tone="warning"
      icon={<ShieldCheck aria-hidden />}
      title={t("負責任使用")}
      items={[
        t("只使用你擁有或已取得授權的影片與角色圖。"),
        t("不要在未經同意下冒用真人的身分或肖像，也不要用換角結果誤導他人；MiniMax H3 的可接受使用政策（AUP）禁止這類用途。"),
      ]}
    />
  );
}
