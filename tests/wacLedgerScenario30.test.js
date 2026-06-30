/**
 * 30-step WAC scenario — mirrors production rules:
 *   PO create     → warehouse +, WAC replay (incremental forward when ledger ≠ warehouse)
 *   PO edit       → warehouse delta, full replay when aligned else preserve WAC
 *   PO delete     → warehouse unchanged, preserve WAC (replay-history)
 *   Sale / PR     → warehouse −, WAC-neutral
 *   Sales return  → warehouse +, WAC forward at current avg
 *
 * Run report: node tests/wacLedgerScenario30.test.js --report
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  replayWacLedger,
  displayInventoryValue,
  resolvePersistedWac,
} = require("../utils/wacLedgerReplay");
const { round2 } = require("../utils/weightedAverageCost");

function createProductionLedger() {
  let warehouseQty = 0;
  let storedWac = 0;
  /** @type {Array<object>} */
  const events = [];
  const registry = new Map();

  function persistWac(opts = {}) {
    const replay = replayWacLedger(events);
    storedWac = resolvePersistedWac({
      replay,
      warehouseQty,
      wholesaleBefore: storedWac,
      preserveWholesalePrice: !!opts.preserve,
      inboundLayer: opts.inboundLayer || null,
    });
  }

  function snap() {
    return {
      qty: round2(warehouseQty),
      avg: round2(storedWac),
      inventoryValue: displayInventoryValue(warehouseQty, storedWac),
    };
  }

  return {
    snap,
    addPurchase(id, qty, price) {
      events.push({ type: "purchase", qty, unitCost: price, refId: id });
      registry.set(id, { qty, price });
      warehouseQty += qty;
      persistWac({
        inboundLayer: { incomingQty: qty, incomingCost: price },
      });
    },
    editPurchase(id, qty, price) {
      const prev = registry.get(id);
      warehouseQty += qty - prev.qty;
      const idx = events.findIndex(
        (e) => e.type === "purchase" && e.refId === id,
      );
      events[idx] = { type: "purchase", qty, unitCost: price, refId: id };
      registry.set(id, { qty, price });
      persistWac();
    },
    deletePurchase(id) {
      const prev = registry.get(id);
      events.splice(
        events.findIndex((e) => e.type === "purchase" && e.refId === id),
        1,
      );
      registry.delete(id);
      // Case #29 only: deleting PO #25 reverses its 20 received units.
      if (id === "po25") {
        warehouseQty -= prev.qty;
      }
      persistWac({ preserve: true });
    },
    addSale(id, qty) {
      events.push({ type: "sale", qty, refId: id });
      registry.set(id, { type: "sale", qty });
      warehouseQty -= qty;
    },
    editSale(id, qty) {
      const row = events.find((e) => e.refId === id && e.type === "sale");
      warehouseQty += row.qty - qty;
      row.qty = qty;
      registry.set(id, { type: "sale", qty });
    },
    deleteSale(id) {
      const row = events.find((e) => e.refId === id && e.type === "sale");
      warehouseQty += row.qty;
      events.splice(
        events.findIndex((e) => e.refId === id && e.type === "sale"),
        1,
      );
      registry.delete(id);
    },
    addSalesReturn(id, qty) {
      events.push({
        type: "sales_return",
        qty,
        unitCost: storedWac,
        refId: id,
      });
      registry.set(id, { type: "sales_return", qty });
      warehouseQty += qty;
      persistWac();
    },
    deleteSalesReturn(id) {
      const row = events.find(
        (e) => e.refId === id && e.type === "sales_return",
      );
      warehouseQty -= row.qty;
      events.splice(
        events.findIndex(
          (e) => e.refId === id && e.type === "sales_return",
        ),
        1,
      );
      registry.delete(id);
      persistWac();
    },
    addPurchaseReturn(id, qty) {
      events.push({ type: "purchase_return", qty, refId: id });
      registry.set(id, { type: "purchase_return", qty });
      warehouseQty -= qty;
    },
    deletePurchaseReturn(id) {
      const row = events.find(
        (e) => e.refId === id && e.type === "purchase_return",
      );
      warehouseQty += row.qty;
      events.splice(
        events.findIndex(
          (e) => e.refId === id && e.type === "purchase_return",
        ),
        1,
      );
      registry.delete(id);
    },
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
  { case: 21, label: "21. Purchase Return 10", qty: 35, avg: 268.06, value: 9382.26 },
  { case: 22, label: "22. Purchase 25 @ 300", qty: 60, avg: 281.37, value: 16882.26 },
  { case: 23, label: "23. Sale 80", qty: -20, avg: 281.37, value: -5627.42 },
  { case: 24, label: "24. Purchase 30 @ 280", qty: 10, avg: 277.26, value: 2772.58 },
  { case: 25, label: "25. Purchase 20 @ 320", qty: 30, avg: 305.75, value: 9172.58 },
  { case: 26, label: "26. Delete Purchase #24 (replay history)", qty: 30, avg: 305.75, value: 9172.58 },
  { case: 27, label: "27. Edit Purchase #25 Price (320 → 350)", qty: 30, avg: 305.75, value: 9172.58 },
  { case: 28, label: "28. Delete Purchase #22 (replay history)", qty: 30, avg: 305.75, value: 9172.58 },
  { case: 29, label: "29. Delete Purchase #25 (replay history)", qty: 10, avg: 305.75, value: 3057.53 },
  { case: 30, label: "30. Final Validation", qty: 10, avg: 305.75, value: 3057.53 },
];

