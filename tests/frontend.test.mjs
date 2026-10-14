import test from "node:test";
import assert from "node:assert/strict";
import { normalizeWorkspace } from "../frontend/src/state.js";
test("legacy null dependencies and missing collections normalize without altering saved data", () => {
  const input = {
    supportConfig: {
      solutions: [{ id: "starter", nodes: [{ key: "a", dependsOn: null }] }],
      rootCauses: [{ productIds: null }],
      fields: [{ options: null }],
    },
    rmas: [{ solutionSnapshot: { nodes: [{ key: "old", dependsOn: null }] } }],
    rmaTasks: [{ dependsOn: null, events: null }],
  };
  const out = normalizeWorkspace(input);
  assert.deepEqual(out.supportConfig.solutions[0].nodes[0].dependsOn, []);
  assert.deepEqual(out.rmas[0].solutionSnapshot.nodes[0].dependsOn, []);
  assert.deepEqual(out.rmaTasks[0].events, []);
  assert.deepEqual(out.serials, []);
  assert.equal(input.supportConfig.solutions[0].nodes[0].dependsOn, null);
});
test("normalization preserves configured graph edges and existing values", () => {
  const s = {
    supportConfig: {
      revision: 9,
      solutions: [
        {
          nodes: [
            { key: "a", dependsOn: [] },
            { key: "b", dependsOn: ["a"] },
          ],
        },
      ],
    },
    rmas: [{ id: "r", customFields: { flag: "kept" } }],
  };
  const n = normalizeWorkspace(s);
  assert.equal(n.supportConfig.revision, 9);
  assert.deepEqual(n.supportConfig.solutions[0].nodes[1].dependsOn, ["a"]);
  assert.equal(n.rmas[0].customFields.flag, "kept");
});
