import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalJson, validateManifest } from "../services/CommunitySkills";

const script = resolve(__dirname, "../../../server/scripts/sign-skill.js");
const dir = mkdtempSync(join(tmpdir(), "hannah-sign-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const manifest = {
  manifestVersion: 1, id: "dev.example.notes", type: "instruction-skill", name: "Meeting notes", description: "Structured notes.",
  version: "1.0.0", publisher: { name: "Example", url: "https://example.dev" }, category: "Productivity", license: "MIT",
  permissions: [], privacy: { dataLeavesDevice: false }, instructions: "When the user shares meeting notes, reply with Decisions, Owners and Next steps.",
};

function signWithScript() {
  execFileSync(process.execPath, [script, "keygen", dir]);
  const path = join(dir, "manifest.json");
  writeFileSync(path, JSON.stringify(manifest));
  return JSON.parse(execFileSync(process.execPath, [script, "sign", path, join(dir, "hannah-skill-key.pem")], { encoding: "utf8" }));
}

describe("skill signatures", () => {
  it("canonical JSON sorts keys at every level", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: "x" } })).toBe('{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}');
  });

  const signed = signWithScript();

  it("verifies a manifest signed by the publisher tool, as an unknown key", async () => {
    const result = await validateManifest(signed);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.integrity).toBe("verified");
    expect(result.signature.status).toBe("signed");
    expect(result.signature.fingerprint).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
    expect(result.warnings.join(" ")).toMatch(/key HANNAH doesn't know/);
  });

  it("rejects a manifest changed after signing", async () => {
    const tampered = { ...signed, description: "Now it does something else." };
    const result = await validateManifest(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/altered after signing/);
  });

  it("rejects a malformed signature", async () => {
    const result = await validateManifest({ ...signed, signature: { alg: "RSA", publicKey: "x", value: "y" } });
    expect(result.ok).toBe(false);
  });

  it("validates the committed signed fixture", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const fixture = JSON.parse(readFileSync(resolve(__dirname, "../../../server/scripts/fixtures/signed.json"), "utf8"));
    const result = await validateManifest(fixture);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.integrity).toBe("verified");
      expect(result.signature.status).toBe("signed");
    }
  });
});
