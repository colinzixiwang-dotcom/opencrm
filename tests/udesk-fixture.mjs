import { createServer } from "node:http";
import { createHash } from "node:crypto";
export async function startUdeskMock() {
  const own = {
    id: 101,
    field_num: "#101",
    subject: "Device support 中文",
    content:
      "<p>Device stops printing.</p><script>window.sourceScriptExecuted=true</script>",
    content_type: "html",
    user_name: "Customer",
    user_email: "private@example.com",
    assignee_id: 11,
    assignee_name: "Agent One",
    user_group_id: 7,
    user_group_name: "Support",
    template_id: 1,
    priority: "高",
    status: "Pending",
    status_en: "solving_55",
    platform: "邮件",
    custom_fields: {
      TextField_1: "ORDER-101",
      TextField_3: "",
      TextField_4: null,
      TextField_5: [],
      TextField_6: {},
      TextField_7: "—",
      TextField_8: "   ",
      TextField_9: false,
      TextField_10: 0,
      SelectField_2: ["0"],
      UnknownField: { nested: ["preserve", "me"] },
    },
    custom_fields_v2: {
      TextField_1: "ORDER-101",
      TextField_11: "Only v2 field",
    },
    attachments: [],
    created_at: "2026-10-01T10:00:00Z",
    updated_at: "2026-10-16T10:00:00Z",
  };
  const tickets = [
    own,
    {
      ...own,
      id: 102,
      field_num: "#102",
      subject: "OTHER-AGENT-PRIVATE",
      assignee_id: 22,
      user_group_id: 8,
    },
    {
      ...own,
      id: 103,
      field_num: "#103",
      subject: "Unassigned group ticket",
      assignee_id: null,
    },
    { ...own, id: 104, field_num: "#104", subject: "Second own ticket" },
  ];
  const fields = [
    {
      id: 1,
      field_name: "TextField_1",
      field_label: "Order Number",
      content_type: "text",
    },
    {
      id: 2,
      field_name: "SelectField_2",
      field_label: "Issue category",
      content_type: "droplist",
      options: [{ value: "0", title: "Hardware fault" }],
    },
    ...Array.from({ length: 28 }, (_, i) => ({
      id: i + 3,
      field_name: `TextField_${i + 3}`,
      field_label: `Custom ${i + 3}`,
      content_type: "text",
    })),
  ];
  const state = {
    tickets,
    fields,
    requests: [],
    fail: false,
    filterIds: [],
    nonce: new Set(),
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://mock");
    const p = url.pathname.replace("/open_api_v1/", "");
    const q = url.searchParams;
    state.requests.push(p);
    const expected = createHash("sha256")
      .update(
        [
          "admin@mock.local",
          "mock-token",
          q.get("timestamp"),
          q.get("nonce"),
          "v2",
        ].join("&"),
      )
      .digest("hex");
    if (q.get("sign") !== expected || state.nonce.has(q.get("nonce"))) {
      res.writeHead(403);
      res.end();
      return;
    }
    state.nonce.add(q.get("nonce"));
    res.setHeader("Content-Type", "application/json");
    if (state.fail) {
      res.writeHead(503);
      res.end(JSON.stringify({ code: 5000 }));
      return;
    }
    let data = { code: 1000 };
    if (p === "agents")
      data.agents = [
        {
          id: 11,
          email: "one@mock.local",
          nick_name: "Agent One",
          role_name: "agent",
          disable_status: "enable",
          user_group_ids: [7],
        },
        {
          id: 22,
          email: "two@mock.local",
          nick_name: "Agent Two",
          role_name: "custom unknown",
          disable_status: "enable",
          user_group_ids: [8],
        },
        {
          id: 33,
          email: "disabled@mock.local",
          nick_name: "Disabled",
          role_name: "agent",
          disable_status: "disable",
          user_group_ids: [],
        },
      ];
    else if (p === "user_groups")
      data.user_groups = [
        { id: 7, name: "Support" },
        { id: 8, name: "Other team" },
      ];
    else if (p === "agent_roles") data.agent_roles = [{ id: 1, name: "agent" }];
    else if (p === "custom_fields") data.fields = fields;
    else if (p === "tickets/status")
      data.status = [{ status_id: 55, name: "Pending", en_name: "solving_55" }];
    else if (p === "tickets/ticket_templates")
      data.templates = [
        {
          id: 1,
          name: "Support",
          custom_fields: fields.map((f) => ({
            field_name: f.field_name,
            field_title: f.field_label,
          })),
        },
      ];
    else if (p === "tickets/filters")
      data.filters = [
        { id: 10, name: "All source tickets", permission: "All" },
        { id: 10, name: "All source tickets", permission: "All" },
        { id: 11, name: "Pending source tickets", permission: "All" },
        {
          id: 12,
          name: "Other private filter",
          permission: "User",
          permission_id: 22,
        },
      ];
    else if (p === "tickets" || p === "tickets/tickets_in_filter") {
      const filter = q.get("filter_id");
      if (filter) state.filterIds.push(filter);
      const page = Number(q.get("page") || 1);
      const result = filter === "11" ? tickets.slice(0, 1) : tickets;
      data.contents = page === 1 ? result.map((ticket) => ({ ticket })) : [];
    } else if (p === "tickets/detail")
      data.ticket = tickets.find(
        (t) => String(t.id) === q.get("id") || t.field_num === q.get("num"),
      );
    else if (/tickets\/\d+\/replies/.test(p))
      data.replies = [
        {
          id: 1,
          content: "Internal case context",
          content_format: "text",
          function_type: "internat",
          author: { nick_name: "Agent One" },
          created_at: "2026-10-16T10:00:00Z",
          attachments: [],
        },
      ];
    else data = { code: 2000 };
    data.meta = {
      current_page: 1,
      total_pages: 1,
      total_count: data.contents?.length || 0,
    };
    res.end(JSON.stringify(data));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    ...state,
    state,
    base: `http://127.0.0.1:${server.address().port}`,
    env: {
      UDESK_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      UDESK_ADMIN_EMAIL: "admin@mock.local",
      UDESK_OPEN_API_TOKEN: "mock-token",
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
