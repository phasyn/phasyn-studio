import { useQuery } from "@tanstack/react-query";
import { t } from "@/i18n";
import { isRecord, type JsonObject } from "@/lib/json";
import { apiFetch } from "./http";
import { qk } from "./keys";

function obj(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

function recorded(fact: unknown): unknown {
  const entry = obj(fact);
  return entry["status"] === "recorded" ? entry["value"] : undefined;
}

function weightTypes(observed: JsonObject): string[] {
  const census = [observed["parameter_dtypes"], observed["quantized_weight_dtypes"]]
    .flatMap((fact) => Object.keys(obj(recorded(fact))));
  const vae = recorded(observed["vae_weight_dtype"]);
  return [...new Set(typeof vae === "string" ? [...census, vae] : census)];
}

function projectRecipe(rawJson: string, runId: string) {
  const source = obj(JSON.parse(rawJson) as unknown);
  const recipe = obj(source["recipe"]);
  const execution = obj(source["execution"]);
  if (source["schema_version"] !== "phasyn.inference-recipe.v1" || execution["run_id"] !== runId
    || typeof source["recipe_sha256"] !== "string" || !/^[a-f0-9]{64}$/.test(source["recipe_sha256"])
    || typeof source["document_sha256"] !== "string" || !/^[a-f0-9]{64}$/.test(source["document_sha256"])
    || !isRecord(recipe["steps"]) || !isRecord(execution["steps"])) {
    throw new Error(t("主控回傳的推論配方格式無法辨識。"));
  }
  const evidence = execution["steps"];
  const steps = Object.entries(recipe["steps"]).map(([id, raw]) => {
    const data = obj(raw);
    const observed = obj(data["observed"]);
    const record = obj(evidence[id]);
    const admission = obj(obj(record["events"])["QIMG_DIT_ADMISSION"]);
    const sampling = obj(recorded(obj(data["effective"])["sampling"]));
    const backend = recorded(observed["active_attention_backend"]);
    const fallback = obj(recorded(record["fallback"]))["calls"];
    return {
      id,
      component: typeof data["component_id"] === "string" ? data["component_id"] : id,
      provider: typeof data["provider_id"] === "string" ? data["provider_id"] : undefined,
      backend: typeof backend === "string" ? backend : undefined,
      weightTypes: weightTypes(observed),
      seed: typeof sampling["seed"] === "number" ? sampling["seed"] : undefined,
      steps: typeof sampling["steps"] === "number" ? sampling["steps"] : undefined,
      fallbackCalls: typeof fallback === "number" ? fallback : undefined,
      requiredBytes: obj(admission["fields"])["required_bytes"],
      details: { recipe: data, execution: record },
    };
  });
  // Preserve the Controller's exact number representation, including integer precision and trailing .0.
  return { rawJson, steps, digest: source["recipe_sha256"], succeeded: execution["state"] === "succeeded" };
}

export function useRunRecipe(runId: string, running: boolean) {
  return useQuery({
    queryKey: [...qk.run(runId), "recipe", running],
    queryFn: async ({ signal }) => {
      const response = await apiFetch(`/api/runs/${encodeURIComponent(runId)}/recipe`, { signal });
      return projectRecipe(await response.text(), runId);
    },
    staleTime: 10_000,
  });
}
