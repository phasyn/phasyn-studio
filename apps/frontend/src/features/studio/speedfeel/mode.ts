// Which tool the speed-feel dialog opens on. Effect Controls asks for one just before it opens the dialog; every other
// way in (the clip's menu, the swap panel's check) gets the effects. The dialog reads the request when it opens and
// drops it once it shows, so a later opening is not steered by an old one.
export type SpeedFeelTool = "effects" | "conform";

let request: { clipId: string; tool: SpeedFeelTool } | null = null;

export function requestSpeedFeelTool(clipId: string, tool: SpeedFeelTool): void {
  request = { clipId, tool };
}

/** The tool asked for `clipId`; the effects when none was. */
export function requestedSpeedFeelTool(clipId: string): SpeedFeelTool {
  return request?.clipId === clipId ? request.tool : "effects";
}

export function clearSpeedFeelTool(): void {
  request = null;
}
