import { Download, ExternalLink } from "lucide-react";
import { useFileOwnerLabel } from "@/api/fileOwner";
import type { FileRef } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import { isFileRef } from "@/api/types";
import { buttonVariants } from "@/components/ui/variants";
import { KeyValueList, type KvItem } from "@/components/ui/kv";
import { cn } from "@/lib/cn";
import { labeledFileName } from "@/lib/download";
import { formatBytes, formatBytesExact } from "@/lib/format";
import { displayText, isRecord } from "@/lib/json";
import { Disclosure } from "./Disclosure";
import { JsonView } from "./JsonView";
import { IdText } from "./values";
import { t } from "@/i18n";

const SUMMARY_KEYS = ["latent_id", "latent_space_id", "shape", "dtype", "layout", "frames", "fps", "width", "height", "duration_seconds", "synthetic", "purpose"];

export function FileLinks({ file, downloadLabel, className }: { file: FileRef; downloadLabel: string; className?: string }) {
  const url = mediaUrl(file.node_id, file.file_id);
  return (
    <span className={cn("flex flex-wrap items-center gap-2", className)}>
      <a className={buttonVariants({ variant: "secondary", size: "sm" })} href={url} download={labeledFileName(downloadLabel, file.file_id, file.media_type)}>
        <Download aria-hidden />
        {t("下載（{downloadLabel}）", { downloadLabel })}
      </a>
      <a className={buttonVariants({ variant: "quiet", size: "sm" })} href={url} target="_blank" rel="noopener noreferrer">
        <ExternalLink aria-hidden />
        {t("新分頁開啟")}
      </a>
    </span>
  );
}

/** FileRef 事實：媒體型別、大小、SHA-256、持有者、metadata 摘要與連結檔（如 latent manifest 的 blob）。 */
export function FileRefView({ file, downloadLabel = "file", showLinks = true }: { file: FileRef; downloadLabel?: string; showLinks?: boolean }) {
  const owner = useFileOwnerLabel(file.node_id);
  const metadata = isRecord(file.metadata) ? file.metadata : {};
  const links = isRecord(metadata["links"]) ? Object.entries(metadata["links"]).filter((entry): entry is [string, FileRef] => isFileRef(entry[1])) : [];
  const items: KvItem[] = [
    { key: "media", label: t("媒體型別"), value: file.media_type, mono: true },
    { key: "size", label: t("大小"), value: <span title={formatBytesExact(file.size_bytes)}>{formatBytes(file.size_bytes)}</span>, mono: true },
    { key: "sha", label: "SHA-256", value: <IdText value={file.sha256} length={16} /> },
    { key: "file", label: "file_id", value: <IdText value={file.file_id} /> },
    { key: "node", label: t("持有者"), value: <span>{owner}</span> },
    ...SUMMARY_KEYS.filter((key) => metadata[key] !== undefined).map((key) => ({
      key: `meta-${key}`,
      label: <span className="machine">{key}</span>,
      value: displayText(metadata[key]),
      mono: true,
    })),
  ];
  return (
    <div className="grid min-w-0 gap-2">
      <KeyValueList items={items} dense />
      {links.length > 0 ? (
        <div className="grid gap-1">
          <p className="text-caption text-fg-tertiary">{t("連結檔（metadata.links）")}</p>
          <ul className="grid gap-1">
            {links.map(([name, link]) => (
              <li key={name} className="flex flex-wrap items-center gap-2 text-caption">
                <code className="machine text-fg">{name}</code>
                <span className="machine text-fg-secondary">{formatBytes(link.size_bytes)}</span>
                <IdText value={link.sha256} length={12} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {Object.keys(metadata).length > 0 ? (
        <Disclosure summary={t("完整 metadata")}>
          <JsonView value={metadata} label="FileRef metadata" maxHeightClass="max-h-56" />
        </Disclosure>
      ) : null}
      {showLinks ? <FileLinks file={file} downloadLabel={downloadLabel} /> : null}
    </div>
  );
}
