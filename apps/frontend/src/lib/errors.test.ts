import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "@/api/http";
import { activate } from "@/i18n/store";
import { CLIENT_CODES, ERROR_HEADLINE_CODES } from "@/i18n/errors";
import { errorText, failureText, humanizeIds, setRunNamer } from "./errors";

const RUN = "00000000-0000-4000-8000-0000000000a1";
const FILE = "00000000-0000-4000-8000-0000000000a2";

afterEach(() => {
  activate("zh-Hant", new Map());
  setRunNamer(() => null);
});

describe("error texts", () => {
  it("has a headline for every client-produced code", () => {
    expect(CLIENT_CODES.filter((code) => !ERROR_HEADLINE_CODES.includes(code))).toEqual([]);
  });
});

describe("failureText", () => {
  it("never shows the error code", () => {
    const text = errorText(new ApiError(409, { code: "STATE_CONFLICT", message: "專案可攜包仍有缺件" }, "HTTP 409", "GET"));
    expect(text).toBe("專案可攜包仍有缺件");
    expect(text).not.toContain("STATE_CONFLICT");
  });

  it("names a run by what the app read about it, never by its id", () => {
    setRunNamer((id) => (id === RUN ? "序列匯出" : null));
    expect(humanizeIds(`檔案正被執行中的 run ${RUN} 使用`)).toBe("檔案正被執行中的「序列匯出」使用");
    setRunNamer(() => null);
    expect(humanizeIds(`檔案正被執行中的 run ${RUN} 使用`)).toBe("檔案正被執行中的另一個工作使用");
  });

  it("leaves other ids out", () => {
    expect(humanizeIds(`找不到已發布檔案 ${FILE} 的內容`)).toBe("找不到已發布檔案的內容");
    expect(humanizeIds(`找不到檔案（${FILE}）`)).toBe("找不到檔案");
  });

  it("adds the run that holds the files from the details", () => {
    setRunNamer((id) => (id === RUN ? "序列匯出" : null));
    expect(failureText("STATE_CONFLICT", "這個 run 產生的檔案正被另一個執行中的工作使用；等它結束後再刪除", { active_run_id: RUN }))
      .toBe("這個 run 產生的檔案正被另一個執行中的工作使用；等它結束後再刪除（序列匯出）");
  });

  it("translates a fixed message and, in English, replaces an untranslatable Chinese one with the code's headline", () => {
    activate("en", new Map([["專案可攜包仍有缺件", "The portable package is incomplete"]]));
    expect(failureText("STATE_CONFLICT", "專案可攜包仍有缺件")).toBe("The portable package is incomplete");
    const dynamic = failureText("STATE_CONFLICT", "動態的 3 個訊息");
    expect(dynamic).not.toContain("動態的 3 個訊息");
    expect(dynamic).not.toContain("STATE_CONFLICT");
  });
});
