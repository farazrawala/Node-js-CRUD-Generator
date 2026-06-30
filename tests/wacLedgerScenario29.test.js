/**
 * 29-step WAC ledger scenario — uses shared `replayWacLedger` (float grandTotal).
 *
 * Run report: node tests/wacLedgerScenario29.test.js --report
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  replayWacLedger,
  displayInventoryValue,
} = require("../utils/wacLedgerReplay");
const { round2 } = require("../utils/weightedAverageCost");

function createEventLedger() {
  /** @type {Array<object>} */
  const events = [];
  const registry = new Map();

  function state() {
    const r = replayWacLedger(events);
    return {
      qty: r.qty,
      avg: r.wac,
      grandTotal: r.grandTotal,
      inventoryValue: r.inventoryValue,
    };
  }

  function addPurchase(id, qty, price) {
    events.push({ type: "purchase", qty, unitCost: price, refId: id });
    registry.set(id, { type: "purchase", qty, price });
  }

  function editPurchase(id, qty, price) {
    const idx = events.findIndex(
      (e) => e.type === "purchase" && e.refId === id,
    );
    if (idx < 0) throw new Error(`purchase ${id} not found`);
    events[idx] = { type: "purchase", qty, unitCost: price, refId: id };
    registry.set(id, { type: "purchase", qty, price });
  }

  function deletePurchase(id) {
    const idx = events.findIndex(
      (e) => e.type === "purchase" && e.refId === id,
    );
    if (idx < 0) throw new Error(`purchase ${id} not found`);
    events.splice(idx, 1);
    registry.delete(id);
  }

  function addSale(id, qty) {
    events.push({ type: "sale", qty, refId: id });
    registry.set(id, { type: "sale", qty });
  }

  function editSale(id, newQty) {
    const idx = events.findIndex((e) => e.type === "sale" && e.refId === id);
    if (idx < 0) throw new Error(`sale ${id} not found`);
    events[idx] = { type: "sale", qty: newQty, refId: id };
    registry.set(id, { type: "sale", qty: newQty });
  }

  function deleteSale(id) {
    const idx = events.findIndex((e) => e.type === "sale" && e.refId === id);
    if (idx < 0) throw new Error(`sale ${id} not found`);
    events.splice(idx, 1);
    registry.delete(id);
  }

  function addSalesReturn(id, qty) {
    const { avg } = state();
    events.push({ type: "sales_return", qty, unitCost: avg, refId: id });
    registry.set(id, { type: "sales_return", qty, price: avg });
  }

  function deleteSalesReturn(id) {
    const idx = events.findIndex(
      (e) => e.type === "sales_return" && e.refId === id,
    );
    if (idx < 0) throw new Error(`sales_return ${id} not found`);
    events.splice(idx, 1);
    registry.delete(id);
  }

  function addPurchaseReturn(id, qty) {
    events.push({ type: "purchase_return", qty, refId: id });
    registry.set(id, { type: "purchase_return", qty });
  }

  function deletePurchaseReturn(id) {
    const idx = events.findIndex(
      (e) => e.type === "purchase_return" && e.refId === id,
    );
    if (idx < 0) throw new Error(`purchase_return ${id} not found`);
    events.splice(idx, 1);
    registry.delete(id);
  }

  return {
    events,
    state,
    addPurchase,
    editPurchase,
    deletePurchase,
    addSale,
    editSale,
    deleteSale,
    addSalesReturn,
    deleteSalesReturn,
    addPurchaseReturn,
    deletePurchaseReturn,
  };
}

