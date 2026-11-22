import { isListed } from "@/lib/json";
import { ArrowRight, Plus, Trash } from "lucide-react";
import type { Port } from "@/api/generated/contracts";
import type { WirePipeline } from "@/api/types";
import { CommitInput } from "@/components/common/CommitInput";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/controls";
import { Table, TableScroll, Td, Th } from "@/components/ui/table";
import { typeTone } from "@/components/workbench/kinds";
import { TEXT_TONE } from "@/components/workbench/tones";
import { cn } from "@/lib/cn";
import { localIdError, uniqueName } from "@/lib/ids";
import { useStableKeys } from "@/lib/useStableKeys";
import { outputValue, parseOutputValue, removeInput, renameInput, type DescriptorLookup, type WiringEdge } from "./pipelineModel";
import { t } from "@/i18n";

/** 產品中出現的 type_id（輸入建議清單；仍可輸入其他值）。 */
const KNOWN_TYPES = [
  "text.prompt.v1",
  "media.image.v1",
  "media.video.v1",
  "media.audio.v1",
  "media.asset.v1",
  "video.final-latent.v1",
  "audio.final-latent.v1",
  "video.scene.v1",
  "caption.pair.v1",
  "dataset.manifest.v1",
  "dataset.archive.v1",
];

/** pipeline 輸入：名稱（改名同步更新引用）、type_id、必填、傳輸方式。 */
export function PipelineInputsEditor({
  pipeline,
  onChange,
  typeSuggestions,
}: {
  pipeline: WirePipeline;
  onChange: (next: WirePipeline) => void;
  typeSuggestions: readonly string[];
}) {
  const stable = useStableKeys(pipeline.inputs.length);
  const update = (index: number, patch: Partial<Port>) => { onChange({ ...pipeline, inputs: pipeline.inputs.map((port, position) => (position === index ? { ...port, ...patch } : port)) }); };
  const suggestions = [...new Set([...KNOWN_TYPES, ...typeSuggestions])].sort();
  return (
    <section className="grid gap-2" aria-labelledby="pipeline-inputs-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="pipeline-inputs-title" className="text-section font-semibold text-fg">
          {t("流程輸入（{inputsCount}）", { inputsCount: pipeline.inputs.length })}
        </h3>
        <Button
          size="sm"
          icon={<Plus aria-hidden />}
          onClick={() => {
            stable.append();
            const name = uniqueName("input", new Set(pipeline.inputs.map((port) => port.name)));
            onChange({ ...pipeline, inputs: [...pipeline.inputs, { name, type_id: "text.prompt.v1", required: true, transport: "inline", description: "" }] });
          }}
        >
          {t("新增輸入")}
        </Button>
      </div>
      <datalist id="pipeline-type-ids">
        {suggestions.map((type) => (
          <option key={type} value={type} />
        ))}
      </datalist>
      {pipeline.inputs.length === 0 ? (
        <p className="text-data text-fg-tertiary">{t("沒有流程輸入：步驟可改用常值或上游輸出。")}</p>
      ) : (
        <TableScroll label={t("流程輸入")}>
          <Table className="min-w-[46rem]">
            <thead>
              <tr>
                <Th scope="col">{t("名稱")}</Th>
                <Th scope="col">type_id</Th>
                <Th scope="col">{t("必填")}</Th>
                <Th scope="col">{t("傳輸")}</Th>
                <Th scope="col">{t("說明")}</Th>
                <Th scope="col">
                  <span className="sr-only">{t("操作")}</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {pipeline.inputs.map((port, index) => (
                <tr key={stable.keys[index]}>
                  <Td className="w-44">
                    <CommitInput
                      id={`pipeline-input-${String(index)}-name`}
                      label={t("輸入 {index} 名稱", { index: index + 1 })}
                      value={port.name}
                      onCommit={(next) => {
                        const error = localIdError(next, t("名稱 "));
                        if (error != null && error !== "") return error;
                        if (pipeline.inputs.some((other, position) => position !== index && other.name === next)) return t("名稱重複");
                        onChange(renameInput(pipeline, port.name, next));
                        return null;
                      }}
                    />
                  </Td>
                  <Td className="w-56">
                    <Input
                      aria-label={t("輸入 {name} 的 type_id", { name: port.name })}
                      className="machine"
                      list="pipeline-type-ids"
                      value={port.type_id}
                      onChange={(event) => { update(index, { type_id: event.target.value.trim() }); }}
                    />
                  </Td>
                  <Td>
                    <input
                      type="checkbox"
                      className="size-4 accent-action"
                      aria-label={t("輸入 {name} 必填", { name: port.name })}
                      checked={port.required}
                      onChange={(event) => { update(index, { required: event.target.checked }); }}
                    />
                  </Td>
                  <Td className="w-32">
                    <Select aria-label={t("輸入 {name} 的傳輸方式", { name: port.name })} value={port.transport} onChange={(event) => { const value = event.target.value; if (isListed(value, ["inline", "file", "either"] as const)) update(index, { transport: value }); }}>
                      <option value="inline">inline</option>
                      <option value="file">file</option>
                      <option value="either">either</option>
                    </Select>
                  </Td>
                  <Td>
                    <Input aria-label={t("輸入 {name} 的說明", { name: port.name })} value={port.description} onChange={(event) => { update(index, { description: event.target.value }); }} />
                  </Td>
                  <Td>
                    <Button
                      size="icon-sm"
                      variant="danger"
                      aria-label={t("刪除輸入 {name}（引用它的接線會一併移除）", { name: port.name })}
                      onClick={() => {
                        stable.remove(index);
                        onChange(removeInput(pipeline, port.name));
                      }}
                    >
                      <Trash aria-hidden />
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableScroll>
      )}
    </section>
  );
}

/** pipeline 輸出：名稱 → 步驟／輸出埠。 */
export function PipelineOutputsEditor({
  pipeline,
  lookup,
  onChange,
}: {
  pipeline: WirePipeline;
  lookup: DescriptorLookup;
  onChange: (next: WirePipeline) => void;
}) {
  const entries = Object.entries(pipeline.outputs);
  const stable = useStableKeys(entries.length);
  const rebuild = (next: [string, { from_step: string; output: string }][]) => { onChange({ ...pipeline, outputs: Object.fromEntries(next) }); };
  const options = pipeline.steps.flatMap((step) => {
    const descriptor = lookup(step.node_id, step.component_id);
    return (descriptor?.outputs ?? []).map((port) => ({ value: outputValue(step.step_id, port.name), label: `${step.step_id}.${port.name} · ${port.type_id}` }));
  });
  return (
    <section className="grid gap-2" aria-labelledby="pipeline-outputs-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="pipeline-outputs-title" className="text-section font-semibold text-fg">
          {t("流程輸出（{entriesCount}）", { entriesCount: entries.length })}
        </h3>
        <Button
          size="sm"
          icon={<Plus aria-hidden />}
          disabled={options.length === 0}
          title={options.length === 0 ? t("先加入有輸出的步驟") : undefined}
          onClick={() => {
            const first = options[0] ? parseOutputValue(options[0].value) : null;
            if (!first) return;
            stable.append();
            rebuild([...entries, [uniqueName(first.output, new Set(entries.map(([name]) => name))), { from_step: first.stepId, output: first.output }]]);
          }}
        >
          {t("新增輸出")}
        </Button>
      </div>
      {entries.length === 0 ? (
        <p className="text-data text-fg-tertiary">{t("沒有流程輸出：run 明細仍會列出每個步驟的輸出。")}</p>
      ) : (
        <ul className="grid gap-2">
          {entries.map(([name, target], index) => {
            const value = outputValue(target.from_step, target.output);
            return (
              <li key={stable.keys[index]} className="flex flex-wrap items-start gap-2">
                <CommitInput
                  id={`pipeline-output-${String(index)}-name`}
                  label={t("輸出 {index} 名稱", { index: index + 1 })}
                  className="w-44"
                  value={name}
                  onCommit={(next) => {
                    const error = localIdError(next, t("名稱 "));
                    if (error != null && error !== "") return error;
                    if (entries.some(([other], position) => position !== index && other === next)) return t("名稱重複");
                    rebuild(entries.map((entry, position) => (position === index ? [next, entry[1]] : entry)));
                    return null;
                  }}
                />
                <ArrowRight aria-hidden className="mt-3 size-4 rotate-180 text-fg-tertiary" />
                <div className="min-w-64 flex-1">
                  <Select
                    aria-label={t("輸出 {name} 的來源", { name })}
                    value={value}
                    onChange={(event) => {
                      const parsed = parseOutputValue(event.target.value);
                      if (!parsed) return;
                      rebuild(entries.map((entry, position) => (position === index ? [entry[0], { from_step: parsed.stepId, output: parsed.output }] : entry)));
                    }}
                  >
                    {!options.some((option) => option.value === value) ? (
                      <option value={value}>
                        {t("{from_step}.{output}（不存在或元件不在目錄）", { from_step: target.from_step, output: target.output })}
                      </option>
                    ) : null}
                    {options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                </div>
                <Button
                  size="icon-sm"
                  variant="danger"
                  aria-label={t("刪除輸出 {name}", { name })}
                  onClick={() => {
                    stable.remove(index);
                    rebuild(entries.filter((_, position) => position !== index));
                  }}
                >
                  <Trash aria-hidden />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const KIND_LABEL: Record<WiringEdge["kind"], string> = { input: t("輸入"), step: t("步驟"), literal: t("常值"), output: t("輸出") };

/** 接線摘要：依拓撲順序列出每條邊與型別。 */
export function WiringSummary({ edges }: { edges: readonly WiringEdge[] }) {
  return (
    <section className="grid gap-2" aria-labelledby="wiring-summary-title">
      <h3 id="wiring-summary-title" className="text-section font-semibold text-fg">
        {t("接線摘要（{edgesCount} 條）", { edgesCount: edges.length })}
      </h3>
      {edges.length === 0 ? (
        <p className="text-data text-fg-tertiary">{t("尚無接線。")}</p>
      ) : (
        <ol className="grid gap-1 rounded-lg border border-line-subtle bg-sunken px-3 py-2">
          {edges.map((edge, index) => (
            <li key={`${edge.from}-${edge.to}-${String(index)}`} className="flex flex-wrap items-center gap-2 text-data">
              <span className="min-w-10 shrink-0 text-caption text-fg-tertiary">{KIND_LABEL[edge.kind]}</span>
              <code className="machine text-fg-secondary">{edge.from}</code>
              <ArrowRight aria-label={t("接到")} className="size-3.5 text-fg-tertiary" />
              <code className="machine text-fg">{edge.to}</code>
              {/* 型別色與節點圖的接點、連線一致（文字／條件＝info、latent＝entity、媒體＝file，其他中性） */}
              <code className={cn("machine text-caption", (edge.typeId != null && edge.typeId !== "") ? TEXT_TONE[typeTone(edge.typeId)] : "text-fg-tertiary")}>{edge.typeId ?? t("型別未知")}</code>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
