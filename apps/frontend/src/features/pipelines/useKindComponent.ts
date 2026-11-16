import { useCatalog, useProviderIndex } from "@/api/catalog";
import type { ComponentDescriptor } from "@/api/generated/contracts";
import { componentOptions, optionsOfKind } from "./catalogIndex";

/** 與 KindComponentSelect 相同的預設選擇（就緒優先），供呼叫端取得 descriptor。 */
export function useKindComponent(kind: string, value: string | null): ComponentDescriptor | null {
  const catalog = useCatalog();
  const providers = useProviderIndex((catalog.data?.nodes ?? []).map((node) => node.node_id));
  const options = optionsOfKind(componentOptions(catalog.data, providers), kind);
  return (options.find((option) => option.value === value) ?? options[0])?.descriptor ?? null;
}
