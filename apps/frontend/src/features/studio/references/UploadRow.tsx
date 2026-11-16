// One reference upload in the Bin or a shot's reference panel: the shell's upload row with the media kind's icon.
import { UploadTaskRow, type UploadTask } from "@/features/studio-shell";
import { KindIcon } from "./KindIcon";
import type { ReferenceUploadInfo } from "./useReferenceUploads";

export function ReferenceUploadRow({ task, onRetry, onDismiss }: { task: UploadTask<ReferenceUploadInfo>; onRetry: () => void; onDismiss: () => void }) {
  return <UploadTaskRow task={task} icon={task.info.kind ? <KindIcon kind={task.info.kind} className="mt-0.5 size-3.5" /> : null} onRetry={onRetry} onDismiss={onDismiss} />;
}
