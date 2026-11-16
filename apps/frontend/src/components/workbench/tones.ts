// 工作台的語意色調：狀態 chip、圖示磚、類型色（節點、接點、紀錄來源）共用同一組對照。
// class 字串必須完整寫出（Tailwind 只掃描字面值），不要用字串拼接產生。
export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "entity" | "file" | "action";

/** 狀態 chip：tone/12 底、tone/30 邊、同色文字。 */
export const CHIP_TONE: Record<Tone, string> = {
  neutral: "border-line bg-raised text-fg-secondary",
  info: "border-info/30 bg-info/12 text-info",
  success: "border-success/30 bg-success/12 text-success",
  warning: "border-warning/30 bg-warning/12 text-warning",
  danger: "border-danger/30 bg-danger/12 text-danger",
  entity: "border-entity/30 bg-entity/12 text-entity",
  file: "border-file/30 bg-file/12 text-file",
  action: "border-action/30 bg-action/12 text-action-fg",
};

/** 圖示磚（entity 標頭、節點卡標頭）：tone/12 底、tone/40 邊。 */
export const TILE_TONE: Record<Tone, string> = {
  neutral: "border-line-strong bg-raised text-fg-secondary",
  info: "border-info/40 bg-info/12 text-info",
  success: "border-success/40 bg-success/12 text-success",
  warning: "border-warning/40 bg-warning/12 text-warning",
  danger: "border-danger/40 bg-danger/12 text-danger",
  entity: "border-entity/40 bg-entity/12 text-entity",
  file: "border-file/40 bg-file/12 text-file",
  action: "border-action/40 bg-action/12 text-action-fg",
};

/** 純文字／圖示色。 */
export const TEXT_TONE: Record<Tone, string> = {
  neutral: "text-fg-tertiary",
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  entity: "text-entity",
  file: "text-file",
  action: "text-action-fg",
};

/** 實心點（樹的狀態點、接點）。 */
export const DOT_TONE: Record<Tone, string> = {
  neutral: "bg-fg-disabled",
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  entity: "bg-entity",
  file: "bg-file",
  action: "bg-action",
};

/** 類型色邊框（節點卡）：tone/45。 */
export const BORDER_TONE: Record<Tone, string> = {
  neutral: "border-line-strong",
  info: "border-info/45",
  success: "border-success/45",
  warning: "border-warning/45",
  danger: "border-danger/45",
  entity: "border-entity/45",
  file: "border-file/45",
  action: "border-action/45",
};

/** SVG 線條（連線、圖表標記）。 */
export const STROKE_TONE: Record<Tone, string> = {
  neutral: "stroke-line-control",
  info: "stroke-info",
  success: "stroke-success",
  warning: "stroke-warning",
  danger: "stroke-danger",
  entity: "stroke-entity",
  file: "stroke-file",
  action: "stroke-action",
};
