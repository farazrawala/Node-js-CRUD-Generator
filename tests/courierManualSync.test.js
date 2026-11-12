const assert = require("node:assert/strict");
const test = require("node:test");

const CourierService = require("../src/services/CourierService");
const CourierController = require("../src/controllers/CourierController");
const Logs = require("../models/logs");

function createResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("manual tracking sync requires an authenticated company", async () => {
  const originalSync = CourierService.syncOpenShipments;
  let called = false;
  CourierService.syncOpenShipments = async () => {
    called = true;
  };
  const res = createResponse();

  try {
    await CourierController.syncTracking({ user: null, body: {}, query: {} }, res);

    assert.equal(res.statusCode, 401);
    assert.equal(res.body.success, false);
    assert.equal(called, false);
  } finally {
    CourierService.syncOpenShipments = originalSync;
  }
});

test("manual tracking sync is scoped to the user's company and accepts a batch limit", async () => {
  const originalSync = CourierService.syncOpenShipments;
  const originalCreate = Logs.create;
  let receivedOptions;
  let createdLog;
  CourierService.syncOpenShipments = async (options) => {
    receivedOptions = options;
    return { total: 0, updated: 0, errors: 0 };
  };
  Logs.create = async (entry) => {
    createdLog = entry;
    return { _id: "log-id" };
  };
  const res = createResponse();

  try {
    await CourierController.syncTracking(
      {
        user: {
          _id: "64b000000000000000000001",
          company_id: { _id: "64b000000000000000000002" },
        },
        body: { limit: 3, courier_ids: ["64b000000000000000000003"] },
        query: {},
      },
      res,
    );

    assert.deepEqual(receivedOptions, {
      companyId: "64b000000000000000000002",
      limit: 3,
      courierIds: ["64b000000000000000000003"],
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.scope, "company");
    assert.deepEqual(res.body.eligible_statuses, [
      "in_transit",
      "shipment_booked",
    ]);
    assert.deepEqual(createdLog.tags, ["syc_courier"]);
    assert.equal(createdLog.action, "Courier tracking sync");
    assert.equal(createdLog.company_id.toString(), "64b000000000000000000002");
  } finally {
    CourierService.syncOpenShipments = originalSync;
    Logs.create = originalCreate;
  }
});
