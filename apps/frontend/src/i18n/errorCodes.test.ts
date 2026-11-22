// The frontend error table against the server's error-code registry (contracts/error-codes.json, generated into
// src/api/generated/errorCodes.ts by gen:types): every server code has a headline, and every headline belongs to a
// server code or to a code the frontend produces itself (CLIENT_CODES).
import { describe, expect, it } from "vitest";
import { ERROR_CODE_KINDS } from "@/api/generated/errorCodes";
import { CLIENT_CODES, ERROR_HEADLINE_CODES, ERROR_HINT_CODES, errorHint } from "./errors";

const SERVER_CODES = Object.keys(ERROR_CODE_KINDS);

describe("error codes", () => {
  it("has a headline for every server code", () => {
    expect(SERVER_CODES.filter((code) => !ERROR_HEADLINE_CODES.includes(code))).toEqual([]);
  });

  it("has no headline for a code nobody sends", () => {
    expect(ERROR_HEADLINE_CODES.filter((code) => !SERVER_CODES.includes(code) && !CLIENT_CODES.includes(code))).toEqual([]);
  });

  it("keeps client codes out of the server registry", () => {
    expect(CLIENT_CODES.filter((code) => SERVER_CODES.includes(code))).toEqual([]);
  });

  it("gives every server code a next step (its own hint or its kind's)", () => {
    expect(SERVER_CODES.filter((code) => !((errorHint(code) ?? "") !== ""))).toEqual([]);
  });

  // The kind (client, conflict, unavailable, remote, internal) only picks a generic hint. These codes mean something
  // that hint would get wrong (a cancelled call is not a bad request, a missing trace is not a request to fix, a full
  // disk is not something to look up in the logs), so each needs its own next step.
  it("gives codes whose kind hint would mislead their own hint", () => {
    const specific = [
      "CANCELLED",
      "CALL_TIMEOUT",
      "EXCLUSIVE_GROUP_BUSY",
      "EXCLUSIVE_GROUP_CONFLICT",
      "NODE_UNREACHABLE",
      "NODE_SHUTTING_DOWN",
      "TRACE_UNAVAILABLE",
      "PREVIEW_NOT_FOUND",
      "COMPONENT_NOT_CONFIGURED",
      "RUNTIME_NOT_CONFIGURED",
      "INTEGRITY_MISMATCH",
      "DUPLICATE_NODE_ID",
      "TASK_RUNNING",
      "GPU_MEMORY_INSUFFICIENT",
      "HOST_MEMORY_INSUFFICIENT",
      "GPU_OOM",
      "HOST_OOM",
      "DISK_FULL",
      "WEIGHTS_DESTINATION_CONFLICT",
      "WEIGHTS_SOURCE_UNAVAILABLE",
    ];
    expect(specific.filter((code) => !SERVER_CODES.includes(code))).toEqual([]);
    expect(specific.filter((code) => !ERROR_HINT_CODES.includes(code))).toEqual([]);
  });
});
