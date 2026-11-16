// What starting an instance of `group` will meet on its Node right now, from the catalog snapshot (the Node decides when
// the start arrives). Shown while creating or duplicating an instance; the start itself confirms before replacing.
import type { NodeSnapshot } from "@/api/generated/contracts";
import { Callout } from "@/components/ui/callout";
import { exclusiveBlockReason, exclusiveConflict, exclusiveReplaceNote } from "./control/exclusive";
import { t } from "@/i18n";

export function ExclusiveGroupNote({
  nodeId,
  componentId,
  group,
  snapshot,
}: {
  nodeId: string;
  componentId: string;
  group: string | null;
  snapshot: NodeSnapshot | null;
}) {
  const conflict = exclusiveConflict({ node_id: nodeId, component_id: componentId, exclusive_group: group }, { nodes: snapshot ? [snapshot] : [] });
  if (!conflict) return null;
  const blocked = exclusiveBlockReason(conflict);
  return (
    <Callout tone="info" title={t("互斥群組 {group} 目前有其他元件佔用", { group: conflict.group })}>
      <p>{exclusiveReplaceNote(conflict)}</p>
      {blocked ? <p>{blocked}</p> : null}
    </Callout>
  );
}
