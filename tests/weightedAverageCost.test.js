const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeWeightedAverageCost,
  computeReverseWeightedAverageCost,
  round2,
} = require("../utils/weightedAverageCost");

/**
 * Helper: assert the new WAC for an inbound layer.
 */
function wac(existingQty, existingCost, incomingQty, incomingCost) {
  return computeWeightedAverageCost({
    existingQty,
    existingCost,
    incomingQty,
    incomingCost,
  }).newCost;
}

test("round2 rounds to 2 decimals", () => {
  assert.equal(round2(10.005), 10.01);
  assert.equal(round2(10.004), 10);
  assert.equal(round2(1 / 3), 0.33);
});

// ---------------------------------------------------------------------------
// Specified WAC test cases
// ---------------------------------------------------------------------------

test("Case 1: standard positive stock + inbound", () => {
  // 10 @ 100 + 5 @ 130 = (1000 + 650) / 15 = 110
  assert.equal(wac(10, 100, 5, 130), 110);
});

test("Case 2: zero existing stock -> incoming cost", () => {
  assert.equal(wac(0, 0, 8, 120), 120);
  assert.equal(wac(0, 999, 8, 120), 120);
});

test("Case 3: negative existing stock contributes (NOT ignored)", () => {
  // -5 @ 100 + 10 @ 130 = (-500 + 1300) / 5 = 160
  assert.equal(wac(-5, 100, 10, 130), 160);
});

test("Case 3b: larger negative inventory", () => {
  // -20 @ 50 + 30 @ 80 = (-1000 + 2400) / 10 = 140
  assert.equal(wac(-20, 50, 30, 80), 140);
});

test("Case 3c: spec recovery example must be 140 (not 120)", () => {
  // Existing -5 @ 100, receive 10 @ 120 => (-500 + 1200) / 5 = 140
  const r = computeWeightedAverageCost({
    existingQty: -5,
    existingCost: 100,
    incomingQty: 10,
    incomingCost: 120,
  });
  assert.equal(r.newQty, 5);
  assert.equal(r.newCost, 140);
  assert.notEqual(r.newCost, 120);
});

test("Case 3d: negative inventory recovery -15 @ 240 + 50 @ 350 -> 397.14 (NOT 350)", () => {
  // Existing -15 @ 240, receive 50 @ 350:
  //   existingValue = -15 * 240 = -3,600
  //   incomingValue =  50 * 350 = 17,500
  //   newQty        = -15 + 50  = 35
  //   newValue      = -3,600 + 17,500 = 13,900
  //   newCost       = 13,900 / 35 = 397.142857 -> 397.14
  const r = computeWeightedAverageCost({
    existingQty: -15,
    existingCost: 240,
    incomingQty: 50,
    incomingCost: 350,
  });
  assert.equal(r.existingValue, -3600); // existing qty NOT clamped to zero
  assert.equal(r.incomingValue, 17500);
  assert.equal(r.newQty, 35);
  // New inventory value = existingValue + incomingValue (pre-rounding of WAC).
  assert.equal(r.existingValue + r.incomingValue, 13900);
  assert.equal(r.newCost, 397.14);
  assert.notEqual(r.newCost, 350); // 350 would mean existingQty was clamped
});

test("Case 4: inventory returns to exactly zero -> keep previous WAC (no div/0)", () => {
  // -5 @ 100 + 5 @ 130 => newQty 0 => keep 100
  const r = computeWeightedAverageCost({
    existingQty: -5,
    existingCost: 100,
    incomingQty: 5,
    incomingCost: 130,
  });
  assert.equal(r.newQty, 0);
  assert.equal(r.newCost, 100);
});

