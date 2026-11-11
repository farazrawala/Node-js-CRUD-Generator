const assert = require("node:assert/strict");
const test = require("node:test");

const CourierService = require("../src/services/CourierService");
const CourierProvider = require("../src/models/courier_provider.model");
const CourierShipment = require("../src/models/courier_shipment.model");
const { UNIFIED_STATUSES } = require("../src/couriers/constants");

test("tracking sync selects only in-transit shipments with an active courier integration", async () => {
  const shipments = [
    { _id: "missing-config", company_id: "company-a", courier: "Leopard" },
    { _id: "configured", company_id: "company-b", courier: "Trax" },
    { _id: "past-limit", company_id: "company-c", courier: "TCS" },
  ];
  const configured = new Set(["company-b:Trax", "company-c:TCS"]);
  const findFilters = [];
  const providerFilters = [];
  const originalShipmentFind = CourierShipment.find;
  const originalProviderFindOne = CourierProvider.findOne;

  CourierShipment.find = (filter) => {
    findFilters.push(filter);
    let offset = 0;
    let count = shipments.length;
    return {
      sort() {
        return this;
      },
      skip(value) {
        offset = value;
        return this;
      },
      limit(value) {
        count = value;
        return this;
      },
      async lean() {
        return shipments.slice(offset, offset + count);
      },
    };
  };
  CourierProvider.findOne = (filter) => {
    providerFilters.push(filter);
    return {
      lean: async () =>
        configured.has(`${filter.company_id}:${filter.provider}`)
          ? { enabled: true }
          : null,
    };
  };

  try {
    const selected = await CourierService.findSyncableShipments(1);

    assert.deepEqual(selected.map((shipment) => shipment._id), ["configured"]);
    assert.deepEqual(findFilters[0], {
      deletedAt: null,
      tracking_number: { $nin: [null, ""] },
      shipment_status: UNIFIED_STATUSES.IN_TRANSIT,
    });
    assert.deepEqual(
      providerFilters.map(({ company_id, provider }) => `${company_id}:${provider}`),
      ["company-a:Leopard", "company-b:Trax"],
    );
  } finally {
    CourierShipment.find = originalShipmentFind;
    CourierProvider.findOne = originalProviderFindOne;
  }
});
