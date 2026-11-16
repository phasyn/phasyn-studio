// 設定：這次 recording 保存的歷史設定快照（不是 UI 目前值）。requested／effective／observed 並排、
// stored 與 loaded revision、展開後的 parts、模型與 runtime 身分、輸入摘要、環境與 recorder 設定。
import { Boxes, ChevronRight, Cog, FileInput, Fingerprint, ListTree, Server, SlidersHorizontal, TriangleAlert } from "lucide-react";
import { useId, useMemo, useState, type ReactNode } from "react";
import type { Recording } from "@/api/generated/contracts";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Checkbox } from "@/components/ui/controls";
import { KeyValueList } from "@/components/ui/kv";
import { Table, TableScroll, Td, Th, Tr } from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { CopyButton } from "../components/Feedback";
import {
  buildSettingsRows,
  capturedPrompt,
  flattenSettings,
  formatSettingValue,
  inputPorts,
  pickConditionFacts,
  PROMPT_TYPE_ID,
  type Cell,
  type DigestReason,
  type InputPort,
} from "../model/settings";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

function Section({ id, icon, title, children, note }: { id: string; icon: ReactNode; title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="grid gap-3">
      <h3 id={id} className="flex items-center gap-2 text-section font-semibold text-fg [&_svg]:size-4 [&_svg]:text-fg-tertiary">
        {icon}
        {title}
      </h3>
      {note ? <div className="text-caption text-fg-tertiary">{note}</div> : null}
      {children}
    </section>
  );
}

function ValueText({ cell, className }: { cell: Cell; className?: string }) {
  if (!cell.present) return <span className="text-caption text-fg-tertiary">{t("（不存在）")}</span>;
  return <code className={cn("machine break-words whitespace-pre-wrap", cell.value === null ? "text-fg-tertiary" : "text-fg", className)}>{formatSettingValue(cell.value)}</code>;
}

