// Recording reads (GET /api/recordings…): list pages, one recording, its event pages and streams. Feature query keys
// extend qk.recordings(). Reads may be retried (retryRead); the only recording write (fetch-history) never is.
import type { EventPage, FetchHistoryRequest, FetchHistoryResult, Recording, RecordingPage, RecordingStream } from "./generated/contracts";
import { contractJson, isApiError } from "./http";

/** API path of one recording, optionally with a sub-path such as "/events" (not the UI route; see app/paths). */
export function recordingApiPath(id: string, suffix = ""): string {
  return `/api/recordings/${encodeURIComponent(id)}${suffix}`;
}

/** Read retries: 4xx (not found, bad arguments, ambiguous stream) never; network errors or 5xx at most twice more. */
export function retryRead(failureCount: number, error: unknown): boolean {
  if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

export function fetchRecording(id: string, signal?: AbortSignal): Promise<Recording> {
  return contractJson("Recording", recordingApiPath(id), { signal });
}

export interface RecordingEventsQuery {
  stream_id: string;
  after_seq?: number;
  limit?: number;
}

/** One page of a stream's events (after_seq → next_seq). */
export function fetchRecordingEvents(id: string, query: RecordingEventsQuery, signal?: AbortSignal): Promise<EventPage> {
  return contractJson("EventPage", recordingApiPath(id, "/events"), { query: { ...query }, signal });
}

/** Display order of event streams; unknown streams follow, by id. Each stream numbers its events from 1 on its own. */
export const STREAM_ORDER: readonly string[] = ["runtime", "node", "controller"];

function streamRank(streamId: string): number {
  const index = STREAM_ORDER.indexOf(streamId);
  return index === -1 ? STREAM_ORDER.length : index;
}

/** A recording's streams in display order (runtime → node → controller, then others by id); none yet → []. */
export function recordingStreams(recording: Pick<Recording, "streams">): RecordingStream[] {
  return [...(recording.streams ?? [])].sort((a, b) => streamRank(a.stream_id) - streamRank(b.stream_id) || a.stream_id.localeCompare(b.stream_id));
}

/** Filters GET /api/recordings accepts (contracts/openapi.json); unset or empty values are not sent. */
export interface RecordingQuery {
  operation?: "load" | "invoke" | "unload" | "controller" | "node";
  node_id?: string;
  component_id?: string;
  provider_id?: string;
  run_id?: string;
  call_id?: string;
  part?: string;
  /** ISO 8601 time range. */
  since?: string;
  until?: string;
  error_code?: string;
  precision?: string;
  config_digest?: string;
  cursor?: string | null;
  limit?: number;
}

export function fetchRecordingPage(query: RecordingQuery = {}, signal?: AbortSignal): Promise<RecordingPage> {
  return contractJson("RecordingPage", "/api/recordings", { query: { ...query }, signal });
}

/**
 * One Node's own recordings, read through the Controller (GET /api/nodes/{id}/recordings; the Node's page as is). For
 * calls whose recording the Controller never received, e.g. after it was interrupted. Read-only.
 */
export function fetchNodeRecordingPage(nodeId: string, query: Omit<RecordingQuery, "node_id"> = {}, signal?: AbortSignal): Promise<RecordingPage> {
  return contractJson("RecordingPage", `/api/nodes/${encodeURIComponent(nodeId)}/recordings`, { query: { ...query }, signal });
}

/**
 * Explicitly copies a recording's log and events from its Node into the Controller index (POST …/fetch-history). It
 * runs, dispatches or resumes nothing and is never retried automatically: on a timeout the outcome is unknown and the
 * user re-reads the recording.
 */
export function fetchRecordingHistory(recordingId: string, body: FetchHistoryRequest): Promise<FetchHistoryResult> {
  return contractJson("FetchHistoryResult", recordingApiPath(recordingId, "/fetch-history"), { method: "POST", json: body });
}
