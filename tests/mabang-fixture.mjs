import { createServer } from "node:http";
import { createHmac } from "node:crypto";
export async function startMabangMock() {
  const calls = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (
      req.headers.authorization !==
      createHmac("sha256", "fixture-token").update(raw).digest("hex")
    ) {
      res.writeHead(403);
      res.end();
      return;
    }
    const b = JSON.parse(raw);
    calls.push(b);
    res.setHeader("Content-Type", "application/json");
    const number = b.data.salesRecordNumbers;
    const order = (platformNumber, sku = "MORPHO-TEST") => ({
      erpOrderId: "source-1",
      platformOrderId: "ERP-ORIGINAL",
      salesRecordNumber: platformNumber,
      platformId: "Amazon",
      shopName: "Morpho Shop",
      orderStatus: "3",
      paidTime: "2026-09-01 10:00:00",
      expressTime: "2026-09-02 10:00:00",
      currencyId: "USD",
      itemTotalOrigin: "159.00",
      countryCode: "US",
      orderItem: [
        {
          orderItemId: "item-1",
          stockSku: sku,
          title: sku === "MORPHO-TEST" ? "Morpho device" : "ColorBox",
          quantity: "1",
        },
      ],
    });
    if (b.api === "order-get-order-list-new") {
      res.end(
        JSON.stringify({
          code: 200,
          data: {
            data: ["ORDER-101", "COLORBOX"].includes(number)
              ? [
                  order(
                    number,
                    number === "COLORBOX"
                      ? "ColorBox_2Base_StarterKit_Vivid"
                      : "MORPHO-TEST",
                  ),
                ]
              : [],
            hasNext: false,
          },
        }),
      );
      return;
    }
    if (b.api !== "get-history-order-list") {
      res.writeHead(400);
      res.end();
      return;
    }
    res.end(
      JSON.stringify({
        code: 200,
        data: {
          list:
            b.data.paidTime === "2025-01-01" && b.data.canSend === "1"
              ? [order("HISTORY-1")]
              : [],
        },
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    calls,
    env: {
      MABANG_APPKEY: "fixture-key",
      MABANG_APPTOKEN: "fixture-token",
      MABANG_TEST_URL: `http://127.0.0.1:${server.address().port}`,
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
