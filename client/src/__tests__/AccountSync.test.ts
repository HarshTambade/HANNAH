import { describe, expect, it } from "vitest";
import { mergeLists, mergeObjects } from "../services/AccountSync";

const id = (item: Record<string, unknown>) => item.id as string;
const at = (item: Record<string, unknown>) => Number(item.at) || 0;

describe("AccountSync three-way merge", () => {
  it("keeps additions from both sides", () => {
    const merged = mergeLists([], [{ id: "a" }], [{ id: "b" }], id);
    expect(merged.map(id).sort()).toEqual(["a", "b"]);
  });

  it("applies a deletion made on one side when the other side didn't change the item", () => {
    const base = [{ id: "a", v: 1 }, { id: "b", v: 1 }];
    expect(mergeLists(base, [{ id: "b", v: 1 }], base, id).map(id)).toEqual(["b"]);
    expect(mergeLists(base, base, [{ id: "a", v: 1 }], id).map(id)).toEqual(["a"]);
  });

  it("keeps an item edited on one side even if the other side deleted it", () => {
    const base = [{ id: "a", v: 1 }];
    expect(mergeLists(base, [{ id: "a", v: 2 }], [], id)).toEqual([{ id: "a", v: 2 }]);
  });

  it("takes the remote edit when only the remote changed", () => {
    const base = [{ id: "a", v: 1 }];
    expect(mergeLists(base, base, [{ id: "a", v: 3 }], id)).toEqual([{ id: "a", v: 3 }]);
  });

  it("resolves edits on both sides by the newer timestamp", () => {
    const base = [{ id: "a", v: 1, at: 1 }];
    expect(mergeLists(base, [{ id: "a", v: 2, at: 5 }], [{ id: "a", v: 3, at: 9 }], id, at)).toEqual([{ id: "a", v: 3, at: 9 }]);
    expect(mergeLists(base, [{ id: "a", v: 2, at: 9 }], [{ id: "a", v: 3, at: 5 }], id, at)).toEqual([{ id: "a", v: 2, at: 9 }]);
  });

  it("merges preference objects key by key", () => {
    const base = { budget: "1", strictness: "standard" };
    const local = { budget: "2", strictness: "standard" };
    const remote = { budget: "1", strictness: "strict", provider: "groq" };
    expect(mergeObjects(base, local, remote)).toEqual({ budget: "2", strictness: "strict", provider: "groq" });
    expect(mergeObjects({ budget: "1" }, {}, { budget: "1" })).toEqual({});
  });
});