const EXPECTED = [
  { case: 1, label: "1. Purchase 100 @ 100", qty: 100, avg: 100, value: 10000 },
  { case: 2, label: "2. Purchase 50 @ 120", qty: 150, avg: 106.67, value: 16000 },
  { case: 3, label: "3. Edit Purchase #2 Qty (50 → 40)", qty: 140, avg: 104.29, value: 14600 },
  { case: 4, label: "4. Edit Purchase #2 Price (120 → 140)", qty: 140, avg: 110, value: 15400 },
  { case: 5, label: "5. Sale 50", qty: 90, avg: 110, value: 9900 },
  { case: 6, label: "6. Edit Sale #5 (50 → 45)", qty: 95, avg: 110, value: 10450 },
  { case: 7, label: "7. Sales Return 10", qty: 105, avg: 110, value: 11550 },
  { case: 8, label: "8. Delete Sales Return #7", qty: 95, avg: 110, value: 10450 },
  { case: 9, label: "9. Purchase 60 @ 150", qty: 155, avg: 125.48, value: 19450 },
  { case: 10, label: "10. Purchase Return 20", qty: 135, avg: 125.48, value: 16940.32 },
  { case: 11, label: "11. Delete Purchase Return #10", qty: 155, avg: 125.48, value: 19450 },
  { case: 12, label: "12. Sale 180 (Negative Stock)", qty: -25, avg: 125.48, value: -3137.1 },
  { case: 13, label: "13. Purchase 80 @ 200 (Recover Negative)", qty: 55, avg: 233.87, value: 12862.9 },
  { case: 14, label: "14. Edit Purchase #13 Qty (80 → 70)", qty: 45, avg: 236.95, value: 10662.9 },
  { case: 15, label: "15. Edit Purchase #13 Price (200 → 220)", qty: 45, avg: 268.06, value: 12062.9 },
  { case: 16, label: "16. Sale 30", qty: 15, avg: 268.06, value: 4020.97 },
  { case: 17, label: "17. Sales Return 15", qty: 30, avg: 268.06, value: 8041.94 },
  { case: 18, label: "18. Delete Sale #16", qty: 60, avg: 268.06, value: 16083.88 },
  { case: 19, label: "19. Delete Sales Return #17", qty: 45, avg: 268.06, value: 12062.91 },
  { case: 20, label: "20. Delete Original Purchase #2 (replay history)", qty: 45, avg: 268.06, value: 12062.91 },
  { case: 21, label: "21. Purchase Return 45", qty: 0, avg: null, value: 0 },
  { case: 22, label: "22. Purchase 25 @ 300", qty: 25, avg: 300, value: 7500 },
  { case: 23, label: "23. Sale 40 (Negative Stock)", qty: -15, avg: 300, value: -4500 },
  { case: 24, label: "24. Purchase 10 @ 280", qty: -5, avg: 340, value: -1700 },
  { case: 25, label: "25. Purchase 20 @ 320 (Recover +ve)", qty: 15, avg: 313.33, value: 4700 },
  { case: 26, label: "26. Delete Purchase #24 (replay history)", qty: 25, avg: 313.33, value: 7833.33 },
  { case: 27, label: "27. Edit Purchase #25 Price (320 → 350)", qty: 25, avg: 313.33, value: 7833.33 },
  { case: 28, label: "28. Delete Purchase #22 (replay history)", qty: -20, avg: 313.33, value: -6266.67 },
  { case: 29, label: "29. Delete Purchase #25 (replay history)", qty: 0, avg: null, value: 0 },
];

