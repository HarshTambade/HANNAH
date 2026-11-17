import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { AUTOMATION } from "../content/landing";

// The site's integration list must match the engine: every listed step exists, with the same status.
const require = createRequire(import.meta.url);
const { REGISTRY } = require("../../../server/workflows/nodes.js") as { REGISTRY: Map<string, { status: string; label: string }> };

describe("landing automation content", () => {
  it("names only steps the workflow engine has, with their real status", () => {
    for (const item of AUTOMATION.integrations) {
      const node = REGISTRY.get(item.type);
      expect(node, `${item.name} (${item.type}) isn't a workflow node`).toBeTruthy();
      expect(item.status, `${item.name} is listed as ${item.status} but the engine says ${node!.status}`).toBe(node!.status);
    }
  });
});
