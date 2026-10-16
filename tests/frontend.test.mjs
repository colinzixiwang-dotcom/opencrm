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

test("mail text normalization collapses empty lines without losing paragraphs or zero", async () => {
  const { normalizeMessage } =
    await import("../frontend/src/ticket-content.js");
  assert.equal(
    normalizeMessage("  Hello\r\n\r\n \t\r\nWorld\u00a0 \n  Last line  "),
    "Hello\n\nWorld\nLast line",
  );
  assert.equal(normalizeMessage(0), "0");
});

test("ticket presentation folds only fully represented submissions and preserves unknown content", async () => {
  const { problemPresentation, customValues, isInitialSubmission } =
    await import("../frontend/src/ticket-presentation.js");
  const metadata = {
    fields: {
      fields: [
        { field_name: "problem", field_label: "Problem Description" },
        { field_name: "order", field_label: "Order Number" },
      ],
    },
  };
  const ticket = {
    custom_fields: { problem: "My device stopped.", order: "ORDER-9" },
    custom_fields_v2: { extra: false },
    user_id: 7,
    created_at: "2026-10-01T10:00:00Z",
  };
  const original =
    "Original customer submission: Order Number: ORDER-9 Problem Description: My device stopped.";
  assert.equal(
    problemPresentation(ticket, metadata, original).text,
    "My device stopped.",
  );
  assert.equal(
    problemPresentation(ticket, metadata, original).original,
    original,
  );
  assert.equal(
    problemPresentation(
      ticket,
      metadata,
      original + " Extra shipping instruction",
    ).text,
    original + " Extra shipping instruction",
  );
  assert.equal(customValues(ticket).extra, false);
  const reply = {
    author: { id: 7, user_type: "customer" },
    created_at: "2026-10-01T10:00:30Z",
  };
  assert.equal(isInitialSubmission(reply, ticket, original, original), true);
  assert.equal(
    isInitialSubmission(
      { ...reply, function_type: "internal" },
      ticket,
      original,
      original,
    ),
    false,
  );
  assert.equal(
    isInitialSubmission(
      { ...reply, author: { id: 8 } },
      ticket,
      original,
      original,
    ),
    false,
  );
  assert.equal(
    isInitialSubmission(
      { ...reply, created_at: "2026-10-02T10:00:30Z" },
      ticket,
      original,
      original,
    ),
    false,
  );
  assert.equal(
    isInitialSubmission(
      { ...reply, created_at: null },
      ticket,
      original,
      original,
    ),
    false,
  );
});

test("structured descriptions match mail HTML whitespace and select labels without erasing unknown digits", async () => {
  const { problemPresentation } =
    await import("../frontend/src/ticket-presentation.js");
  const metadata = {
    fields: {
      fields: [
        { field_name: "p", field_label: "Problem Description" },
        {
          field_name: "c",
          field_label: "Primary Category",
          options: [{ value: "0", title: "Order" }],
        },
      ],
    },
  };
  const ticket = {
    custom_fields: { p: "First line.\r\nSecond line.", c: "0" },
  };
  const original =
    "Original customer submission:\nPrimary Category: Order\nFirst line.\n\nSecond line.";
  assert.equal(
    problemPresentation(ticket, metadata, original).text,
    ticket.custom_fields.p,
  );
  assert.equal(
    problemPresentation(ticket, metadata, original + " 0").original,
    "",
  );
});

test("problem reading separates explicit multiple issues and a known contact suffix without guessing", async () => {
  const { structureProblem } =
    await import("../frontend/src/ticket-presentation.js");
  const text =
    "I paid twice. That is the first issue. The second is I want to cancel. Thank you. Jane Doe jane@example.com\n46 Example St\nExample City CT 06489\n860-517-9197";
  const result = structureProblem(text, {
    user_name: "Jane Doe",
    user_email: "jane@example.com",
  });
  assert.equal(result.numbered, true);
  assert.equal(result.paragraphs.length, 2);
  assert.ok(result.paragraphs[1].includes("The second is I want to cancel."));
  assert.equal(result.contacts[0].label, "Submitted address");
  assert.ok(result.contacts[0].value.includes("46 Example St"));
  assert.equal(result.contacts[1].value, "860-517-9197");
  assert.equal(result.reformatted, true);
  const unknown = text + "\nPlease call after 6pm.";
  const unchanged = structureProblem(unknown, {
    user_name: "Jane Doe",
    user_email: "jane@example.com",
  });
  assert.equal(unchanged.contacts.length, 0);
  assert.ok(unchanged.paragraphs.join(" ").includes("Please call after 6pm."));
  const prose = "Please write to jane@example.com about the pending order.";
  assert.equal(
    structureProblem(prose, { user_email: "jane@example.com" }).paragraphs[0],
    prose,
  );
});
