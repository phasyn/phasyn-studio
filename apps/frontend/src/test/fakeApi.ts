// In-memory Controller for component tests: replaces the global fetch (the app's only network seam, api/http.ts) with
// a route table. Unknown routes answer 404 NOT_FOUND so a missing handler fails loudly instead of hanging.
import { vi } from "vitest";

export interface FakeRequest {
  method: string;
  /** Path without the query string, e.g. "/api/catalog". */
  path: string;
  query: URLSearchParams;
  /** Parsed JSON body (raw text when it is not JSON; undefined without a body). */
  body: unknown;
}

/** Return a value to answer 200 with it as JSON, or a Response (see `fakeError`) for anything else. */
export type FakeHandler = (request: FakeRequest) => unknown;

/** A contract Error response. */
export function fakeError(status: number, code: string, message = code, details: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ code, message, details }), { status, headers: { "Content-Type": "application/json" } });
}

function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") return body ?? undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

/**
 * Installs the fake for the current test (setup.dom.ts restores fetch after each test). Routes are keyed
 * "METHOD /path" (e.g. "GET /api/catalog"); every request is recorded in `calls`.
 */
export function installFakeApi(routes: Readonly<Record<string, FakeHandler>>): { calls: FakeRequest[] } {
  const calls: FakeRequest[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://controller.test");
    const request: FakeRequest = { method: (init.method ?? "GET").toUpperCase(), path: url.pathname, query: url.searchParams, body: parseBody(init.body) };
    calls.push(request);
    const handler = routes[`${request.method} ${request.path}`];
    if (!handler) return fakeError(404, "NOT_FOUND", `fake api: no route for ${request.method} ${request.path}`);
    const result = await handler(request);
    return result instanceof Response ? result : new Response(JSON.stringify(result ?? null), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  return { calls };
}
