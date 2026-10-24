/**
 * Paste this whole file into the Chrome console while logged in at
 * https://bbg.betalogics.com/orders/index.php
 *
 * It reads the orders table (page 1 through page 73) and POSTs each row to
 * the live order_save API. maxRecords is 2 until you raise it.
 *
 * Before pasting, set authToken to the POS admin Bearer token
 * (the JWT sent as Authorization on testv3).
 *
 * Each product title is resolved with GET /api/shopify/lookup?name=...
 * and the returned pos_product_id is sent on the order. A line with no
 * POS id is not posted.
 *
 * A successful save is remembered in localStorage. The next run skips those
 * rows and continues. Call BetaOrderSync.reset() to start from the first row.
 * Call BetaOrderSync.run() to start again without re-pasting.
 */
(function (root) {
  const CONFIG = {
    apiUrl: "https://testv3.websitedemolynk.com/pos_admin/api/order/order_save",
    authToken:
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfaWQiOiI2YTk4MzIyZjEzYmUzZjFlNGIyNzg3MWMiLCJuYW1lIjoiSW9yZGVyIiwiY29tcGFueV9pZCI6IjZhOTgzMjJmMTNiZTNmMWU0YjI3ODcxOCIsImVtYWlsIjoiaW5mb0Bpb3JkZXIuY29tIiwicm9sZSI6WyJVU0VSIiwiQURNSU4iXSwiaWF0IjoxNzkyNzY0MjQxfQ.3Ndh82ZlfKO0aEDnb5GXGaB7xv-u-e890uUXXJ_5ZD8",
    integrationId: "6aa2c9cfec025096b978f26a",
    listUrl:
      "https://bbg.betalogics.com/orders/index.php?company_id=3&courier_service=all&sortBy=o.web_order_number&limit=300&orderStatus=all&page=1",
    startPage: 1,
    endPage: 73,
    maxRecords: 2,
    delayMs: 700,
    country: "Pakistan",
    // "advance" = cash already collected (0 on unpaid COD). "total" = grand total.
    amountReceived: "advance",
  };

  const SENT_KEY = "betaOrderSync.sent.v1";

  const ORDER_STATUS = {
    publish: "processing",
    processing: "processing",
    "on-hold": "on_hold",
    "on hold": "on_hold",
    "on-hold-merge": "on_hold",
    "on hold (merge)": "on_hold",
    lo_return: "return",
    "lo return": "return",
    inc_address: "pending",
    "inc address": "pending",
    "payment-pending": "pending",
    "payment pending": "pending",
    "today-no-answer": "pending",
    "today not answering": "pending",
    "no-answer": "pending",
    "not answering": "pending",
    confirmed: "confirmed",
    "robo-confirmed": "confirmed",
    "robo confirmed": "confirmed",
    "stock-awaiting": "pending",
    "stock awaiting": "pending",
    ready: "packed",
    duplicate: "duplicate",
    cancelled: "cancelled",
    canceled: "cancelled",
    "customer-cancelled": "cancelled",
    "customer cancel": "cancelled",
    lost: "failed",
    "n-a": "cancelled",
    "n/a": "cancelled",
    wrong: "cancelled",
    delete: "cancelled",
    deleted: "cancelled",
    dispatched: "in_transit",
    delivered: "delivered",
    returned: "return",
    return: "return",
    "in transit": "in_transit",
    new: "pending",
    pending: "pending",
  };

  const WEBSITE_STATUS = {
    pending: "pending",
    draft: "pending",
    placed: "confirmed",
    confirmed: "confirmed",
    processing: "processing",
    active: "processing",
    packed: "shipped",
    in_transit: "shipped",
    delivered: "delivered",
    completed: "completed",
    cancelled: "voided",
    failed: "failed",
    on_hold: "on-hold",
    return: "refunded",
    return_received: "refunded",
    duplicate: "voided",
    products_skipped: "on-hold",
  };

  const TRACKING_STATUS = {
    dispatched: "in_transit",
    "in transit": "in_transit",
    delivered: "delivered",
    processing: "pending",
    returned: "returned",
    return: "returned",
    cancelled: "cancelled",
    canceled: "cancelled",
    "out for delivery": "out_for_delivery",
    booked: "booked",
    pending: "pending",
  };

  const CITY_STATE = {
    lahore: "Punjab",
    karachi: "Sindh",
    islamabad: "Islamabad",
    rawalpindi: "Punjab",
    faisalabad: "Punjab",
    multan: "Punjab",
    gujranwala: "Punjab",
    sialkot: "Punjab",
    jhang: "Punjab",
    sargodha: "Punjab",
    bahawalpur: "Punjab",
    sahiwal: "Punjab",
    sheikhupura: "Punjab",
    gujrat: "Punjab",
    kasur: "Punjab",
    okara: "Punjab",
    rahimyarkhan: "Punjab",
    "rahim yar khan": "Punjab",
    wah: "Punjab",
    daska: "Punjab",
    peshawar: "Khyber Pakhtunkhwa",
    mardan: "Khyber Pakhtunkhwa",
    abbottabad: "Khyber Pakhtunkhwa",
    swat: "Khyber Pakhtunkhwa",
    quetta: "Balochistan",
    hyderabad: "Sindh",
    sukkur: "Sindh",
    larkana: "Sindh",
    mirpurkhas: "Sindh",
    muzaffarabad: "Azad Kashmir",
    mirpur: "Azad Kashmir",
    gilgit: "Gilgit-Baltistan",
  };

  function money(value) {
    const n = parseFloat(String(value == null ? "" : value).replace(/,/g, ""));
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  }

  function matchMoney(text, label) {
    const re = new RegExp(
      "(?:^|[^A-Za-z])" + label + "\\s*:\\s*Rs\\.?\\s*([\\d,]+(?:\\.\\d+)?)",
      "i",
    );
    const m = String(text || "").match(re);
    return m ? money(m[1]) : null;
  }

  function htmlToText(html) {
    const box = document.createElement("div");
    box.innerHTML = html || "";
    return (box.textContent || "").replace(/\s+/g, " ").trim();
  }

  function noteBodies(html) {
    const out = [];
    const re = /<span class=['"]body['"]>([\s\S]*?)<\/span>/gi;
    let m;
    const source = String(html || "");
    while ((m = re.exec(source))) {
      const text = htmlToText(m[1]);
      if (text) out.push(text);
    }
    return out;
  }

  function mapOrderStatus(raw) {
    const key = String(raw || "")
      .trim()
      .toLowerCase();
    if (!key) return "placed";
    if (ORDER_STATUS[key]) return ORDER_STATUS[key];
    const snake = key.replace(/[\s-]+/g, "_");
    return ORDER_STATUS[snake] || "placed";
  }

  function stateForCity(city) {
    const key = String(city || "")
      .trim()
      .toLowerCase();
    return CITY_STATE[key] || "";
  }

  function digitsPhone(value) {
    return String(value || "").replace(/[^\d]/g, "");
  }

  function betaOrderStatus(row) {
    const col = row.querySelector("td.orderStatusCol");
    if (!col) return { value: "", label: "" };
    const sel = col.querySelector("select");
    if (sel) {
      const opt =
        sel.querySelector("option[selected]") ||
        (sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null);
      if (opt) {
        return {
          value: (opt.getAttribute("value") || "").trim(),
          label: (opt.textContent || "").trim(),
        };
      }
    }
    const labels = col.querySelectorAll("span.label");
    for (const label of labels) {
      const text = (label.textContent || "").replace(/\s+/g, " ").trim();
      if (text && !/^ord status$/i.test(text))
        return { value: text, label: text };
    }
    return { value: "", label: "" };
  }

  function resolveStatuses(beta, shipLabel) {
    let orderStatus = mapOrderStatus(beta.value || beta.label);
    const ship = String(shipLabel || "")
      .trim()
      .toLowerCase();
    if (/^deliver/.test(ship)) orderStatus = "delivered";
    else if (/return/.test(ship)) orderStatus = "return";
    else if (
      /dispatch|in[\s-]*transit|shipped/.test(ship) &&
      ["packed", "processing", "confirmed", "placed", "pending"].indexOf(
        orderStatus,
      ) !== -1
    ) {
      orderStatus = "in_transit";
    }
    const website = WEBSITE_STATUS[orderStatus] || "pending";
    const tracking =
      TRACKING_STATUS[ship] || (ship ? ship.replace(/\s+/g, "_") : "pending");
    return { orderStatus, website, tracking };
  }

  function parseProducts(row) {
    const products = [];
    const nodes = row.querySelectorAll("td.col-3 b");
    for (const node of nodes) {
      const text = (node.textContent || "").replace(/\s+/g, " ").trim();
      const m = text.match(/^(\d+)\s*x\s+(.+)$/i);
      if (!m) continue;
      const qty = parseInt(m[1], 10);
      const name = m[2].trim();
      if (qty > 0 && name) products.push({ qty, name });
    }
    return products;
  }

  function linePrices(products, orderAmount) {
    const qtySum = products.reduce((sum, line) => sum + line.qty, 0) || 1;
    const unit = Math.round((orderAmount / qtySum) * 100) / 100;
    const prices = products.map(() => unit);
    if (!products.length) return prices;
    const sum = products.reduce(
      (total, line, i) => total + line.qty * prices[i],
      0,
    );
    const drift = Math.round((orderAmount - sum) * 100) / 100;
    if (drift) {
      const last = products.length - 1;
      prices[last] =
        Math.round((prices[last] + drift / products[last].qty) * 100) / 100;
    }
    return prices;
  }

  function shopifyOrderNumber(row, webOrderId) {
    const tips = row.querySelectorAll("td.col-2 [data-content]");
    for (const el of tips) {
      const raw = el.getAttribute("data-content") || "";
      const match = raw.match(/WEB ORDER NUMBER:\s*(?:<b>)?\s*(\d+)/i);
      if (match) return match[1];
    }
    const notes = row.querySelector("a.notes");
    if (notes) {
      const raw = notes.getAttribute("data-content") || "";
      const match = raw.match(/name=['"]webOrderNumber['"][^>]*value=['"](\d+)['"]/i);
      if (match) return match[1];
    }
    const stripped = String(webOrderId || "").replace(/^[A-Za-z]+/, "");
    return /^\d+$/.test(stripped) ? stripped : "";
  }

  function parseRow(row) {
    const orderId = (row.getAttribute("data-order-id") || "").trim();
    const webOrderId = (row.getAttribute("data-web-order-id") || "").trim();
    const shopifyOrderNo = shopifyOrderNumber(row, webOrderId);
    const city = (row.getAttribute("data-customer-city") || "").trim();
    const name = (row.getAttribute("data-customer-name") || "")
      .replace(/\s+/g, " ")
      .trim();
    const phone = digitsPhone(row.getAttribute("data-mobile-no"));
    const courier = (row.getAttribute("data-courier-service") || "").trim();
    const trackingNumber = (row.getAttribute("data-track-id") || "").trim();
    const paymentMethod = (row.getAttribute("data-payment-method") || "")
      .trim()
      .toLowerCase();

    let email = "";
    const clips = row.querySelectorAll("td.col-3 [data-clipboard-text]");
    for (const clip of clips) {
      const value = (clip.getAttribute("data-clipboard-text") || "").trim();
      if (value.indexOf("@") !== -1) {
        email = value;
        break;
      }
    }

    let address = "";
    const icon = row.querySelector("td.col-4 i.fa-location-arrow");
    const addressSpan = icon && icon.nextElementSibling;
    if (addressSpan)
      address = (addressSpan.textContent || "").replace(/\s+/g, " ").trim();

    const amountCell = row.querySelector("td.amountCol");
    const amountText = amountCell ? amountCell.textContent || "" : "";
    const orderAmount = matchMoney(amountText, "Order");
    const totalAmount = matchMoney(amountText, "Total");
    const offAmount = matchMoney(amountText, "OFF");
    let shipment = matchMoney(amountText, "DC");
    if (shipment == null && amountCell) {
      const deliveryInput = amountCell.querySelector(
        'input[placeholder="Delivery"]',
      );
      if (deliveryInput) shipment = money(deliveryInput.value);
    }
    if (shipment == null) shipment = 0;
    const merchandise = orderAmount == null ? 0 : orderAmount;
    const total = totalAmount == null ? merchandise + shipment : totalAmount;
    const discount =
      offAmount != null && offAmount > 0 ?
        offAmount
      : Math.max(0, Math.round((merchandise + shipment - total) * 100) / 100);

    let advance = 0;
    if (amountCell) {
      const pay = amountCell.querySelector(
        '[data-original-title="Payment Information"]',
      );
      if (pay)
        advance =
          matchMoney(
            pay.getAttribute("data-content") || "",
            "Advance Payment",
          ) || 0;
    }
    let amountReceived = advance;
    if (CONFIG.amountReceived === "total") amountReceived = total;
    else if (paymentMethod && paymentMethod !== "cod" && advance <= 0)
      amountReceived = total;

    const shipEl = row.querySelector('[title="Shipment Delivery Status"]');
    const shipLabel =
      shipEl ? (shipEl.textContent || "").replace(/\s+/g, " ").trim() : "";
    const beta = betaOrderStatus(row);
    const statuses = resolveStatuses(beta, shipLabel);

    const products = parseProducts(row);
    const prices = linePrices(products, merchandise);

    const noteParts = [];
    const cNote = row.querySelector("td.col-2 [data-content*='Courier Note']");
    if (cNote) {
      const plain = htmlToText(cNote.getAttribute("data-content") || "");
      const orderNote =
        (plain.match(/Order Note:\s*(.*?)(?:Courier Note:|$)/i) || [])[1] || "";
      const courierNote =
        (plain.match(/Courier Note:\s*(.*)$/i) || [])[1] || "";
      if (orderNote.trim()) noteParts.push(orderNote.trim());
      if (courierNote.trim()) noteParts.push(courierNote.trim());
    }
    const notesBtn = row.querySelector("a.notes");
    if (notesBtn) {
      const bodies = noteBodies(notesBtn.getAttribute("data-content") || "");
      if (bodies.length) noteParts.push(bodies.join(" | "));
    }
    if (shopifyOrderNo || webOrderId || orderId) {
      noteParts.push(
        "Beta " +
          [shopifyOrderNo && "#" + shopifyOrderNo, webOrderId, orderId]
            .filter(Boolean)
            .join(" / "),
      );
    }

    let latestTrack = "";
    const trackLink = row.querySelector(
      'td.courierCol a[data-original-title^="Tracking Status"]',
    );
    if (trackLink) {
      const log = trackLink.getAttribute("data-clipboard-text") || "";
      const lines = log
        .split(/\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      for (const line of lines) {
        if (
          /^\d{2}-\d{2}-\d{2}\s+\d/.test(line) &&
          !/booking date|printing date|last tracking|response time|courier account/i.test(
            line,
          )
        ) {
          latestTrack = line;
          break;
        }
      }
    }
    const detailParts = [];
    if (courier) detailParts.push("Courier: " + courier);
    if (trackingNumber) detailParts.push("CN: " + trackingNumber);
    if (latestTrack) detailParts.push(latestTrack);

    return {
      betaOrderId: orderId,
      webOrderId,
      shopifyOrderNo,
      name,
      email,
      phone,
      address,
      city,
      state: stateForCity(city),
      zip: "",
      country: CONFIG.country,
      note: noteParts.join(". ").slice(0, 2000),
      orderStatus: statuses.orderStatus,
      orderWebsiteStatus: statuses.website,
      courier,
      trackingNumber,
      trackingStatus: statuses.tracking,
      trackingDetails: detailParts.join(" | "),
      shipment,
      discount,
      amountReceived,
      paymentMethod,
      shipLabel,
      betaStatus: beta.label || beta.value,
      products,
      prices,
    };
  }

  function parseOrders(rootDoc) {
    const rows = rootDoc.querySelectorAll("tr[data-order-id]");
    const orders = [];
    for (const row of rows) orders.push(parseRow(row));
    return orders;
  }

  function lookupUrl() {
    if (CONFIG.lookupUrl) return CONFIG.lookupUrl;
    return String(CONFIG.apiUrl || "").replace(/\/order\/order_save\/?$/, "/shopify/lookup");
  }

  function authHeaders(json) {
    const headers = { Accept: "application/json" };
    if (json) headers["Content-Type"] = "application/json";
    const token = String(CONFIG.authToken || "").trim();
    if (token) {
      headers.Authorization =
        token.toLowerCase().indexOf("bearer ") === 0 ? token : "Bearer " + token;
    }
    return headers;
  }

  const productCache = new Map();

  async function lookupPosProductId(name) {
    const key = String(name || "").trim();
    if (!key) return { found: false, id: "", error: "Empty product name" };
    if (productCache.has(key)) return productCache.get(key);
    const url = lookupUrl() + "?name=" + encodeURIComponent(key);
    const res = await fetch(url, {
      method: "GET",
      headers: authHeaders(false),
      credentials: "omit",
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch (err) {
      body = null;
    }
    const id = body && body.pos_product_id ? String(body.pos_product_id).trim() : "";
    const result = {
      found: !!(body && body.found && id),
      id: id,
      error:
        id ? ""
        : (body && (body.error || body.message)) ||
          (res.ok ? "Lookup returned no pos_product_id" : "Lookup " + res.status),
    };
    productCache.set(key, result);
    console.log(
      result.found ? "Product " + key + " -> " + id : "Product not found: " + key + " (" + result.error + ")",
    );
    return result;
  }

  async function resolveOrderProducts(order) {
    const ids = [];
    for (const line of order.products) {
      const found = await lookupPosProductId(line.name);
      if (!found.found) {
        return { ok: false, error: line.name + ": " + found.error };
      }
      ids.push(found.id);
    }
    return { ok: true, ids: ids };
  }

  function buildPayload(order, productIds) {
    return {
      name: order.name,
      email: order.email,
      phone: order.phone,
      address: order.address,
      city: order.city,
      state: order.state,
      zip: order.zip,
      country: order.country,
      integration_id: CONFIG.integrationId,
      note: order.note,
      order_type: "website",
      order_status: order.orderStatus,
      order_website_status: order.orderWebsiteStatus,
      courier_tracking_number: order.trackingNumber,
      tracking_status: order.trackingStatus,
      tracking_details: order.trackingDetails,
      integration_order_id: order.shopifyOrderNo || order.webOrderId || order.betaOrderId,
      client_order_id: order.betaOrderId ? "beta-" + order.betaOrderId : "",
      discount: order.discount,
      shipment: order.shipment,
      amount_received: order.amountReceived,
      product_id: productIds,
      qty: order.products.map((line) => line.qty),
      price: order.prices,
    };
  }

  function openPageNumber() {
    try {
      const page = parseInt(new URL(root.location.href).searchParams.get("page") || "1", 10);
      return Number.isFinite(page) && page > 0 ? page : 1;
    } catch (err) {
      return 1;
    }
  }

  function pageUrl(page) {
    let base = CONFIG.listUrl;
    try {
      if (root.location && /orders\/index\.php/i.test(root.location.pathname || "")) {
        base = root.location.href;
      }
    } catch (err) {}
    const url = new URL(base, root.location && root.location.href);
    url.searchParams.set("page", String(page));
    return url.toString();
  }

  async function ordersForPage(page) {
    const live =
      root.document &&
      root.document.querySelector &&
      root.document.querySelector("tr[data-order-id]");
    if (live && page === openPageNumber()) {
      const orders = parseOrders(root.document);
      console.log(
        "Page " + page + ": reading the table already on screen (" + orders.length + " rows).",
      );
      return orders;
    }

    const target = pageUrl(page);
    let res;
    try {
      res = await fetch(target, { credentials: "include" });
    } catch (err) {
      const reason = err && err.message ? err.message : String(err);
      throw new Error(
        "Could not load " +
          target +
          " (" +
          reason +
          "). Open the orders list in this tab and run BetaOrderSync.run() again.",
      );
    }
    const html = await res.text();
    if (!/data-order-id\s*=/.test(html)) {
      if (/ecom login|sign in/i.test(html)) {
        throw new Error("Beta login page returned. Sign in and run BetaOrderSync.run() again.");
      }
      return [];
    }
    return parseOrders(new DOMParser().parseFromString(html, "text/html"));
  }

  function loadSent() {
    try {
      const raw = JSON.parse(localStorage.getItem(SENT_KEY) || "[]");
      return new Set(Array.isArray(raw) ? raw.map(String) : []);
    } catch (err) {
      return new Set();
    }
  }

  function saveSent(sent) {
    localStorage.setItem(SENT_KEY, JSON.stringify(Array.from(sent)));
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function postOrder(payload) {
    const res = await fetch(CONFIG.apiUrl, {
      method: "POST",
      headers: authHeaders(true),
      credentials: "omit",
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch (err) {
      body = { raw: text.slice(0, 500) };
    }
    return { ok: res.ok, status: res.status, body };
  }

  async function run() {
    if (root.__betaOrderSyncRunning) {
      console.warn("Beta order sync is already running.");
      return;
    }
    if (!String(CONFIG.authToken || "").trim()) {
      console.error(
        "Set CONFIG.authToken in data/beta_script.js to the POS Bearer token, then paste the script again.",
      );
      return;
    }
    root.__betaOrderSyncRunning = true;
    const sent = loadSent();
    const results = [];
    let posted = 0;
    try {
      console.log(
        "Beta sync: pages " +
          CONFIG.startPage +
          "-" +
          CONFIG.endPage +
          ", sending " +
          CONFIG.maxRecords +
          " new row(s). Already sent: " +
          sent.size +
          ".",
      );
      for (
        let page = CONFIG.startPage;
        page <= CONFIG.endPage && posted < CONFIG.maxRecords;
        page++
      ) {
        const orders = await ordersForPage(page);
        if (!orders.length) {
          console.log("Page " + page + " has no order rows. Stopping.");
          break;
        }
        console.log("Page " + page + ": " + orders.length + " rows.");
        for (const order of orders) {
          if (posted >= CONFIG.maxRecords) break;
          if (!order.betaOrderId) continue;
          if (sent.has(order.betaOrderId)) continue;
          const label = order.shopifyOrderNo || order.webOrderId || order.betaOrderId;
          if (!order.products.length) {
            posted += 1;
            results.push({
              id: label,
              ok: false,
              error: "No product line on the row",
            });
            console.warn(label + " skipped: no product line.");
            continue;
          }
          let resolved;
          try {
            resolved = await resolveOrderProducts(order);
          } catch (err) {
            posted += 1;
            results.push({
              id: label,
              ok: false,
              error: err && err.message ? err.message : String(err),
            });
            console.error(label + " product lookup failed", err);
            continue;
          }
          if (!resolved.ok) {
            posted += 1;
            results.push({ id: label, ok: false, error: resolved.error });
            console.warn(label + " product lookup failed: " + resolved.error);
            continue;
          }
          const payload = buildPayload(order, resolved.ids);
          console.log(
            "Sending " + (posted + 1) + "/" + CONFIG.maxRecords + " " + label,
            payload,
          );
          try {
            const response = await postOrder(payload);
            const duplicate = !!(response.body && response.body.duplicate);
            const ok = response.ok;
            if (ok) {
              sent.add(order.betaOrderId);
              saveSent(sent);
            }
            const orderNo =
              response.body && response.body.data ?
                response.body.data.order_no || response.body.data._id || ""
              : "";
            results.push({
              id: label,
              ok,
              status: response.status,
              duplicate,
              orderNo,
              error:
                ok ? "" : (
                  (response.body &&
                    (response.body.message || response.body.error)) ||
                  response.status
                ),
            });
            console.log(
              label +
                " -> " +
                response.status +
                (duplicate ? " already saved" : "") +
                (orderNo ? " " + orderNo : "") +
                (ok ? "" : (
                  " " +
                  ((response.body &&
                    (response.body.message || response.body.error)) ||
                    "")
                )),
            );
          } catch (err) {
            results.push({
              id: label,
              ok: false,
              error: err && err.message ? err.message : String(err),
            });
            console.error(label + " failed", err);
          }
          posted += 1;
          if (posted < CONFIG.maxRecords) await wait(CONFIG.delayMs);
        }
      }
      console.log("Beta sync finished.", results);
      console.table(results);
      return results;
    } catch (err) {
      console.error(err && err.message ? err.message : err);
    } finally {
      root.__betaOrderSyncRunning = false;
    }
  }

  function reset() {
    localStorage.removeItem(SENT_KEY);
    console.log("Cleared sent Beta order ids.");
  }

  const api = { CONFIG, run, reset, parseRow, parseOrders, buildPayload };
  root.BetaOrderSync = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;

  const host = root.location && root.location.hostname;
  if (host && /(^|\.)betalogics\.com$/i.test(host)) {
    run().catch(function (err) {
      console.error(err && err.message ? err.message : err);
    });
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
