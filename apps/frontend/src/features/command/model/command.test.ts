// 命令面板純邏輯測試；所有資料都是合成測試資料（非真實 Node／run）。
import { describe, expect, it } from "vitest";
import { addRecent, parseRecents, RECENTS_MAX, type RecentEntry } from "./recents";

describe("最近開啟", () => {
  const entry = (to: string, title = to, at = 0): RecentEntry => ({ to, title, kind: "page", at });

  it("新項目放最前面、依 to 去重、最多 8 筆", () => {
    let list: RecentEntry[] = [];
    for (let index = 0; index < 10; index += 1) list = addRecent(list, entry(`/records/runs/r${String(index)}`));
    expect(list).toHaveLength(RECENTS_MAX);
    expect(list[0]?.to).toBe("/records/runs/r9");
    list = addRecent(list, entry("/records/runs/r5", "再次開啟"));
    expect(list[0]).toMatchObject({ to: "/records/runs/r5", title: "再次開啟" });
    expect(list.filter((recent) => recent.to === "/records/runs/r5")).toHaveLength(1);
    // 站外路徑不收
    expect(addRecent([], entry("https://example.com/"))).toEqual([]);
  });

  it("容錯解析：非陣列、站外路徑、欄位錯誤都略過；依 to 去重、保序", () => {
    expect(parseRecents(null)).toEqual([]);
    expect(parseRecents({ to: "/records/runs" })).toEqual([]);
    const raw = JSON.parse(JSON.stringify([
      { to: "/records/runs", title: "執行紀錄", kind: "page", at: 5 },
      { to: "/records/runs", title: "重複", kind: "page", at: 6 },
      { to: "/records/recordings/r1?tab=parts#x", title: "紀錄連結", kind: "page", at: 4 },
      { to: "//evil.example/admin", title: "外部" },
      { to: "https://evil.example/", title: "外部" },
      { to: "/elsewhere", title: "非本產品路徑" },
      { to: "/admin/x y", title: "含空白" },
      { to: "/studio/edit?project=p1", title: "  " },
      { to: "/studio/edit?project=p2", title: "專案", kind: "weird" },
      "garbage",
      { to: "/inference/run?pipeline=t2va-local", title: "推理 Studio・手動執行", kind: "page", at: 3 },
      { to: "/image?project=p1", title: "Image Studio", kind: "page", at: 2 },
      { to: "/imagex", title: "非本產品路徑" },
    ])) as unknown;
    expect(parseRecents(raw)).toEqual([
      { to: "/records/runs", title: "執行紀錄", kind: "page", at: 5 },
      { to: "/records/recordings/r1?tab=parts#x", title: "紀錄連結", kind: "page", at: 4 },
      { to: "/studio/edit?project=p2", title: "專案", kind: "page", at: 0 },
      { to: "/inference/run?pipeline=t2va-local", title: "推理 Studio・手動執行", kind: "page", at: 3 },
      { to: "/image?project=p1", title: "Image Studio", kind: "page", at: 2 },
    ]);
  });
});