test("Case 5: non-positive incoming qty is skipped (stock-in only)", () => {
  const zero = computeWeightedAverageCost({
    existingQty: 10,
    existingCost: 100,
    incomingQty: 0,
    incomingCost: 130,
  });
  assert.equal(zero.skipped, true);
  assert.equal(zero.newCost, 100);

  const neg = computeWeightedAverageCost({
    existingQty: 10,
    existingCost: 100,
    incomingQty: -3,
    incomingCost: 130,
  });
  assert.equal(neg.skipped, true);
  assert.equal(neg.newCost, 100);
});

test("Case 6: same cost in and out -> unchanged", () => {
  assert.equal(wac(10, 100, 5, 100), 100);
});

test("Case 7: cheaper inbound lowers WAC", () => {
  // 10 @ 100 + 10 @ 80 = 1800 / 20 = 90
  assert.equal(wac(10, 100, 10, 80), 90);
});

test("Case 8: more expensive inbound raises WAC", () => {
  // 10 @ 100 + 10 @ 200 = 3000 / 20 = 150
  assert.equal(wac(10, 100, 10, 200), 150);
});

test("Case 9: decimal quantities and costs round to 2 dp", () => {
  // 3 @ 33.33 + 2 @ 50 = (99.99 + 100) / 5 = 39.998 -> 40.00
  assert.equal(wac(3, 33.33, 2, 50), 40);
});

test("Case 10: sequential inbound layers", () => {
  let cost = 100;
  let qty = 10;
  // + 5 @ 130 -> 110
  cost = wac(qty, cost, 5, 130);
  qty += 5;
  assert.equal(cost, 110);
  // + 10 @ 95 -> (15*110 + 10*95) / 25 = (1650 + 950)/25 = 104
  cost = wac(qty, cost, 10, 95);
  qty += 10;
  assert.equal(cost, 104);
});

test("Case 11: negative recovery to positive", () => {
  // -8 @ 120 + 20 @ 150 = (-960 + 3000) / 12 = 170
  assert.equal(wac(-8, 120, 20, 150), 170);
});

test("Case 12: stock-out below zero then restock", () => {
  // Start 5 @ 100, sell 12 (on-hand -7, cost unchanged 100),
  // then restock 10 @ 130: (-7*100 + 10*130)/3 = (-700 + 1300)/3 = 200
  assert.equal(wac(-7, 100, 10, 130), 200);
});

// ---------------------------------------------------------------------------
// Reverse WAC (undo an inbound layer)
// ---------------------------------------------------------------------------

test("Reverse: undoing an inbound restores the prior WAC", () => {
  // Forward: 10 @ 100 + 5 @ 130 = 110 (qty 15).
  // Reverse 5 @ 130 from remaining 10 @ 110:
  // (15*110 - 5*130)/10 = (1650 - 650)/10 = 100
  const r = computeReverseWeightedAverageCost({
    remainingQty: 10,
    currentCost: 110,
    removedQty: 5,
    removedCost: 130,
  });
  assert.equal(r.newCost, 100);
});

test("Reverse: remaining qty zero keeps previous WAC (no div/0)", () => {
  const r = computeReverseWeightedAverageCost({
    remainingQty: 0,
    currentCost: 110,
    removedQty: 5,
    removedCost: 130,
  });
  assert.equal(r.newCost, 110);
});

test("Reverse: non-positive removed qty is skipped", () => {
  const r = computeReverseWeightedAverageCost({
    remainingQty: 10,
    currentCost: 110,
    removedQty: 0,
    removedCost: 130,
  });
  assert.equal(r.skipped, true);
  assert.equal(r.newCost, 110);
});

test("Reverse: works with negative remaining qty", () => {
  // qtyBefore = -3 + 5 = 2; value = 2*120 - 5*150 = 240 - 750 = -510;
  // newCost = -510 / -3 = 170
  const r = computeReverseWeightedAverageCost({
    remainingQty: -3,
    currentCost: 120,
    removedQty: 5,
    removedCost: 150,
  });
  assert.equal(r.newCost, 170);
});

