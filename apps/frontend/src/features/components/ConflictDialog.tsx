import type { InstanceSettings, SettingsView } from "@/api/generated/contracts";
import { DiffTable } from "@/components/common/DiffTable";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { diffDocuments, type DiffEntry } from "@/lib/diff";
import { valuesEqual } from "@/lib/json";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

export interface ConflictState {
  base: SettingsView;
  latest: SettingsView;
  mine: InstanceSettings;
}

function conflicts(server: DiffEntry[], mine: DiffEntry[]): DiffEntry[] {
  const byPath = new Map(server.map((entry) => [entry.path, entry]));
  return mine
    .filter((entry) => {
      const other = byPath.get(entry.path);
      return other !== undefined && !valuesEqual(other.after, entry.after);
    })
    .map((entry) => ({ path: entry.path, kind: "changed" as const, before: byPath.get(entry.path)?.after, after: entry.after }));
}

/** 409 REVISION_CONFLICT：保留草稿，列出伺服器與我的變更，由使用者決定重新套用或載入最新版。 */
export function ConflictDialog({
  state,
  onRebase,
  onDiscard,
  onClose,
}: {
  state: ConflictState | null;
  onRebase: () => void;
  onDiscard: () => void;
  onClose: () => void;
}) {
  const serverChanges = state ? diffDocuments(state.base.stored, state.latest.stored) : [];
  const myChanges = state ? diffDocuments(state.base.stored, state.mine) : [];
  const both = conflicts(serverChanges, myChanges);
  return (
    <Dialog open={state !== null} onOpenChange={(open) => { if (!(open)) { onClose(); } }}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{t("設定已被更新（REVISION_CONFLICT）")}</DialogTitle>
          <DialogDescription>
            <T source={"你的草稿基於 revision #{stored_revision}，伺服器目前是 #{stored_revision2}。草稿仍保留，請檢視差異後選擇。"} values={{ stored_revision: state?.base.stored_revision, stored_revision2: state?.latest.stored_revision }} />
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-4">
          {both.length > 0 ? (
            <Callout tone="warning" title={t("{bothCount} 個欄位兩邊都改了", { bothCount: both.length })}>
              <DiffTable entries={both} beforeLabel={t("伺服器最新值")} afterLabel={t("我的值（重新套用後採用）")} label={t("衝突欄位")} />
            </Callout>
          ) : null}
          <section className="grid gap-2">
            <h3 className="text-data font-semibold text-fg">{t("伺服器端的變更（{serverChangesCount}）", { serverChangesCount: serverChanges.length })}</h3>
            <DiffTable entries={serverChanges} beforeLabel={t("我的基準")} afterLabel={t("伺服器最新")} label={t("伺服器變更")} />
          </section>
          <section className="grid gap-2">
            <h3 className="text-data font-semibold text-fg">{t("我的變更（{myChangesCount}）", { myChangesCount: myChanges.length })}</h3>
            <DiffTable entries={myChanges} beforeLabel={t("基準")} afterLabel={t("我的草稿")} label={t("我的變更")} />
          </section>
        </DialogBody>
        <DialogFooter>
          <Button variant="quiet" onClick={onClose}>
            {t("取消（保留草稿）")}
          </Button>
          <Button variant="danger" onClick={onDiscard}>
            {t("捨棄草稿，載入最新版")}
          </Button>
          <Button variant="primary" onClick={onRebase}>
            {t("以最新版為基礎重新套用我的修改")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
