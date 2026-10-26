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
    if (b.api === "stock-do-search-sku-list-new") {
      res.end(
        JSON.stringify({
          code: 200,
          data: {
            data: [
              {
                id: "1",
                stockSku: "MORPHO-TEST",
                nameCN: "Original unit A",
                nameEN: "Original unit A",
                status: "5",
                salesSku: "DEVICES",
                virtualSku: ["OLD-ALIAS"],
                warehouse: [],
              },
              {
                id: "2",
                stockSku: "REPLACEMENT-B",
                nameCN: "Replacement unit B",
                status: "3",
                virtualSku: [],
                warehouse: [],
              },
              {
                id: "3",
                stockSku: "PART-B",
                nameCN: "Replacement part B",
                status: "3",
                virtualSku: [],
                warehouse: [],
              },
              {
                id: "4",
                stockSku: "PART-C",
                nameCN: "Replacement part C",
                status: "3",
                virtualSku: [],
                warehouse: [],
              },
              {
                id: "5",
                stockSku: "SHIPPING-FEE",
                nameCN: "Shipping fee",
                status: "3",
                virtualSku: [],
                warehouse: [],
              },
            ],
            nextCursor: "",
          },
        }),
      );
      return;
    }
    if (b.api === "stock-get-stock-quantity") {
      const data = b.data.stockSkus.split(",").map((stockSku) => ({
        stockSku,
        warehouse: [
          {
            warehouseId: "1",
            warehouseName: "Main warehouse",
            stockQuantity: 12,
            availableStockQuantity: 10,
            waitingQuantity: 2,
            shippingQuantity: 3,
            allotShippingQuantity: 0,
          },
        ],
      }));
      res.end(
        JSON.stringify({
          code: 200,
          data: { data, count: data.length, page: 1 },
        }),
      );
      return;
    }
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
      buyerName: "Test Buyer",
      buyerEmail: "fixture@example.com",
      buyerPhone: "+1 202 555 0100",
      buyerMobile: "+1 202 555 0101",
      buyerCity: "Test City",
      buyerAddress1: "100 Test Road",
      remark: "<script>unsafe</script>",
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
          hasNext: false,
          nextCursor: "terminal-cursor",
          list:
            (b.data.paidTime === "2025-01-01" ||
              b.data.platformOrderId === "ERP-HISTORY") &&
            b.data.canSend === "1"
              ? [
                  {
                    ...order("HISTORY-1"),
                    platformId: "16",
                    erpOrderId: "source-history",
                    platformOrderId: "ERP-HISTORY",
                    paidTime: "2025-01-01 10:00:00",
                  },
                ]
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
