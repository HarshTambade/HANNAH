import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { WORKFLOW_TEMPLATES } from "../components/workflows/templates";

// Every template must be a workflow the server engine accepts: real step types,
// valid expressions and connections. The only problems allowed are the saved
// credentials a template says you need (they're yours to choose).
const require = createRequire(import.meta.url);
const { validateWorkflow } = require("../../../server/workflows/engine.js") as { validateWorkflow: (definition: unknown) => { errors: Array<{ message: string }> } };

describe("workflow templates", () => {
  for (const template of WORKFLOW_TEMPLATES) {
    it(`“${template.name}” validates on the server engine`, () => {
      const needs = template.needs.join(" ").toLowerCase();
      const problems = validateWorkflow(template.build()).errors.map((error) => error.message).filter((message) => {
        if (/^Choose a \w+ credential\.$/.test(message)) return false;
        // A field left for you to fill in is fine only when the template says you need to.
        const blank = /^(.+?)(?: \(.*\))? is required\.$/.exec(message);
        return !(blank && needs.includes(blank[1].toLowerCase()));
      });
      expect(problems).toEqual([]);
    });
  }

  it("the invoice email template starts from the New email trigger", () => {
    const invoice = WORKFLOW_TEMPLATES.find((template) => template.id === "invoice-email")!;
    expect(invoice.build().nodes[0].type).toBe("trigger.email");
  });
});
