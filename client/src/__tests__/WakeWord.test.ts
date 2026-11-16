import { describe, expect, it, vi } from "vitest";
import { gunzipSync } from "node:zlib";

vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "android" } }));
vi.mock("../services/api", () => ({ apiUrl: (path: string) => `https://hannah.example${path}` }));

import { downsample, heardWakePhrase, WAKE_MODEL_PATH, wakeModelUrl } from "../services/WakeWord";
import { makeTarGz } from "../../scripts/wakeModel";

describe("wake phrase", () => {
  it("triggers only on 'hey hannah' said together", () => {
    expect(heardWakePhrase("hey hannah")).toBe(true);
    expect(heardWakePhrase("[unk] hey hannah [unk]")).toBe(true);
    expect(heardWakePhrase("Hey, Hannah!")).toBe(true);
    expect(heardWakePhrase("hannah [unk]")).toBe(false);
    expect(heardWakePhrase("hey [unk]")).toBe(false);
    expect(heardWakePhrase("hannah hey")).toBe(false);
    expect(heardWakePhrase("")).toBe(false);
  });
});

describe("audio for the model", () => {
  it("downsamples 48 kHz to 16 kHz by averaging", () => {
    const input = Float32Array.from({ length: 12 }, (_, index) => index);
    expect([...downsample(input, 48_000, 16_000)]).toEqual([1, 4, 7, 10]);
    expect(downsample(input, 16_000, 16_000)).toHaveLength(12);
  });

  it("the apps download the model from the HANNAH website", () => {
    expect(wakeModelUrl()).toBe(`https://hannah.example${WAKE_MODEL_PATH}`);
  });
});

describe("model archive", () => {
  it("writes folders before files, as the in-browser extractor needs", () => {
    const tar = gunzipSync(makeTarGz([{ name: "model/graph/phones/word_boundary.int", data: Buffer.from("1 nonword\n") }, { name: "model/am/final.mdl", data: Buffer.alloc(700, 1) }]));
    const entries: Array<[string, string, number]> = [];
    for (let offset = 0; offset + 512 <= tar.length;) {
      const name = tar.subarray(offset, offset + 100).toString("utf8").replace(/\0.*$/s, "");
      if (!name) break;
      const size = parseInt(tar.subarray(offset + 124, offset + 136).toString("utf8"), 8);
      entries.push([name, String.fromCharCode(tar[offset + 156]), size]);
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    expect(entries).toEqual([
      ["model/", "5", 0], ["model/am/", "5", 0], ["model/graph/", "5", 0], ["model/graph/phones/", "5", 0],
      ["model/graph/phones/word_boundary.int", "0", 10], ["model/am/final.mdl", "0", 700],
    ]);
  });
});
