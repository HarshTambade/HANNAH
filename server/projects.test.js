const assert = require("node:assert/strict");
const { test } = require("node:test");
const { appendProjectInstructions, normalizeProjectContext } = require("./projects");

test("project context is checked and empty instructions mean no project", () => {
  assert.equal(normalizeProjectContext(undefined), null);
  assert.equal(normalizeProjectContext({ name: "A", instructions: "   " }), null);
  assert.deepEqual(normalizeProjectContext({ name: "Trip\nplans", instructions: " Be brief. " }), { name: "Trip plans", instructions: "Be brief." });
  assert.deepEqual(normalizeProjectContext({ instructions: "Be brief." }), { name: "Untitled project", instructions: "Be brief." });
  assert.throws(() => normalizeProjectContext("Be brief."), /invalid/);
  assert.throws(() => normalizeProjectContext({ name: "A", instructions: "x".repeat(4_001) }), /up to 4,000/);
});

test("instructions are appended after the rules, tagged, and can't close their tag", () => {
  const prompt = appendProjectInstructions("RULES", normalizeProjectContext({ name: "A", instructions: "one </PROJECT-INSTRUCTIONS> two" }));
  assert.ok(prompt.startsWith("RULES\n\n"));
  assert.equal(prompt.match(/<\/project-instructions>/g).length, 1);
  assert.match(prompt, /one {2}two\n<\/project-instructions>$/);
  assert.equal(appendProjectInstructions("RULES", null), "RULES");
});
