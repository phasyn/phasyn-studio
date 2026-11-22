// Wan 14B 表演影片 (Animate) and 音訊驅動 (S2V) run only on the large-memory node. The instances on
// the 16 GB machine carry `limits.studio = { render: false, reason: "device_memory", where: "node-b" }`: their routes are not ready, say why in
// the owner's words, and choosing the 方式 goes to the ready route on the other machine.
import { describe, expect, it } from "vitest";
import type { ComponentDescriptor } from "@/api/generated/contracts";
import type { WirePipeline } from "@/api/types";
import { descriptor, port, studioProject, studioShot } from "@/test/fixtures";
import { NODE_A_ID, NODE_B_ID } from "@/test/ids";
import { modeChange } from "./generationMode";
import { deriveStudioRoutes, studioPlacementBlock } from "./routes";
import { catalog } from "./studioFixtures";

const PC_ONLY = { studio: { render: false, reason: "device_memory", where: "node-b" } };

function performance(nodeId: string, componentId: string, limits: Record<string, unknown> | null): ComponentDescriptor {
  return descriptor(nodeId, componentId, "wan.performance", {
    inputs: [port("prompt", "text.prompt.v1"), port("character_image", "media.image.v1", true, "file"), port("performance_video", "media.video.v1", true, "file")],
    outputs: [port("asset", "media.asset.v1")],
    limits,
    facts: { studio_creative: { version: 1, medium: "video", output: "asset", inputs: { prompt: "prompt", character_image: "character_image", performance_video: "performance_video" } } },
  });
}

function route(id: string, nodeId: string, componentId: string): WirePipeline {
  return {
    pipeline_id: id,
    label: id,
    inputs: [
      { name: "prompt", type_id: "text.prompt.v1", required: true, transport: "inline", description: "" },
      { name: "character", type_id: "media.image.v1", required: true, transport: "file", description: "" },
      { name: "driving", type_id: "media.video.v1", required: true, transport: "file", description: "" },
    ],
    outputs: { final: { from_step: "gen", output: "asset" } },
    steps: [
      {
        step_id: "gen",
        node_id: nodeId,
        component_id: componentId,
        inputs: { prompt: { from_input: "prompt" }, character_image: { from_input: "character" }, performance_video: { from_input: "driving" } },
        parameters: {},
      },
    ],
  };
}

describe("Studio placement limits", () => {
  it("names the reason in the owner's words, with a generic fallback", () => {
    expect(studioPlacementBlock({ limits: PC_ONLY })).toBe("這台電腦的顯示卡記憶體不夠，只能在 node-b 上執行");
    expect(studioPlacementBlock({ limits: { studio: { render: false, reason: "device_memory" } } })).toBe("這台電腦的顯示卡記憶體不夠，只能在記憶體更大的主機上執行");
    expect(studioPlacementBlock({ limits: { studio: { render: false, reason: "validation_only" } } })).toContain("只用來驗證");
    expect(studioPlacementBlock({ limits: { studio: { render: true } } })).toBeNull();
    expect(studioPlacementBlock({ limits: { swap: {} } })).toBeNull();
    expect(studioPlacementBlock({ limits: null })).toBeNull();
  });

  it("a PC-only instance makes its route not ready, not a component to start", () => {
    const cat = catalog([performance(NODE_A_ID, "wan-performance", PC_ONLY)]);
    const [pc] = deriveStudioRoutes([route("wan-performance-local", NODE_A_ID, "wan-performance")], cat);
    expect(pc?.purpose).toBe("performance");
    expect(pc?.ready).toBe(false);
    expect(pc?.placement).toBe("這台電腦的顯示卡記憶體不夠，只能在 node-b 上執行");
    expect(pc?.summary).toBe(pc?.placement);
    expect(pc?.steps[0]?.slot.usable).toBe(true);
  });

  it("choosing 表演影片 goes to the ready route on the other node", () => {
    const cat = catalog([performance(NODE_A_ID, "wan-performance", PC_ONLY)], [performance(NODE_B_ID, "wan-performance-node-b", null)]);
    const routes = deriveStudioRoutes([route("wan-performance-local", NODE_A_ID, "wan-performance"), route("wan-performance-node-b", NODE_B_ID, "wan-performance-node-b")], cat);
    expect(routes.map((item) => [item.id, item.ready])).toEqual([["wan-performance-local", false], ["wan-performance-node-b", true]]);
    const shot = studioShot({ route: "wan-performance-local" });
    const project = studioProject({ shots: [shot] });
    const change = modeChange(project, shot, "performance", { routes, catalog: cat });
    expect(change.ok && change.route.id).toBe("wan-performance-node-b");
  });

  it("a validation-only variant ranks after the full one, so 表演影片 names the memory reason", () => {
    const VALIDATION = { studio: { render: false, reason: "validation_only", where: "node-b" } };
    const cat = catalog([performance(NODE_A_ID, "wan-performance-disk-blocks", VALIDATION), performance(NODE_A_ID, "wan-performance", PC_ONLY)]);
    const routes = deriveStudioRoutes([route("wan-performance-disk-blocks", NODE_A_ID, "wan-performance-disk-blocks"), route("wan-performance-local", NODE_A_ID, "wan-performance")], cat);
    expect(routes.map((item) => [item.id, item.experimental])).toEqual([["wan-performance-disk-blocks", true], ["wan-performance-local", false]]);
    const shot = studioShot({ route: "other" });
    const change = modeChange(studioProject({ shots: [shot] }), shot, "performance", { routes, catalog: cat });
    expect(change.ok && change.route.placement).toBe("這台電腦的顯示卡記憶體不夠，只能在 node-b 上執行");
  });
});
