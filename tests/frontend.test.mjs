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

test("API presentation separates source fields and description while retaining the original", async () => {
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
    platform: "API",
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
    "My device stopped.",
  );
  assert.ok(
    problemPresentation(
      ticket,
      metadata,
      original + " Extra shipping instruction",
    ).original.includes("Extra shipping instruction"),
  );
  assert.deepEqual(
    problemPresentation({ ...ticket, platform: "邮件" }, metadata, original),
    { text: original, original: "", omitted: [], fields: [] },
  );
  assert.ok(
    problemPresentation(ticket, metadata, original).fields.some(
      (field) => field.name === "extra" && field.value === false,
    ),
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
    platform: "API",
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
    original + " 0",
  );
});

test("legacy API fields use explicit Udesk labels while email prose remains intact", async () => {
  const { problemPresentation } =
    await import("../frontend/src/ticket-presentation.js");
  const metadata = {
    fields: { fields: [{ field_name: "order", field_label: "Order Number" }] },
  };
  const text =
    "Original customer submission:\nOrder Number: 1486\nPlease cancel my order.\nCall only after 6pm.";
  const result = problemPresentation({ platform: "API" }, metadata, text);
  assert.equal(result.fields[0].value, "1486");
  assert.equal(result.text, "Please cancel my order.\nCall only after 6pm.");
  assert.equal(result.original, text);
  assert.equal(
    problemPresentation({ platform: "邮件" }, metadata, text).text,
    text,
  );
});

test("API body fallback cannot duplicate a populated field with an alternative Udesk definition", async () => {
  const { problemPresentation } =
    await import("../frontend/src/ticket-presentation.js");
  const metadata = {
    fields: {
      fields: [
        { field_name: "old", field_label: "Secondary Issue" },
        { field_name: "current", field_label: "Secondary Issue" },
        { field_name: "p", field_label: "Problem Description" },
      ],
    },
  };
  const result = problemPresentation(
    {
      platform: "API",
      custom_fields: { current: "Refund", p: "Please refund." },
    },
    metadata,
    "Original customer submission:\nSecondary Issue: Refund\nPlease refund.",
  );
  assert.equal(result.fields.length, 1);
  assert.equal(result.fields[0].name, "current");
});

import { syncTimestamp, ticketNumberQuery, ticketListIssue } from "../frontend/src/ticket-ui.js";
test("sync times use workspace day boundaries and do not expose malformed source dates", () => {
  const now = new Date("2026-10-19T01:00:00Z");
  const stamp = syncTimestamp("2026-10-18T23:23:00Z", "zh-CN", "Asia/Shanghai", now);
  assert.equal(stamp.short, "07:23");
  assert.match(stamp.full, /2026/);
  const previous = syncTimestamp("2026-10-18T10:00:00Z", "en-US", "Asia/Shanghai", now);
  assert.match(previous.short, /Oct/);
  assert.equal(syncTimestamp("not-an-iso-date", "en-US"), null);
  assert.equal(syncTimestamp("", "en-US"), null);
});
test("only a complete ticket number offers an explicit live lookup", () => {
  assert.equal(ticketNumberQuery(" #717 "), "717");
  assert.equal(ticketNumberQuery("717"), "717");
  for (const query of ["Order 717", "#717 extra", "-1", "", "9".repeat(21)])
    assert.equal(ticketNumberQuery(query), null);
});

test("queue failures use safe recovery messages for permissions and source failures", () => {
  assert.equal(ticketListIssue(null), null);
  assert.equal(ticketListIssue({status:401}), "session");
  assert.equal(ticketListIssue({status:403,message:"This Udesk filter is not available to your account."}), "filter");
  assert.equal(ticketListIssue({status:403,message:"Your account is not mapped to an active Udesk agent."}), "mapping");
  assert.equal(ticketListIssue({status:403,message:"private detail"}), "permission");
  assert.equal(ticketListIssue({status:502,message:"2026-10-19T00:00:00Z source failed"}), "unavailable");
});
