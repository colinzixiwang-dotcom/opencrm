import test from "node:test";
import assert from "node:assert/strict";
import {
  tr,
  setLanguage,
  getLanguage,
  statusTitle,
  intlLocale,
  subscribeLanguage,
} from "../frontend/src/i18n.js";
test("language changes labels and formatting without changing persistent codes or user data", () => {
  setLanguage("en");
  assert.equal(tr("Create RMA"), "Create RMA");
  assert.equal(statusTitle("in_progress"), "In Progress");
  let notified = 0;
  const unsubscribe = subscribeLanguage(() => notified++);
  setLanguage("zh-CN");
  assert.equal(getLanguage(), "zh-CN");
  assert.equal(intlLocale(), "zh-CN");
  assert.equal(tr("Create RMA"), "创建 RMA");
  assert.equal(statusTitle("in_progress"), "进行中");
  assert.equal(tr("Custom customer ABC"), "Custom customer ABC");
  assert.equal(tr("SKU-1080-A"), "SKU-1080-A");
  assert.equal(tr("constructor"), "constructor");
  assert.equal(tr("__proto__"), "__proto__");
  assert.equal(
    tr(
      "Warranty has expired. Choose a solution that does not require warranty coverage.",
    ),
    "质保已过期，请选择无需质保的方案。",
  );
  assert.equal(
    tr("Warranty months must be a whole number between 1 and 120."),
    "质保月数必须为 1 到 120 之间的整数。",
  );
  assert.equal(
    tr("{solution} · Created by {owner} · {date}", {
      solution: "更换",
      owner: "Jane",
      date: "2026-10-16",
    }),
    "更换 · 创建人 Jane · 2026-10-16",
  );
  assert.equal(tr(" By task "), " 按任务 ");
  assert.equal(notified, 1);
  unsubscribe();
  setLanguage("en");
  assert.equal(tr("Warranty rules"), "Warranty rules");
});
test("unsupported locale cannot change language and storage failures do not prevent switching", () => {
  setLanguage("en");
  setLanguage("xx");
  assert.equal(getLanguage(), "en");
  setLanguage("zh-CN");
  assert.equal(getLanguage(), "zh-CN");
  setLanguage("en");
});
