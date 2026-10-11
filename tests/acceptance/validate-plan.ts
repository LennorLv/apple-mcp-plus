import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import tools from "../../tools.js";

interface Case {
  id: string;
  tool: string;
  behavior: string;
  kind: string;
  call: { name: string; arguments: Record<string, unknown> };
  setup: string;
  steps: string[];
  expected: string[];
  requiredVariants: string[];
  status: string;
}

// Design coverage only. This script never starts the server or calls Apple apps.
const baseline = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8")) as {
  cases: Case[];
};
const extension = JSON.parse(readFileSync(new URL("./eventkit-cases.json", import.meta.url), "utf8")) as {cases:Case[]};
const plan={cases:[...baseline.cases,...extension.cases]};
const ids = new Set<string>();
const behaviors = new Set<string>();
const fieldsCovered = new Map<string, Set<string>>();

for (const entry of plan.cases) {
  assert(!ids.has(entry.id), `Duplicate case ID: ${entry.id}`);
  ids.add(entry.id);
  const tool = tools.find((item) => item.name === entry.tool);
  assert(tool, `Unknown tool: ${entry.tool}`);
  assert.equal(entry.call.name, entry.tool, `${entry.id}: call tool mismatch`);
  assert.equal(entry.status, "NOT_RUN", `${entry.id}: design must not claim execution`);
  assert(entry.setup && entry.kind, `${entry.id}: missing setup or kind`);
  for (const key of ["steps", "expected", "requiredVariants"] as const) {
    assert(entry[key].length > 0, `${entry.id}: missing ${key}`);
  }
  const schema = tool.inputSchema as {
    required?: string[];
    properties: Record<string, {
      type: string; enum?: unknown[]; minimum?: number; maximum?: number;
    }>;
  };
  for (const field of schema.required ?? []) {
    assert(field in entry.call.arguments, `${entry.id}: missing required ${field}`);
  }
  for (const [field, value] of Object.entries(entry.call.arguments)) {
    const definition = schema.properties[field];
    assert(definition, `${entry.id}: unknown argument ${field}`);
    const actualType = Array.isArray(value) ? "array" : typeof value;
    assert(
      definition.type === "integer"
        ? typeof value === "number" && Number.isInteger(value)
        : actualType === definition.type,
      `${entry.id}: incorrect type for ${field}`,
    );
    if (definition.enum) {
      assert(definition.enum.includes(value), `${entry.id}: invalid enum for ${field}`);
    }
    if (typeof value === "number") {
      if (definition.minimum !== undefined) assert(value >= definition.minimum);
      if (definition.maximum !== undefined) assert(value <= definition.maximum);
    }
  }
  const operations = schema.properties.operation?.enum;
  if (entry.tool==="contacts" && ["list","search"].includes(entry.behavior)) {
    assert.equal("name" in entry.call.arguments, entry.behavior === "search");
  } else if (operations) {
    assert(operations.includes(entry.behavior), `${entry.id}: unknown behavior`);
    assert.equal(entry.call.arguments.operation, entry.behavior);
  } else {
    assert.equal(entry.tool, "contacts");
    assert(["list", "search"].includes(entry.behavior));
    assert.equal("name" in entry.call.arguments, entry.behavior === "search");
  }
  const behaviorKey = `${entry.tool}.${entry.behavior}`;
  assert(!behaviors.has(behaviorKey), `Duplicate behavior: ${behaviorKey}`);
  behaviors.add(behaviorKey);
  const covered = fieldsCovered.get(entry.tool) ?? new Set<string>();
  Object.keys(entry.call.arguments).forEach((field) => covered.add(field));
  fieldsCovered.set(entry.tool, covered);
}

for (const tool of tools) {
  const schema = tool.inputSchema as { properties: Record<string, { enum?: string[] }> };
  const expected = tool.name==="contacts"?["list","search",...(schema.properties.operation?.enum||[])]:schema.properties.operation?.enum ?? ["list", "search"];
  for (const behavior of expected) {
    assert(behaviors.has(`${tool.name}.${behavior}`), `Missing ${tool.name}.${behavior}`);
  }
  for (const field of Object.keys(schema.properties)) {
    assert(fieldsCovered.get(tool.name)?.has(field), `Missing parameter example: ${tool.name}.${field}`);
  }
}

console.log(JSON.stringify({
  check: "design-coverage-only",
  tools: tools.length,
  behaviors: behaviors.size,
  cases: plan.cases.length,
  baselineCases:baseline.cases.length,
  extensionCases:extension.cases.length,
  requiredVariantItems: plan.cases.reduce((sum, entry) => sum + entry.requiredVariants.length, 0),
  parameterExamples: Object.fromEntries(
    [...fieldsCovered].map(([tool, fields]) => [tool, fields.size]),
  ),
  functionalTestsExecuted: 0,
  result: "PASS",
}, null, 2));