function fmtMoney(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return `Rs. ${Number(n).toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtAvg(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return `Rs. ${round2(n).toFixed(2)}`;
}

function qtyDelta(prev, next) {
  const d = round2(next - prev);
  if (d > 0) return `+${d}`;
  if (d < 0) return String(d);
  return "0";
}

function compareRow(actual, exp, valueTolerance = 1) {
  return {
    qtyOk: actual.qty === exp.qty,
    avgOk: exp.avg == null ? true : round2(actual.avg) === round2(exp.avg),
    valueOk:
      exp.value == null ?
        true
      : Math.abs(actual.inventoryValue - exp.value) <= valueTolerance,
  };
}

function buildReport(ledger) {
  const report = [];
  let prevQty = 0;
  const steps = [
    () => ledger.addPurchase("po1", 100, 100),
    () => ledger.addPurchase("po2", 50, 120),
    () => ledger.editPurchase("po2", 40, 120),
    () => ledger.editPurchase("po2", 40, 140),
    () => ledger.addSale("sale5", 50),
    () => ledger.editSale("sale5", 45),
    () => ledger.addSalesReturn("sr7", 10),
    () => ledger.deleteSalesReturn("sr7"),
    () => ledger.addPurchase("po9", 60, 150),
    () => ledger.addPurchaseReturn("pr10", 20),
    () => ledger.deletePurchaseReturn("pr10"),
    () => ledger.addSale("sale12", 180),
    () => ledger.addPurchase("po13", 80, 200),
    () => ledger.editPurchase("po13", 70, 200),
    () => ledger.editPurchase("po13", 70, 220),
    () => ledger.addSale("sale16", 30),
    () => ledger.addSalesReturn("sr17", 15),
    () => ledger.deleteSale("sale16"),
    () => ledger.deleteSalesReturn("sr17"),
    () => ledger.deletePurchase("po2"),
    () => ledger.addPurchaseReturn("pr21", 45),
    () => ledger.addPurchase("po22", 25, 300),
    () => ledger.addSale("sale23", 40),
    () => ledger.addPurchase("po24", 10, 280),
    () => ledger.addPurchase("po25", 20, 320),
    () => ledger.deletePurchase("po24"),
    () => ledger.editPurchase("po25", 20, 350),
    () => ledger.deletePurchase("po22"),
    () => ledger.deletePurchase("po25"),
  ];

  for (let i = 0; i < steps.length; i += 1) {
    steps[i]();
    const s = ledger.state();
    const exp = EXPECTED[i];
    const cmp = compareRow(s, exp);
    report.push({
      case: exp.case,
      label: exp.label,
      runningQty: s.qty,
      expectedQty: exp.qty,
      delta: qtyDelta(prevQty, s.qty),
      runningAvg: s.avg,
      expectedAvg: exp.avg,
      runningValue: s.inventoryValue,
      expectedValue: exp.value,
      grandTotal: s.grandTotal,
      ...cmp,
    });
    prevQty = s.qty;
  }
  return report;
}

function printReport(report) {
  const lines = [];
  lines.push("\nWAC Ledger Replay — 29 Transactions (Implementation vs Expected)");
  lines.push("=".repeat(124));
  lines.push(
    [
      "Case".padEnd(6),
      "Transaction".padEnd(44),
      "Run Qty".padEnd(9),
      "Exp Qty".padEnd(9),
      "Δ".padEnd(7),
      "Run Avg".padEnd(12),
      "Exp Avg".padEnd(12),
      "Run Value".padEnd(14),
      "Exp Value".padEnd(14),
      "Status".padEnd(6),
    ].join(" | "),
  );
  lines.push("-".repeat(124));

  for (const r of report) {
    const ok = r.qtyOk && r.avgOk && r.valueOk;
    lines.push(
      [
        `#${r.case}`.padEnd(6),
        r.label.slice(0, 42).padEnd(44),
        String(r.runningQty).padEnd(9),
        String(r.expectedQty).padEnd(9),
        r.delta.padEnd(7),
        fmtAvg(r.runningAvg).padEnd(12),
        (r.expectedAvg == null ? "—" : fmtAvg(r.expectedAvg)).padEnd(12),
        fmtMoney(r.runningValue).padEnd(14),
        fmtMoney(r.expectedValue).padEnd(14),
        (ok ? "OK" : "DIFF").padEnd(6),
      ].join(" | "),
    );
    if (!ok) {
      const parts = [];
      if (!r.qtyOk) parts.push(`qty ${r.runningQty}≠${r.expectedQty}`);
      if (!r.avgOk) parts.push(`avg ${round2(r.runningAvg)}≠${r.expectedAvg}`);
      if (!r.valueOk) parts.push(`value ${r.runningValue}≠${r.expectedValue}`);
      lines.push(`       ↳ ${parts.join("; ")}`);
    }
  }

  const passed = report.filter((r) => r.qtyOk && r.avgOk && r.valueOk).length;
  lines.push("-".repeat(124));
  lines.push(`Match: ${passed}/${report.length} (value tolerance ±Rs. 1.00)\n`);
  return lines.join("\n");
}

if (process.argv.includes("--report")) {
  const report = buildReport(createEventLedger());
  console.log(printReport(report));
  process.exit(0);
}

test("WAC ledger replay: 29-step report prints", () => {
  const report = buildReport(createEventLedger());
  console.log(printReport(report));
  assert.equal(report.length, 29);
});

test("WAC ledger replay: core qty paths", () => {
  const ledger = createEventLedger();
  ledger.addPurchase("po1", 100, 100);
  ledger.addPurchase("po2", 50, 120);
  ledger.editPurchase("po2", 40, 120);
  ledger.editPurchase("po2", 40, 140);
  ledger.addSale("sale5", 50);
  ledger.editSale("sale5", 45);
  assert.equal(ledger.state().qty, 95);
});

test("WAC ledger replay: negative stock then recovery", () => {
  const ledger = createEventLedger();
  ledger.addPurchase("po1", 100, 100);
  ledger.addPurchase("po2", 50, 120);
  ledger.editPurchase("po2", 40, 140);
  ledger.addSale("sale5", 45);
  ledger.addPurchase("po9", 60, 150);
  ledger.addSale("sale12", 180);
  assert.equal(ledger.state().qty, -25);
  ledger.addPurchase("po13", 80, 200);
  assert.equal(ledger.state().qty, 55);
});

test("displayInventoryValue matches replay output", () => {
  const r = replayWacLedger([
    { type: "purchase", qty: 100, unitCost: 100 },
    { type: "purchase", qty: 50, unitCost: 120 },
  ]);
  assert.equal(r.inventoryValue, displayInventoryValue(r.qty, r.wac));
  assert.equal(r.inventoryValue, 16000.5);
});
