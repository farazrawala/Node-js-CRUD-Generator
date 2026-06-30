const test = require("node:test");
const assert = require("node:assert/strict");
const {
  replayWacLedger,
  displayInventoryValue,
  resolvePersistedWac,
} = require("../utils/wacLedgerReplay");
const { round2 } = require("../utils/weightedAverageCost");

test("displayInventoryValue uses round2(qty × WAC) at output", () => {
  assert.equal(displayInventoryValue(150, 106.67), 16000.5);
  assert.equal(displayInventoryValue(0, 999), 0);
});

test("replayWacLedger: purchase + sale WAC-neutral", () => {
  const r = replayWacLedger([
    { type: "purchase", qty: 100, unitCost: 100 },
    { type: "purchase", qty: 50, unitCost: 120 },
    { type: "sale", qty: 50 },
  ]);
  assert.equal(r.qty, 100);
  assert.equal(r.wac, 106.67);
  assert.equal(r.inventoryValue, 10667);
});

test("replayWacLedger: negative inventory recovery", () => {
  let events = [
    { type: "purchase", qty: 100, unitCost: 100 },
    { type: "purchase", qty: 50, unitCost: 120 },
    { type: "purchase", qty: 60, unitCost: 150 },
    { type: "sale", qty: 180 },
  ];
  let r = replayWacLedger(events);
  assert.equal(r.qty, 30);
  assert.ok(r.qty > 0 || r.qty < 0);
  events = [...events, { type: "purchase", qty: 80, unitCost: 200 }];
  r = replayWacLedger(events);
  assert.equal(r.qty, 110);
});

test("replayWacLedger: PO edit via replaced purchase event (full replay)", () => {
  const events = [
    { type: "purchase", qty: 100, unitCost: 100 },
    { type: "purchase", qty: 40, unitCost: 120 },
  ];
  const r = replayWacLedger(events);
  assert.equal(r.qty, 140);
  assert.equal(r.wac, round2(r.grandTotal / r.qty));
  assert.equal(
    r.inventoryValue,
    displayInventoryValue(r.qty, r.wac),
  );
});

test("resolvePersistedWac: incremental forward when ledger diverges from warehouse", () => {
  const events = [
    { type: "purchase", qty: 100, unitCost: 100 },
    { type: "sale", qty: 45 },
    { type: "purchase", qty: 60, unitCost: 150 },
    { type: "sale", qty: 180 },
    { type: "purchase", qty: 70, unitCost: 220 },
    { type: "purchase_return", qty: 10 },
  ];
  const replay = replayWacLedger(events);
  const wac = resolvePersistedWac({
    replay,
    warehouseQty: 60,
    wholesaleBefore: 268.06,
    inboundLayer: { incomingQty: 25, incomingCost: 300 },
  });
  assert.equal(wac, 281.37);
  assert.notEqual(wac, -152.83);
});

test("replayWacLedger: delete purchase removes layer from replay log", () => {
  const before = replayWacLedger([
    { type: "purchase", qty: 100, unitCost: 100 },
    { type: "purchase", qty: 40, unitCost: 140 },
    { type: "sale", qty: 45 },
    { type: "purchase", qty: 60, unitCost: 150 },
    { type: "sale", qty: 180 },
    { type: "purchase", qty: 70, unitCost: 220 },
  ]);
  assert.equal(before.qty, 45);
  assert.equal(before.wac, round2(before.grandTotal / before.qty));

  const afterDeletePo2 = replayWacLedger([
    { type: "purchase", qty: 100, unitCost: 100 },
    { type: "sale", qty: 45 },
    { type: "purchase", qty: 60, unitCost: 150 },
    { type: "sale", qty: 180 },
    { type: "purchase", qty: 70, unitCost: 220 },
  ]);
  assert.notEqual(afterDeletePo2.wac, before.wac);
  assert.equal(afterDeletePo2.qty, 5);
  // PO delete replay-history preserves stored WAC (case #20) — do not persist replay.wac
  assert.equal(round2(before.wac), 272.02);
  assert.equal(round2(afterDeletePo2.wac), 1440.87);
});
