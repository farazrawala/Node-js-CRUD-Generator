const assert = require("node:assert/strict");
const test = require("node:test");

const CourierService = require("../src/services/CourierService");
const CourierProvider = require("../src/models/courier_provider.model");
const CourierShipment = require("../src/models/courier_shipment.model");
const Order = require("../models/order");
const { TERMINAL_STATUSES } = require("../src/couriers/constants");

test("tracking sync selects only POS in-transit shipments with an active courier integration", async () => {
  const shipments = [
    {
      _id: "missing-config",
      order_id: "order-a",
      company_id: "company-a",
      courier: "Leopard",
      shipment_status: "Booked",
    },
    {
      _id: "configured",
      order_id: "order-b",
      company_id: "company-b",
      courier: "Trax",
      shipment_status: "Picked",
    },
    {
      _id: "pos-packed",
      order_id: "order-c",
      company_id: "company-c",
      courier: "TCS",
      shipment_status: "In Transit",
    },
    {
      _id: "past-limit",
      order_id: "order-d",
      company_id: "company-d",
      courier: "TCS",
      shipment_status: "Booked",
    },
  ];
  const configured = new Set(["company-b:Trax", "company-d:TCS"]);
  const posInTransit = new Set(["order-a", "order-b", "order-d"]);
  const findFilters = [];
  const orderFilters = [];
  const providerFilters = [];
  const originalShipmentFind = CourierShipment.find;
  const originalOrderFind = Order.find;
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
  Order.find = (filter) => {
    orderFilters.push(filter);
    return {
      select() {
        return this;
      },
      lean: async () =>
        [...posInTransit]
          .filter((id) =>
            filter._id.$in.some((candidate) => String(candidate) === id),
          )
          .map((_id) => ({ _id })),
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
      shipment_status: { $nin: TERMINAL_STATUSES },
    });
    assert.deepEqual(orderFilters[0], {
      _id: { $in: shipments.map((shipment) => shipment.order_id) },
      deletedAt: null,
      order_status: "in_transit",
    });
    assert.deepEqual(
      providerFilters.map(({ company_id, provider }) => `${company_id}:${provider}`),
      ["company-a:Leopard", "company-b:Trax"],
    );
  } finally {
    CourierShipment.find = originalShipmentFind;
    Order.find = originalOrderFind;
    CourierProvider.findOne = originalProviderFindOne;
  }
});
