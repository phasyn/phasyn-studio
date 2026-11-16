import { afterEach, describe, expect, it } from "vitest";
import { activate } from "@/i18n/store";
import { CLIENT_CODES, ERROR_HEADLINE_CODES } from "@/i18n/errors";

afterEach(() => {
  activate("zh-Hant", new Map());
});

describe("error texts", () => {

  it("has a headline for every client-produced code", () => {
    expect(CLIENT_CODES.filter((code) => !ERROR_HEADLINE_CODES.includes(code))).toEqual([]);
  });
});