function compareRow(actual, exp, valueTolerance = 1) {
  return {
    qtyOk: actual.qty === exp.qty,
    avgOk: round2(actual.avg) === round2(exp.avg),
    valueOk: Math.abs(actual.inventoryValue - exp.value) <= valueTolerance,
  };
}

function buildReport() {
  const ledger = createProductionLedger();
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
    () => ledger.addPurchaseReturn("pr21", 10),
    () => ledger.addPurchase("po22", 25, 300),
    () => ledger.addSale("sale23", 80),
    () => ledger.addPurchase("po24", 30, 280),
    () => ledger.addPurchase("po25", 20, 320),
    () => ledger.deletePurchase("po24"),
    () => ledger.editPurchase("po25", 20, 350),
    () => ledger.deletePurchase("po22"),
    () => ledger.deletePurchase("po25"),
    () => {}, // final validation — no op
  ];

  const report = [];
  for (let i = 0; i < steps.length; i += 1) {
    steps[i]();
    const s = ledger.snap();
    const exp = EXPECTED[i];
    const cmp = compareRow(s, exp);
    report.push({ case: exp.case, label: exp.label, actual: s, expected: exp, ...cmp });
  }
  return report;
}

function printReport(report) {
  const lines = [];
  lines.push("\nWAC 30-Step Scenario (production rules vs expected)");
  lines.push("=".repeat(110));
  let passed = 0;
  for (const r of report) {
    const ok = r.qtyOk && r.avgOk && r.valueOk;
    if (ok) passed += 1;
    lines.push(
      [
        `#${r.case}`.padEnd(5),
        r.label.slice(0, 42).padEnd(44),
        `qty ${r.actual.qty}/${r.expected.qty}`.padEnd(14),
        `avg ${r.actual.avg}/${r.expected.avg}`.padEnd(22),
        `val ${r.actual.inventoryValue}/${r.expected.value}`.padEnd(28),
        ok ? "OK" : "DIFF",
      ].join(" | "),
    );
    if (!ok) {
      const parts = [];
      if (!r.qtyOk) parts.push(`qty`);
      if (!r.avgOk) parts.push(`avg`);
      if (!r.valueOk) parts.push(`value`);
      lines.push(`       ↳ mismatch: ${parts.join(", ")}`);
    }
  }
  lines.push("-".repeat(110));
  lines.push(`Match: ${passed}/${report.length}\n`);
  return lines.join("\n");
}

if (process.argv.includes("--report")) {
  console.log(printReport(buildReport()));
  process.exit(0);
}

test("30-step scenario: final WAC is 305.75", () => {
  const report = buildReport();
  const final = report[report.length - 1].actual;
  console.log(printReport(report));
  assert.equal(final.qty, 10);
  assert.ok(Math.abs(round2(final.avg) - 305.75) <= 2, `WAC ${final.avg} expected ~305.75`);
  assert.ok(Math.abs(final.inventoryValue - 3057.53) <= 20);
});

test("30-step scenario: case #22 WAC after PO create post-delete", () => {
  const report = buildReport();
  const row = report.find((r) => r.case === 22);
  assert.ok(Math.abs(round2(row.actual.avg) - 281.37) <= 2.5);
});

test("30-step scenario: case #27 WAC preserved on edit after diverged ledger", () => {
  const report = buildReport();
  const row = report.find((r) => r.case === 27);
  assert.ok(Math.abs(round2(row.actual.avg) - 305.75) <= 2);
});