/** 物件展開為「路徑｜值」表格；null 照實顯示為 null。 */
function FlatTable({ label, value, empty }: { label: string; value: unknown; empty: string }) {
  const rows = useMemo(() => [...flattenSettings(value)], [value]);
  if (rows.length === 0) return <p className="text-data text-fg-tertiary">{empty}</p>;
  return (
    <TableScroll label={label}>
      <Table>
        <thead>
          <tr>
            <Th scope="col">{t("欄位")}</Th>
            <Th scope="col">{t("值")}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([path, item]) => (
            <Tr key={path}>
              <Td className="machine text-caption text-fg-secondary">{path}</Td>
              <Td>
                <ValueText cell={{ present: true, value: item }} />
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </TableScroll>
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const DIGEST_REASON: Readonly<Record<DigestReason, () => string>> = {
  capture_off: () => t("此 recording 的 capture_prompt=false，不保存文字與結構化輸入的內容"),
  controller: () => t("主控的 recording 只記錄輸入的摘要，不保存內容"),
  unstated: () => t("紀錄只保留摘要，沒有附原因"),
};

/** A captured prompt port: collapsed by default, with its length and a copy button. */
function PromptText({ port, text }: { port: string; text: string }) {
  return (
    <details className="group rounded-md border border-line-subtle bg-sunken/40">
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-md px-3 text-data text-fg transition-colors duration-(--duration-fast) hover:bg-raised/60 [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-4 shrink-0 text-fg-tertiary transition-transform duration-(--duration-spring-snappy) ease-spring-snappy group-open:rotate-90" />
        <T source={"顯示 {port}（此 recording 有擷取）<0>{promptCount} 字元</0>"} values={{ port, promptCount: text.length.toLocaleString("en-US") }} slots={[<span className="ml-auto text-caption text-fg-tertiary" />]} />
      </summary>
      <div className="flex items-start gap-2 border-t border-line-subtle px-3 py-2 animate-reveal">
        <p className="min-w-0 flex-1 text-reading whitespace-pre-wrap break-words text-fg">{text}</p>
        <CopyButton text={text} label={t("複製 {port}", { port })} />
      </div>
    </details>
  );
}

/** A digest kept instead of the value: the digest (copyable) and why the value is not there. */
function DigestText({ digest, reason }: { digest: string; reason: DigestReason }) {
  return (
    <span className="grid min-w-0 gap-0.5">
      <span className="text-fg-secondary">{t("未擷取：{reason}", { reason: DIGEST_REASON[reason]() })}</span>
      <span className="flex min-w-0 items-center gap-1 text-caption text-fg-tertiary">
        <T source={"SHA-256 摘要 <0>{digest}</0>"} values={{ digest }} slots={[<code className="machine min-w-0 break-all text-fg-secondary" />]} />
        <CopyButton text={digest} label={t("複製摘要")} />
      </span>
    </span>
  );
}

/** What one port recorded, in the "other inputs" table. */
function InputContent({ entry }: { entry: InputPort }) {
  const { capture } = entry;
  if (capture.kind === "redacted") return <span className="text-fg-secondary">{t("已遮蔽（原本有擷取）")}</span>;
  if (capture.kind === "digest") return <DigestText digest={capture.digest} reason={capture.reason} />;
  const [only] = entry.fields;
  if (capture.kind === "value" && (entry.fields.length === 0 || (entry.fields.length === 1 && only?.[0] === "value"))) {
    return <ValueText cell={{ present: true, value: capture.value }} />;
  }
  if (entry.fields.length === 0) return <span className="text-fg-tertiary">—</span>;
  return <KeyValueList dense items={entry.fields.map(([path, value]) => ({ key: path, label: <code className="machine">{path}</code>, value: <ValueText cell={{ present: true, value }} /> }))} />;
}

/**
 * The input summary as recorded, port by port: captured prompts can be read and copied; ports that kept only a digest
 * say why; redacted values say so (they were captured). Every other port is listed with what it recorded.
 */
function InputSummary({ label, ports }: { label: string; ports: readonly InputPort[] }) {
  const prompts = ports.filter((entry) => entry.typeId === PROMPT_TYPE_ID && (capturedPrompt(entry) !== null || entry.capture.kind === "digest" || entry.capture.kind === "redacted"));
  const others = ports.filter((entry) => !prompts.includes(entry));
  if (ports.length === 0) return <p className="text-data text-fg-tertiary">{t("沒有輸入摘要。")}</p>;
  return (
    <>
      {prompts.map((entry) => {
        const text = capturedPrompt(entry);
        if (text !== null) return <PromptText key={entry.port} port={entry.port} text={text} />;
        return (
          <div key={entry.port} className="grid gap-1 rounded-md border border-line-subtle bg-sunken/40 px-3 py-2 text-data">
            <code className="machine text-fg">{entry.port}</code>
            {entry.capture.kind === "digest" ? (
              <DigestText digest={entry.capture.digest} reason={entry.capture.reason} />
            ) : (
              <span className="text-fg-secondary">{t("已遮蔽：這份紀錄裡的內容被遮蔽（原本有擷取）。")}</span>
            )}
          </div>
        );
      })}
      {others.length > 0 ? (
        <TableScroll label={label}>
          <Table>
            <thead>
              <tr>
                <Th scope="col">{t("連接埠")}</Th>
                <Th scope="col">type_id</Th>
                <Th scope="col">{t("紀錄內容")}</Th>
              </tr>
            </thead>
            <tbody>
              {others.map((entry) => (
                <Tr key={entry.port}>
                  <Td className="machine text-caption text-fg-secondary">{entry.port}</Td>
                  <Td className="machine text-caption text-fg-tertiary">{entry.typeId ?? "—"}</Td>
                  <Td className="min-w-[16rem]">
                    <InputContent entry={entry} />
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableScroll>
      ) : (
        <p className="text-data text-fg-tertiary">{t("沒有其他輸入摘要（shape、seed、FileRef）。")}</p>
      )}
    </>
  );
}

export function SettingsTab({ recording }: { recording: Recording }) {
  const { context, summary } = recording;
  const id = context.recording_id;
  const diffOnlyId = useId();
  const [diffOnly, setDiffOnly] = useState(false);
  const settings = context.settings;
  const table = useMemo(
    () => (settings ? buildSettingsRows(settings.requested, settings.effective, settings.observed) : { rows: [], observedUnmatched: [] }),
    [settings],
  );
  const visibleRows = diffOnly ? table.rows.filter((row) => row.status !== "same" || row.observedDiffers) : table.rows;
  const changedCount = table.rows.filter((row) => row.status !== "same").length;
  const ports = useMemo(() => inputPorts(context.input_summary, context.operation), [context.input_summary, context.operation]);
  const conditions = pickConditionFacts(asRecord(context.environment), asRecord(context.input_summary), settings ? asRecord(settings.effective) : null);
  const modelIdentity = settings?.model_identity ?? {};
  const identityStrength = typeof modelIdentity.identity_strength === "string" ? modelIdentity.identity_strength : null;

  return (
    <div className="grid gap-8">
      {!summary.context_available ? (
        <Callout tone="warning" title={t("context 尚未收到")}>
          <p>{t("主控還沒收到這筆 recording 的 context：設定、模型身分與環境是佔位，不偽補。稍後重新讀取或補抓 Node 歷史紀錄。")}</p>
        </Callout>
      ) : null}

      <Section
        id={`${id}-settings-diff`}
        icon={<SlidersHorizontal />}
        title={t("requested／effective／observed")}
        note={t("requested＝這次呼叫要求的設定；effective＝展開預設與 part 覆寫後實際採用；observed＝runtime 實際觀測（provider 宣告不等於硬體量測）。invoke.* 是元件保存的呼叫預設（元件預設）：這次呼叫的 parameters.* 有同名欄位時以 parameters 為準。")}
      >
        {!settings ? (
          <p className="text-data text-fg-secondary">
            <T source={"此 recording 沒有設定快照（operation=<0>{operation}</0>）。"} values={{ operation: context.operation }} slots={[<code className="machine" />]} />
          </p>
        ) : (
          <>
            <KeyValueList
              items={[
                { key: "stored", label: "stored revision", value: settings.stored_revision, mono: true },
                {
                  key: "loaded",
                  label: "loaded revision",
                  value:
                    settings.loaded_revision === null ? t("未載入（null）") : settings.loaded_revision !== settings.stored_revision ? (
                      <span className="inline-flex flex-wrap items-center gap-2">
                        <span className="machine">{settings.loaded_revision}</span>
                        <Badge tone="warning">
                          <TriangleAlert aria-hidden />
                          {t("與 stored 不同：此次使用 loaded 版本")}
                        </Badge>
                      </span>
                    ) : (
                      settings.loaded_revision
                    ),
                  mono: true,
                },
                {
                  key: "digest",
                  label: "config_digest",
                  value: (
                    <span className="inline-flex max-w-full min-w-0 items-center">
                      <code className="machine truncate" title={settings.config_digest}>
                        {settings.config_digest}
                      </code>
                      <CopyButton text={settings.config_digest} label={t("複製 config_digest")} />
                    </span>
                  ),
                },
              ]}
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Checkbox
                id={diffOnlyId}
                label={t("只顯示有差異的列")}
                description={t("requested≠effective 共 {changedCount} 列；observed 不同者也會列出", { changedCount })}
                checked={diffOnly}
                onChange={(event) => setDiffOnly(event.target.checked)}
              />
            </div>
            {visibleRows.length === 0 ? (
              <p className="text-data text-fg-tertiary">{table.rows.length === 0 ? t("requested 與 effective 都是空的。") : t("沒有差異。")}</p>
            ) : (
              <TableScroll label={t("requested／effective／observed 對照")}>
                <Table>
                  <thead>
                    <tr>
                      <Th scope="col">{t("路徑")}</Th>
                      <Th scope="col">requested</Th>
                      <Th scope="col">effective</Th>
                      <Th scope="col">observed</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((row) => {
                      const changed = row.status !== "same";
                      return (
                        <Tr key={row.path} className={cn(changed && "bg-warning/6")}>
                          <Td className="machine text-caption text-fg-secondary">
                            {row.path}
                            {row.componentDefault ? (
                              <span className="mt-1 grid justify-items-start gap-0.5 font-sans">
                                <Badge title={t("invoke.* 是元件保存的呼叫預設，不是這次呼叫指定的值")}>{t("元件預設")}</Badge>
                                <span className="text-fg-tertiary">
                                  {row.componentDefault.parameter.present ? (
                                    <>
                                      <T source={"這次呼叫用 <0>{parameterPath}</0>＝<1>{formatSettingValue}</1>"} values={{ parameterPath: row.componentDefault.parameterPath, formatSettingValue: formatSettingValue(row.componentDefault.parameter.value) }} slots={[<code className="machine" />, <code className="machine text-fg" />]} />
                                    </>
                                  ) : (
                                    t("這次呼叫的 parameters 沒有覆寫：採用元件預設")
                                  )}
                                </span>
                              </span>
                            ) : null}
                            {changed ? (
                              <span className="mt-1 flex items-center gap-1 font-sans text-warning">
                                <TriangleAlert aria-hidden className="size-3.5" />
                                {row.status === "adjusted" ? t("effective 已調整") : row.status === "requested_only" ? t("effective 未包含") : t("僅 effective（預設或展開）")}
                              </span>
                            ) : null}
                          </Td>
                          <Td>
                            <ValueText cell={row.requested} />
                          </Td>
                          <Td>
                            <ValueText cell={row.effective} className={changed ? "text-warning" : undefined} />
                          </Td>
                          <Td>
                            {row.observed.present ? (
                              <span className="grid gap-0.5">
                                <ValueText cell={row.observed} className={row.observedDiffers ? "text-info" : undefined} />
                                {row.observed.matchedBy === "name" ? (
                                  <span className="text-caption text-fg-tertiary">
                                    <T source={"依欄位名稱對應（<0>{observedPath}</0>）"} values={{ observedPath: row.observed.observedPath }} slots={[<code className="machine" />]} />
                                  </span>
                                ) : null}
                                {row.observedDiffers ? <span className="text-caption text-info">{t("與 effective 不同")}</span> : null}
                              </span>
                            ) : (
                              <span className="text-caption text-fg-tertiary">{t("未觀測")}</span>
                            )}
                          </Td>
                        </Tr>
                      );
                    })}
                  </tbody>
                </Table>
              </TableScroll>
            )}
            {table.observedUnmatched.length > 0 ? (
              <div className="grid gap-2">
                <h4 className="text-data font-semibold text-fg-secondary">{t("其他 observed 欄位（無法對應到設定路徑）")}</h4>
                <FlatTable label={t("其他 observed 欄位")} value={Object.fromEntries(table.observedUnmatched)} empty="—" />
              </div>
            ) : null}
          </>
        )}
      </Section>

      <Section
        id={`${id}-parts`}
        icon={<ListTree />}
        title={t("展開後的 parts（expanded_parts）")}
        note={t("selector 套用後，實際命中的完整 part 路徑與各自的設定；這是此次保存的展開結果。")}
      >
        {settings && Object.keys(settings.expanded_parts).length > 0 ? (
          <ul className="grid gap-1.5">
            {Object.entries(settings.expanded_parts).map(([part, value]) => (
              <li key={part}>
                <details className="group rounded-md border border-line-subtle bg-sunken/40">
                  <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-md px-3 text-data transition-colors duration-(--duration-fast) hover:bg-raised/60 [&::-webkit-details-marker]:hidden">
                    <ChevronRight aria-hidden className="size-4 shrink-0 text-fg-tertiary transition-transform duration-(--duration-spring-snappy) ease-spring-snappy group-open:rotate-90" />
                    <Boxes aria-hidden className="size-4 shrink-0 text-fg-tertiary" />
                    <code className="machine min-w-0 break-all text-fg">{part}</code>
                    <span className="ml-auto text-caption text-fg-tertiary">{t("{keysCount} 個欄位", { keysCount: Object.keys(value ?? {}).length })}</span>
                  </summary>
                  <div className="border-t border-line-subtle px-3 py-2 animate-reveal">
                    <FlatTable label={t("part {part} 的設定", { part })} value={value ?? {}} empty={t("此 part 沒有覆寫欄位（沿用 instance 設定）。")} />
                  </div>
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-data text-fg-tertiary">{t("沒有 part 覆寫或展開結果。")}</p>
        )}
      </Section>

      <Section
        id={`${id}-identity`}
        icon={<Fingerprint />}
        title={t("模型與 runtime 身分")}
        note={
          identityStrength === "path_stat" ? (
            <span className="text-warning">{t("identity_strength=path_stat：以路徑＋大小＋mtime 辨識權重，不是內容雜湊；不能宣稱與另一筆完全相同權重。")}</span>
          ) : identityStrength ? (
            <span>
              identity_strength=<code className="machine">{identityStrength}</code>
            </span>
          ) : undefined
        }
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="grid content-start gap-2">
            <h4 className="text-data font-semibold text-fg-secondary">model_identity</h4>
            <FlatTable label="model_identity" value={settings?.model_identity ?? {}} empty={t("沒有模型身分資料。")} />
          </div>
          <div className="grid content-start gap-2">
            <h4 className="text-data font-semibold text-fg-secondary">runtime_identity</h4>
            <FlatTable label="runtime_identity" value={settings?.runtime_identity ?? {}} empty={t("沒有 runtime 身分資料。")} />
          </div>
        </div>
      </Section>

      <Section id={`${id}-input`} icon={<FileInput />} title={t("輸入摘要")}>
        <InputSummary label={t("各連接埠的輸入摘要")} ports={ports} />
      </Section>

      <Section
        id={`${id}-conditions`}
        icon={<Cog />}
        title={t("冷暖／compile／cache 與 recorder 設定")}
        note={t("比較兩筆 recording 時，這些條件不同就是混淆因素。")}
      >
        {conditions.length > 0 ? (
          <FlatTable label={t("冷暖、compile 與 cache")} value={Object.fromEntries(conditions)} empty="—" />
        ) : (
          <p className="text-data text-fg-tertiary">{t("context 沒有記錄冷暖、compile、cache 或常駐狀態；比較時視為未知。")}</p>
        )}
        <h4 className="text-data font-semibold text-fg-secondary">{t("recorder 設定（此次生效）")}</h4>
        <FlatTable label={t("recorder 設定")} value={context.recording} empty={t("沒有 recorder 設定。")} />
      </Section>

      <Section id={`${id}-environment`} icon={<Server />} title={t("環境")}>
        <FlatTable label={t("環境")} value={context.environment} empty={t("沒有環境資料。")} />
      </Section>
    </div>
  );
}
