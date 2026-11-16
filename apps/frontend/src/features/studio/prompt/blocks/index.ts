// Prompt block model (pure functions): splits prompt text into manageable blocks; untouched text round-trips exactly
// through parse → serialize. Public entry of the block modules.
export { deleteBlock, duplicateBlock, insertFragment, moveBlock, replaceBlock, setBlockBody, setBlockHeading, type HeadingEdit } from "./edit";
export { cutMarker, lineHeading, shotMarker } from "./headings";
export { parsePrompt } from "./parse";
export { addMissingSections, missingSections } from "./sections";
export { blockIndexAt, blockSpans, blockText, bodyContext, defaultJoiner, serializePrompt, type BlockSpan } from "./serialize";
export { formatClock, formatSeconds, parseClock, parseSecondsInput, rangeLabel } from "./time";
export { proposeTimelineBlock, type TimelineProposal } from "./timeline";
export {
  H3_SECTIONS,
  type BlockKind,
  type BlockLevel,
  type H3Section,
  type Heading,
  type MarkerStyle,
  type PromptBlock,
  type PromptDocument,
  type ShotForm,
  type TimeRange,
} from "./types";
