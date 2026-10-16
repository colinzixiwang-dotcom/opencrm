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
    if (url.pathname === "/preview/example.svg") {
      res.setHeader("Content-Type", "image/svg+xml");
      res.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="#edf3e8"/><rect x="80" y="80" width="640" height="340" rx="24" fill="#285d4b"/><text x="400" y="240" text-anchor="middle" fill="#e9f5c6" font-size="38" font-family="sans-serif">Attachment preview</text><text x="400" y="300" text-anchor="middle" fill="white" font-size="22" font-family="sans-serif">Udesk fixture image</text></svg>',
      );
      return;
    }
    if (url.pathname === "/preview/manual.pdf") {
      const stream = "BT /F1 24 Tf 40 200 Td (Attachment PDF preview) Tj ET\n";
      const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
      ];
      let pdf = "%PDF-1.4\n",
        offsets = [0];
      objects.forEach((object, i) => {
        offsets.push(Buffer.byteLength(pdf));
        pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
      });
      const xref = Buffer.byteLength(pdf);
      pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
      offsets.slice(1).forEach((offset) => {
        pdf += String(offset).padStart(10, "0") + " 00000 n \n";
      });
      pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
      res.setHeader("Content-Type", "application/pdf");
      res.end(pdf);
      return;
    }
    if (url.pathname.startsWith("/preview/")) {
      res.writeHead(404);
      res.end();
      return;
    }
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
          content:
            '<div style="text-align:center"><p>Internal case context</p>\n    <div><br><br><br><br></div><p>  Second paragraph.&nbsp;  </p><table><tr><td>Aligned</td><td>content</td></tr></table></div>',
          content_format: "html",
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
    if (/tickets\/\d+\/replies/.test(p)) {
      data.meta = {
        current_page: Number(q.get("page") || 1),
        total_pages: 2,
        total_count: 21,
      };
      if (q.get("page") === "2")
        data.replies = [
          {
            id: 2,
            content: "Second conversation page",
            content_format: "text",
            author: { nick_name: "Agent One" },
            created_at: "2026-10-16T11:00:00Z",
          },
        ];
    }
    if (/tickets\/\d+\/replies/.test(p) && state.replyOverride) {
      data.replies = state.replyOverride;
      data.meta = {
        current_page: 1,
        total_pages: 1,
        total_count: data.replies.length,
      };
    }
    res.end(JSON.stringify(data));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const previewBase = `http://127.0.0.1:${server.address().port}`;
  own.attachments.push(
    {
      url: previewBase + "/preview/example.svg",
      file_name: "device-photo.svg",
      content_type: "image/svg+xml",
    },
    { url: previewBase + "/preview/missing.jpg", file_name: "missing.jpg" },
    {
      url: previewBase + "/preview/manual.pdf",
      file_name: "manual.pdf",
      content_type: "application/pdf",
    },
    { url: "javascript:alert(1)", file_name: "unsafe.html" },
  );
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
