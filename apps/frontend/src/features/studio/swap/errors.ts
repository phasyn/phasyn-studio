// Error line of Video Studio's runs and writes: the shared errorText, pointing to where to check when a write's remote
// outcome is unknown (nothing is resent automatically; the user decides after checking).
import { errorText as sharedErrorText } from "@/lib/errors";
import { t } from "@/i18n";

export const REMOTE_UNKNOWN = t("遠端結果未知：先到「渲染」或「紀錄・執行紀錄」確認，不要直接重送");

export function errorText(error: unknown): string {
  return sharedErrorText(error, { remoteUnknown: REMOTE_UNKNOWN });
}