// ---------------------------------------------------------------------------
// Round-trip property: forward then reverse returns to original cost
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Full end-to-end ledger scenario (spec table)
//
// Simulates a product's life across purchases, a PO edit, sales, a purchase
// return and a sales return — including the inventory going negative — using
// ONLY the centralized helpers. Reproduces the expected qty / avg cost / value.
// ---------------------------------------------------------------------------

test("Scenario: full PO/sale/return ledger reproduces spec table", () => {
  let qty = 0;
  let avg = 0;

  // Inbound layer (purchase / sales-return / stock-in).
  const stockIn = (incomingQty, incomingCost) => {
    const r = computeWeightedAverageCost({
      existingQty: qty,
      existingCost: avg,
      incomingQty,
      incomingCost,
    });
    qty = round2(qty + incomingQty);
    avg = r.newCost;
  };

  // Reverse an inbound layer (PO edit-down / purchase return) at a unit cost.
  const reverseIn = (removedQty, removedCost) => {
    const remainingQty = round2(qty - removedQty);
    const r = computeReverseWeightedAverageCost({
      remainingQty,
      currentCost: avg,
      removedQty,
      removedCost,
    });
    qty = remainingQty;
    avg = r.newCost;
  };

  // Sale (stock-out): qty drops, WAC is unchanged.
  const sale = (soldQty) => {
    qty = round2(qty - soldQty);
  };

  const value = () => Math.round(qty * avg);

  // #1 Purchase 10 @ 100
  stockIn(10, 100);
  assert.equal(qty, 10);
  assert.equal(avg, 100);
  assert.equal(value(), 1000);

  // #2 Purchase 30 @ 140
  stockIn(30, 140);
  assert.equal(qty, 40);
  assert.equal(avg, 130);
  assert.equal(value(), 5200);

  // #2b Edit PO -> 20 (remove 10 @ 140)
  reverseIn(10, 140);
  assert.equal(qty, 30);
  assert.equal(avg, 126.67);
  assert.equal(value(), 3800);

  // #3 Sale 15
  sale(15);
  assert.equal(qty, 15);
  assert.equal(avg, 126.67);
  assert.equal(value(), 1900);

  // #4 Purchase 25 @ 180
  stockIn(25, 180);
  assert.equal(qty, 40);
  assert.equal(avg, 160);
  assert.equal(value(), 6400);

  // #5 Sale 50 (inventory goes negative)
  sale(50);
  assert.equal(qty, -10);
  assert.equal(avg, 160);
  assert.equal(value(), -1600);

  // #6 Purchase 20 @ 200 (negative recovery -> WAC must be 240)
  stockIn(20, 200);
  assert.equal(qty, 10);
  assert.equal(avg, 240);
  assert.equal(value(), 2400);

  // #7 Purchase Return 5 (removed at current WAC -> WAC unchanged)
  reverseIn(5, 240);
  assert.equal(qty, 5);
  assert.equal(avg, 240);
  assert.equal(value(), 1200);

  // #8 Sales Return 10 (restored at sale cost -> WAC unchanged)
  stockIn(10, 240);
  assert.equal(qty, 15);
  assert.equal(avg, 240);
  assert.equal(value(), 3600);

  // #9 Sale 30 (inventory goes negative again)
  sale(30);
  assert.equal(qty, -15);
  assert.equal(avg, 240);
  assert.equal(value(), -3600);
});

test("Round-trip: forward inbound then reverse returns original cost", () => {
  const existingQty = 10;
  const existingCost = 100;
  const incomingQty = 5;
  const incomingCost = 130;

  const fwd = computeWeightedAverageCost({
    existingQty,
    existingCost,
    incomingQty,
    incomingCost,
  });
  const rev = computeReverseWeightedAverageCost({
    remainingQty: existingQty,
    currentCost: fwd.newCost,
    removedQty: incomingQty,
    removedCost: incomingCost,
  });
  assert.equal(rev.newCost, round2(existingCost));
});
