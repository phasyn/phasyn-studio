// 第一次使用的預設：DiT 沒載入預覽 VAE 時，預設的 VAE 縮圖預覽不會讓生成失敗（只是沒有中間預覽）；
// 改成比 1024² 大的尺寸時，完整解碼預設改成分塊解碼（之後使用者自己選回完整解碼就照他的）。
import { describe, expect, it } from "vitest";
import type { WireStep } from "@/api/types";
import { BF16_DIT, catalog, project, qimgComponents, t2iPipeline } from "./imageFixtures";
import { planImageRender } from "./plan";
import { deriveImageRoutes } from "./routes";
import { decodeWarning, sizePatch } from "./size";

/** The BF16 DiT of the fixtures, with or without provider_options.preview_vae. */
function routesWith(previewVae: boolean | undefined) {
  const options: Record<string, unknown> = { variant: "bf16" };
  if (previewVae !== undefined) options.preview_vae = previewVae;
  return deriveImageRoutes([t2iPipeline()], catalog(qimgComponents({ [BF16_DIT]: { options, offload: { mode: "group_stream" }, exclusiveGroup: "dit" } })));
}

function ditStep(steps: WireStep[]): WireStep {
  const step = steps.find((item) => item.step_id === "dit");
  if (!step) throw new Error("no dit step");
  return step;
}

describe("預覽預設（#31）", () => {
  it("DiT 沒寫 preview_vae：視為沒有預覽 VAE，生成照常送出、預覽關閉並附註", () => {
    const routes = routesWith(undefined);
    expect(routes[0]?.previewVae).toBe(false);
    const doc = project([{ image_shot_id: "s1", route: routes[0]?.id }]);
    const shot = doc.image_shots?.[0];
    if (!shot) throw new Error("fixture");
    expect(shot.preview.mode).toBe("vae_thumbnail");
    const result = planImageRender(doc, shot, ["t0"], { routes, randomSeed: () => 1 });
    expect(result.problem).toBeNull();
    expect(ditStep(result.plan?.body.pipeline.steps ?? []).parameters.preview).toEqual({ mode: "off", every: shot.preview.every });
    expect(result.plan?.notes.some((note) => note.includes("preview_vae"))).toBe(true);
  });

  it("DiT 以 preview_vae 載入：照設定送 VAE 縮圖預覽", () => {
    const routes = routesWith(true);
    const doc = project([{ image_shot_id: "s1", route: routes[0]?.id }]);
    const shot = doc.image_shots?.[0];
    if (!shot) throw new Error("fixture");
    const result = planImageRender(doc, shot, ["t0"], { routes, randomSeed: () => 1 });
    expect(result.problem).toBeNull();
    expect(ditStep(result.plan?.body.pipeline.steps ?? []).parameters.preview).toEqual({ mode: "vae_thumbnail", every: shot.preview.every });
    expect(result.plan?.notes ?? []).toEqual([]);
  });
});

describe("大尺寸的解碼預設（#32）", () => {
  it("從 1024² 以內改到更大時，完整解碼改成分塊", () => {
    expect(sizePatch({ width: 1024, height: 1024, decode: "full" }, 1824, 1024)).toEqual({ width: 1824, height: 1024, decode: "tiled" });
    expect(sizePatch({ width: 1024, height: 1024, decode: "full" }, 1536, 1536)).toEqual({ width: 1536, height: 1536, decode: "tiled" });
  });

  it("尺寸還在上限內、已經是分塊，或使用者在大尺寸時自己選了完整解碼：不改解碼方式", () => {
    expect(sizePatch({ width: 1024, height: 1024, decode: "full" }, 1024, 768)).toEqual({ width: 1024, height: 768 });
    expect(sizePatch({ width: 1024, height: 1024, decode: "tiled" }, 1824, 1024)).toEqual({ width: 1824, height: 1024 });
    expect(sizePatch({ width: 1824, height: 1024, decode: "full" }, 2048, 1024)).toEqual({ width: 2048, height: 1024 });
  });

  it("大尺寸的完整解碼有提醒，1024² 以內沒有", () => {
    expect(decodeWarning(1824, 1024, "full")).not.toBeNull();
    expect(decodeWarning(1024, 1024, "full")).toBeNull();
  });
});
