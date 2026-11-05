/**
 * Stamp company + PostEx logos onto a PostEx airway-bill PDF.
 * When COD: overwrite Amount (0.00/-) and Order Type (Normal → COD).
 * Layout measured from PostEx get-invoice A4 (595×842):
 *   Amount value @ (497, 661.5), Order Type value @ (497, 608)
 */

const fs = require("fs");
const path = require("path");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");

const toUploadRelativePath = (raw) => {
  if (!raw || typeof raw !== "string") return "";
  let p = raw.trim().replace(/\\/g, "/");
  if (!p) return "";

  if (/^https?:\/\//i.test(p)) {
    try {
      const u = new URL(p);
      p = u.pathname || "";
    } catch {
      return "";
    }
  }

  const idx = p.toLowerCase().indexOf("/uploads/");
  if (idx >= 0) p = p.slice(idx + 1);
  while (p.startsWith("/")) p = p.slice(1);
  while (p.startsWith("uploads/uploads/")) {
    p = p.replace("uploads/uploads/", "uploads/");
  }
  if (!p.startsWith("uploads/")) {
    p = `uploads/${p}`;
  }
  if (p.includes("..")) return "";
  return p;
};

const readLogoBytes = async (source) => {
  const raw =
    source?.company_logo ||
    source?.companyLogo ||
    source?.logo ||
    source?.logo_image ||
    source?.image ||
    source?.store_image ||
    source?.storeImage ||
    (typeof source === "string" ? source : "");
  if (!raw || typeof raw !== "string") return null;

  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const res = await fetch(trimmed);
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length ? buf : null;
    } catch {
      return null;
    }
  }

  const relative = toUploadRelativePath(trimmed);
  if (!relative) return null;
  const candidates = [
    path.join(process.cwd(), relative),
    path.join(process.cwd(), "public", relative),
    path.join(process.cwd(), "uploads", path.basename(relative)),
  ];
  for (const abs of candidates) {
    try {
      if (fs.existsSync(abs)) {
        const buf = fs.readFileSync(abs);
        if (buf.length) return buf;
      }
    } catch {
      /* try next */
    }
  }

  // Fallback: fetch from this host when the file is served under /uploads.
  const publicBase = String(process.env.PUBLIC_API_ORIGIN || process.env.APP_URL || "")
    .trim()
    .replace(/\/$/, "");
  if (publicBase) {
    try {
      const res = await fetch(`${publicBase}/${relative.replace(/^\/+/, "")}`);
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length) return buf;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
};

const toPngBytes = async (bytes) => {
  if (!bytes || !bytes.length) return null;
  try {
    const sharp = require("sharp");
    return await sharp(bytes).png().toBuffer();
  } catch {
    return null;
  }
};

/** Trim transparent/white padding so the drawn box matches the visible mark. */
const toTrimmedPngBytes = async (bytes) => {
  if (!bytes || !bytes.length) return null;
  try {
    const sharp = require("sharp");
    // Flatten soft/white edges then trim hard so wordmarks don't keep a tall empty box.
    return await sharp(bytes)
      .rotate()
      .flatten({ background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .trim({ threshold: 28 })
      .png()
      .toBuffer();
  } catch {
    try {
      const sharp = require("sharp");
      return await sharp(bytes).trim({ threshold: 20 }).png().toBuffer();
    } catch {
      return toPngBytes(bytes);
    }
  }
};

const embedImage = async (pdfDoc, bytes) => {
  if (!bytes || !bytes.length) return null;
  const trimmed = await toTrimmedPngBytes(bytes);
  if (trimmed) {
    try {
      return await pdfDoc.embedPng(trimmed);
    } catch {
      /* fall through to raw bytes */
    }
  }
  try {
    return await pdfDoc.embedPng(bytes);
  } catch {
    try {
      return await pdfDoc.embedJpg(bytes);
    } catch {
      const png = await toPngBytes(bytes);
      if (!png) return null;
      try {
        return await pdfDoc.embedPng(png);
      } catch {
        return null;
      }
    }
  }
};

const formatCodAmountLabel = (amount) => {
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) return "0.00/-";
  return `${n.toFixed(2)}/-`;
};

/**
 * @param {Buffer} pdfBuffer
 * @param {object|null} company
 * @param {{ isCod?: boolean, codAmount?: number|string }} [options]
 * @returns {Promise<Buffer>}
 */
async function stampPostexLabelLogos(pdfBuffer, company = null, options = {}) {
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length < 5) return pdfBuffer;

  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const pages = pdfDoc.getPages();
  if (!pages.length) return pdfBuffer;

  const page = pages[0];
  const { width, height } = page.getSize();
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const logoH = Math.min(34, Math.max(22, height * 0.1));
  const topPad = 10;
  const leftPad = 10;
  const gap = 10;
  const brandStripW = Math.min(175, width * 0.32);
  const y = height - logoH - topPad;

  // Cover the default PostEx text-logo strip so we can redraw branding.
  page.drawRectangle({
    x: leftPad - 4,
    y: y - 6,
    width: brandStripW,
    height: logoH + 12,
    color: rgb(1, 1, 1),
  });

  let cursorX = leftPad;
  const companyBytes = await readLogoBytes(company);
  const companyImg = await embedImage(pdfDoc, companyBytes);

  if (companyImg) {
    const aspect = companyImg.width / Math.max(companyImg.height, 1);
    let drawH = logoH;
    let drawW = drawH * aspect;
    const maxW = 72;
    if (drawW > maxW) {
      drawW = maxW;
      drawH = drawW / aspect;
    }
    page.drawImage(companyImg, {
      x: cursorX,
      y: y + (logoH - drawH) / 2,
      width: drawW,
      height: drawH,
    });
    cursorX += drawW + gap;
  }

  // PostEx wordmark (matches their green-dot branding).
  const fontSize = Math.min(18, logoH * 0.55);
  const textY = y + (logoH - fontSize) / 2 + 1;
  page.drawText("PostEx", {
    x: cursorX,
    y: textY,
    size: fontSize,
    font,
    color: rgb(0.05, 0.05, 0.05),
  });
  const textWidth = font.widthOfTextAtSize("PostEx", fontSize);
  page.drawCircle({
    x: cursorX + textWidth + 5,
    y: textY + fontSize * 0.35,
    size: Math.max(2.5, fontSize * 0.18),
    color: rgb(0.18, 0.72, 0.28),
  });

  const isCod =
    options.isCod === true ||
    options.isCod === "true" ||
    options.isCod === "1" ||
    options.isCod === 1;
  const codAmount = Number(options.codAmount);
  if (isCod && Number.isFinite(codAmount) && codAmount >= 0) {
    const ink = rgb(0.05, 0.05, 0.05);
    const white = rgb(1, 1, 1);
    const scaleX = width / 595;
    const scaleY = height / 842;

    // Measured on PostEx A4 airway bill (595×842).
    const amountX = 497 * scaleX;
    const amountY = 661.5 * scaleY;
    const typeX = 497 * scaleX;
    const typeY = 608 * scaleY;
    const amountSize = Math.max(9, 10 * Math.min(scaleX, scaleY));
    const typeSize = Math.max(9, 10 * Math.min(scaleX, scaleY));

    const amountText = formatCodAmountLabel(codAmount);
    const amountW = Math.max(
      70 * scaleX,
      font.widthOfTextAtSize(amountText, amountSize) + 8,
    );
    const amountH = amountSize + 6;
    page.drawRectangle({
      x: amountX - 2,
      y: amountY - 2,
      width: amountW,
      height: amountH,
      color: white,
    });
    page.drawText(amountText, {
      x: amountX,
      y: amountY,
      size: amountSize,
      font,
      color: ink,
    });

    const typeText = "COD";
    const typeW = Math.max(
      50 * scaleX,
      font.widthOfTextAtSize(typeText, typeSize) + 8,
    );
    const typeH = typeSize + 6;
    page.drawRectangle({
      x: typeX - 2,
      y: typeY - 2,
      width: typeW,
      height: typeH,
      color: white,
    });
    page.drawText(typeText, {
      x: typeX,
      y: typeY,
      size: typeSize,
      font,
      color: ink,
    });
  }

  const out = await pdfDoc.save();
  return Buffer.from(out);
}

/**
 * Stamp store logo once on the TOP Flaship label only (per_page=2 leaves bottom blank).
 * Aligns just right of the Trax/carrier mark, vertically with the header band.
 *
 * @param {import('pdf-lib').PDFPage} page
 * @param {import('pdf-lib').PDFImage} logoImg
 */
function drawAlignedStoreLogoOnLabelHeader(page, logoImg) {
  const { width, height } = page.getSize();
  // Cell 2 between Trax and barcode. Align with Trax mark center (~40pt from top).
  const colLeft = 105;
  const colRight = Math.min(196, width * 0.33);
  const colW = colRight - colLeft;
  const wipeTop = 8;
  const wipeBottom = 70;
  const wipeH = wipeBottom - wipeTop;
  const logoCenterFromTop = 40;

  // Fit inside the header cell; keep clear of the COD divider (~70pt).
  const maxW = Math.max(28, colW - 16);
  const maxH = 30;
  const aspect = logoImg.width / Math.max(logoImg.height, 1);
  let drawH = Math.min(maxH, wipeH - 18);
  let drawW = drawH * aspect;
  if (drawW > maxW) {
    drawW = maxW;
    drawH = drawW / aspect;
  }

  const x = colLeft + (colW - drawW) / 2;
  const y = height - logoCenterFromTop - drawH / 2;

  page.drawRectangle({
    x: colLeft + 1,
    y: height - wipeBottom + 1,
    width: colW - 2,
    height: wipeH - 2,
    color: rgb(1, 1, 1),
  });
  page.drawImage(logoImg, { x, y, width: drawW, height: drawH });
}

function stampShipperNameAndPhone(
  page,
  font,
  fontBold,
  shipperName,
  shipperPhone,
  shipperEmail,
  shipperCity = "",
) {
  const name = safeText(shipperName);
  const phone = safeText(shipperPhone);
  const email = safeText(shipperEmail);
  const city = safeText(shipperCity);
  if (!name && !phone && !email && !city) return;

  const { width, height } = page.getSize();
  const labelH = height / 2;
  // Full shipper body: past left border → near center divider (must erase BBG leftovers).
  const coverX = 12;
  const coverW = Math.min(275, width * 0.47 - 14);
  const textX = 32;
  const textMaxW = coverW - (textX - coverX) - 6;
    const nameSize = 11;
  const phoneSize = 10;
  const emailSize = 9.5;
  const citySize = 10;
  const lineGap = 14;
  // First content line under the SHIPPER heading.
  const nameY = height - labelH * 0.335;
  const rows = [name, phone, email, city].filter(Boolean);
  // Keep wipe inside shipper body only — never into ORIGIN/DEST row (~0.45+).
  const padTop = 4;
  const padBottom = 4;
  const minCoverBottom = height - labelH * 0.445;
  const naturalBottom = nameY - (rows.length - 1) * lineGap - padBottom;
  const coverBottom = Math.max(minCoverBottom, naturalBottom);
  const coverTop = nameY + padTop + 2;
  const coverH = Math.max(36, coverTop - coverBottom);

  page.drawRectangle({
    x: coverX,
    y: coverBottom,
    width: coverW,
    height: coverH,
    color: rgb(1, 1, 1),
  });

  let y = nameY;
  if (name) {
    page.drawText(clip(fontBold, name, nameSize, textMaxW), {
      x: textX,
      y,
      size: nameSize,
      font: fontBold,
      color: rgb(0.05, 0.05, 0.05),
    });
    y -= lineGap;
  }
  if (phone) {
    page.drawText(clip(font, phone, phoneSize, textMaxW), {
      x: textX,
      y,
      size: phoneSize,
      font,
      color: rgb(0.1, 0.1, 0.1),
    });
    y -= lineGap;
  }
  if (email) {
    page.drawText(clip(font, email, emailSize, textMaxW), {
      x: textX,
      y,
      size: emailSize,
      font,
      color: rgb(0.1, 0.1, 0.1),
    });
    y -= lineGap;
  }
  if (city) {
    page.drawText(clip(fontBold, city.toUpperCase(), citySize, textMaxW), {
      x: textX,
      y,
      size: citySize,
      font: fontBold,
      color: rgb(0.05, 0.05, 0.05),
    });
  }
}

/**
 * Replace Trax "Booked" YYYY-MM-DD with DD/MM/YYYY on the A4 2-up label.
 */
function stampBookedDate(page, fontBold, bookedRaw) {
  const formatted = formatDayMonthYear(bookedRaw);
  if (!formatted) return;

  const { width, height } = page.getSize();
  const labelH = height / 2;
  // Booked value cell — left column of the details grid (under Order ID).
  const coverX = Math.min(198, width * 0.333);
  const coverW = Math.min(88, width * 0.15);
  const dateY = height - labelH * 0.585;
  const coverH = 13;
  const coverBottom = dateY - 3;

  page.drawRectangle({
    x: coverX,
    y: coverBottom,
    width: coverW,
    height: coverH,
    color: rgb(1, 1, 1),
  });

  page.drawText(formatted, {
    x: coverX + 4,
    y: dateY,
    size: 9,
    font: fontBold,
    color: rgb(0.05, 0.05, 0.05),
  });
}

/**
 * Replace abbreviated Trax "DEST" header with full "Destination".
 * Measured on A4 2-up Trax label (upper half), middle column of ORIGIN|DEST|PIECES.
 */
function stampDestinationHeading(page, font) {
  const { width, height } = page.getSize();
  const labelH = height / 2;
  // Middle column header beside ORIGIN — keep clear of LAHORE value below.
  const coverX = Math.min(120, width * 0.202);
  const coverW = Math.min(78, width * 0.14);
  const textY = height - labelH * 0.472;
  const fontSize = 8;
  const coverH = 12;
  const coverBottom = textY - 2;

  page.drawRectangle({
    x: coverX,
    y: coverBottom,
    width: coverW,
    height: coverH,
    color: rgb(1, 1, 1),
  });

  page.drawText("Destination", {
    x: coverX + 1,
    y: textY,
    size: fontSize,
    font,
    color: rgb(0.15, 0.15, 0.15),
  });
}

/**
 * @param {Buffer} pdfBuffer
 * @param {object|string|null} logoSource
 * @returns {Promise<Buffer>}
 */
async function stampFlagshipLabelStoreLogo(pdfBuffer, logoSource = null) {
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length < 5) return pdfBuffer;

  const logoBytes = await readLogoBytes(logoSource);
  if (!logoBytes) return pdfBuffer;

  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const pages = pdfDoc.getPages();
  if (!pages.length) return pdfBuffer;

  const logoImg = await embedImage(pdfDoc, logoBytes);
  if (!logoImg) return pdfBuffer;

  // Only the first page top label — never stamp mid-page (empty 2nd slot).
  drawAlignedStoreLogoOnLabelHeader(pages[0], logoImg);

  const out = await pdfDoc.save();
  return Buffer.from(out);
}

const moneyRs = (n) => {
  const v = Number(n);
  const safe = Number.isFinite(v) ? v : 0;
  return `Rs. ${safe.toLocaleString("en-PK", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
};

/** Format as day/month/year (DD/MM/YYYY). */
const formatDayMonthYear = (value) => {
  if (value == null || value === "") return "";
  const raw = String(value).trim();
  const isoDay = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoDay) return `${isoDay[3]}/${isoDay[2]}/${isoDay[1]}`;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
};

const shortDate = (iso) => formatDayMonthYear(iso) || "—";

/** Helvetica (WinAnsi) safe text — drop unsupported glyphs. */
const safeText = (value) =>
  String(value || "")
    .replace(/[^\x20-\x7E\u00A0-\u00FF]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const clip = (font, text, size, maxW) => {
  let t = safeText(text);
  if (!t) return "";
  if (font.widthOfTextAtSize(t, size) <= maxW) return t;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}...`, size) > maxW) {
    t = t.slice(0, -1);
  }
  return `${t}...`;
};

/** Word-wrap text into up to `maxLines` lines (last line ellipsized if still too long). */
const wrapLines = (font, text, size, maxW, maxLines = 2) => {
  const raw = safeText(text);
  if (!raw) return [];
  if (font.widthOfTextAtSize(raw, size) <= maxW) return [raw];

  const words = raw.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";

  const pushLine = (line, isLastSlot) => {
    const value = String(line || "").trim();
    if (!value) return;
    if (font.widthOfTextAtSize(value, size) <= maxW) {
      lines.push(value);
      return;
    }
    lines.push(clip(font, value, size, maxW));
  };

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    const next = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= maxW) {
      current = next;
      continue;
    }
    if (current) {
      pushLine(current, lines.length + 1 >= maxLines);
      current = word;
    } else {
      pushLine(word, lines.length + 1 >= maxLines);
      current = "";
    }
    if (lines.length >= maxLines) {
      // Remaining words go into the last line (clipped).
      const rest = [current, ...words.slice(i + 1)].filter(Boolean).join(" ");
      if (rest) {
        lines[lines.length - 1] = clip(
          font,
          `${lines[lines.length - 1]} ${rest}`.trim(),
          size,
          maxW,
        );
      }
      return lines.slice(0, maxLines);
    }
  }
  if (current && lines.length < maxLines) pushLine(current, true);
  return lines.slice(0, maxLines);
};

/**
 * Flaship A4 2-up pack: keep Trax label on top, draw sales invoice in the empty bottom half.
 *
 * @param {Buffer} pdfBuffer
 * @param {object} ctx
 * @param {object|null} ctx.company
 * @param {object|null} ctx.integration
 * @param {object|null} ctx.order
 * @param {object[]} [ctx.items]
 * @param {string} [ctx.courierName]
 * @param {string} [ctx.paymentMethod]
 * @returns {Promise<Buffer>}
 */
async function composeFlagshipLabelWithInvoice(pdfBuffer, ctx = {}) {
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length < 5) return pdfBuffer;

  const logoSource = ctx.integration?.image ? ctx.integration : ctx.company;
  const logoBytes = await readLogoBytes(logoSource);

  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const pages = pdfDoc.getPages();
  if (!pages.length) return pdfBuffer;

  const page = pages[0];
  const { width, height } = page.getSize();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.08, 0.08, 0.08);
  const muted = rgb(0.35, 0.35, 0.35);
  const line = rgb(0.7, 0.72, 0.74);
  const headerBg = rgb(0.925, 0.935, 0.94);

  const logoImg = logoBytes ? await embedImage(pdfDoc, logoBytes) : null;
  if (logoImg) {
    drawAlignedStoreLogoOnLabelHeader(page, logoImg);
  }

  const order = ctx.order || {};
  const company = ctx.company || {};
  const integration = ctx.integration || {};
  const items = Array.isArray(ctx.items) ? ctx.items : [];

  // Prefer integration store name/phone (e.g. Night Suit / 0331…) over Flaship pickup.
  const shipperName =
    integration.name ||
    integration.store_name ||
    company.company_name ||
    company.name ||
    "";
  const shipperPhone =
    integration.phone ||
    company.company_phone ||
    company.phone ||
    "";
  const shipperEmail =
    integration.email ||
    company.company_email ||
    company.email ||
    "";
  const shipperCity =
    integration.city ||
    company.company_city ||
    company.city ||
    order.shipper_city ||
    order.origin_city ||
    "";
  stampShipperNameAndPhone(
    page,
    font,
    fontBold,
    shipperName,
    shipperPhone,
    shipperEmail,
    shipperCity,
  );
  // Erase stray Flaship leftovers in the consignee address column.
  {
    const labelH = height / 2;
    page.drawRectangle({
      x: width * 0.5 + 8,
      y: height - labelH * 0.42,
      width: 14,
      height: labelH * 0.12,
      color: rgb(1, 1, 1),
    });
  }

  const bookedRaw =
    ctx.bookedDate ||
    order.booked_at ||
    order.bookedAt ||
    order.shipped_at ||
    order.createdAt ||
    order.created_at ||
    "";
  // stampBookedDate disabled — prior coords drew into REMARKS.
  // stampBookedDate(page, fontBold, bookedRaw);
  // stampDestinationHeading disabled — prior coords overlapped ORDER REF.
  // stampDestinationHeading(page, font);

  // Bottom half invoice area (Flaship per_page=2 leaves this blank).
  const midY = height / 2;
  const marginX = 28;
  const contentW = width - marginX * 2;
  let cursorY = midY - 18;

  // Clear bottom half so stray stamps / faint marks don't show.
  page.drawRectangle({
    x: 0,
    y: 0,
    width,
    height: midY - 4,
    color: rgb(1, 1, 1),
  });

  const companyName =
    shipperName ||
    company.company_name ||
    company.name ||
    company.store_name ||
    "Store";
  const companyAddress =
    integration.address ||
    company.company_address ||
    company.address ||
    company.companyAddress ||
    "";
  const companyPhone = shipperPhone || company.company_phone || company.phone || "";
  const companyEmail =
    integration.email || company.company_email || company.email || "";

  // Header: store logo + address | INVOICE + customer
  const invLogoH = 34;
  const leftColW = contentW * 0.48;
  let leftX = marginX;
  let logoDrawH = 0;
  if (logoImg) {
    const aspect = logoImg.width / Math.max(logoImg.height, 1);
    let h = invLogoH;
    let w = h * aspect;
    if (w > 72) {
      w = 72;
      h = w / aspect;
    }
    logoDrawH = h;
    // Align logo top with the first text line of the address block.
    page.drawImage(logoImg, {
      x: leftX,
      y: cursorY - 10 - h + 8,
      width: w,
      height: h,
    });
    leftX += w + 8;
  }

  const detailX = leftX;
  const detailSize = 8;
  const addrMaxW = Math.max(90, leftColW - (detailX - marginX));
  let detailY = cursorY - 10;
  if (!logoImg) {
    page.drawText(clip(fontBold, companyName, 11, leftColW), {
      x: detailX,
      y: cursorY - 12,
      size: 11,
      font: fontBold,
      color: ink,
    });
    detailY = cursorY - 26;
  }

  const addressLines = wrapLines(font, companyAddress, detailSize, addrMaxW, 2);
  for (const row of addressLines) {
    page.drawText(row, {
      x: detailX,
      y: detailY,
      size: detailSize,
      font,
      color: muted,
    });
    detailY -= 11;
  }
  for (const row of [companyPhone, companyEmail].filter((v) => String(v || "").trim())) {
    page.drawText(clip(font, row, detailSize, addrMaxW), {
      x: detailX,
      y: detailY,
      size: detailSize,
      font,
      color: muted,
    });
    detailY -= 11;
  }
  // Keep header block height consistent when logo is taller than text.
  if (logoImg) {
    const logoBottom = cursorY - 10 - logoDrawH + 8;
    if (detailY > logoBottom - 4) detailY = logoBottom - 4;
  }

  const rightX = width / 2 + 8;
  const rightColW = contentW * 0.45;
  page.drawText("INVOICE", {
    x: rightX,
    y: cursorY - 16,
    size: 22,
    font: fontBold,
    color: ink,
  });
  let custY = cursorY - 34;
  const customerName = order.name || order.customer_name || "—";
  const customerAddress = [order.address, order.city, order.state || order.province, order.zip]
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .join(", ");

  page.drawText(clip(fontBold, customerName, 9.5, rightColW), {
    x: rightX,
    y: custY,
    size: 9.5,
    font: fontBold,
    color: ink,
  });
  custY -= 12;

  for (const row of wrapLines(font, customerAddress, 8, rightColW, 2)) {
    page.drawText(row, {
      x: rightX,
      y: custY,
      size: 8,
      font,
      color: ink,
    });
    custY -= 10;
  }
  for (const row of [order.email || "", order.phone || ""].filter((v) =>
    String(v || "").trim(),
  )) {
    page.drawText(clip(font, row, 8, rightColW), {
      x: rightX,
      y: custY,
      size: 8,
      font,
      color: ink,
    });
    custY -= 10;
  }

  cursorY = Math.min(detailY, custY) - 10;

  // Meta row
  const metaTop = cursorY;
  page.drawLine({
    start: { x: marginX, y: metaTop },
    end: { x: width - marginX, y: metaTop },
    thickness: 0.8,
    color: line,
  });
  const metaY = metaTop - 14;
  const orderDate = shortDate(order.createdAt || order.created_at);
  const invoiceNo = String(order.order_no || order.orderNo || order._id || "").trim();
  const courierName = String(ctx.courierName || "").trim().toUpperCase() || "—";
  const payMethod = String(ctx.paymentMethod || "COD").trim() || "COD";

  page.drawText(`Order Date: ${orderDate}`, {
    x: marginX,
    y: metaY,
    size: 8.5,
    font: fontBold,
    color: ink,
  });
  page.drawText(`Courier: ${courierName}`, {
    x: width / 2 + 8,
    y: metaY,
    size: 8.5,
    font: fontBold,
    color: ink,
  });
  page.drawText(`Invoice Number: ${invoiceNo}`, {
    x: marginX,
    y: metaY - 13,
    size: 8.5,
    font: fontBold,
    color: ink,
  });
  page.drawText(`Payment Method: ${payMethod}`, {
    x: width / 2 + 8,
    y: metaY - 13,
    size: 8.5,
    font: fontBold,
    color: ink,
  });
  page.drawLine({
    start: { x: marginX, y: metaY - 20 },
    end: { x: width - marginX, y: metaY - 20 },
    thickness: 0.8,
    color: line,
  });

  cursorY = metaY - 28;

  // Product table header
  const colHash = marginX;
  const colImg = marginX + 22;
  const colProduct = marginX + 58;
  const colQty = width - marginX - 170;
  const colRate = width - marginX - 110;
  const colAmt = width - marginX - 50;
  const rowH = 34;
  const thumbSize = 24;

  page.drawRectangle({
    x: marginX,
    y: cursorY - 16,
    width: contentW,
    height: 16,
    color: headerBg,
  });
  const headY = cursorY - 12;
  [
    [colHash, "#"],
    [colImg, "Image"],
    [colProduct, "Product"],
    [colQty, "Qty"],
    [colRate, "Rate"],
    [colAmt, "Amount"],
  ].forEach(([x, label]) => {
    page.drawText(label, {
      x,
      y: headY,
      size: 8,
      font: fontBold,
      color: ink,
    });
  });
  cursorY -= 18;

  let subTotal = 0;
  const maxRows = Math.max(1, Math.floor((cursorY - 70) / rowH));
  const rows = items.slice(0, maxRows);
  if (!rows.length) {
    page.drawText("No items", {
      x: colProduct,
      y: cursorY - 14,
      size: 8,
      font,
      color: muted,
    });
    cursorY -= rowH;
  }

  for (let i = 0; i < rows.length; i += 1) {
    const item = rows[i] || {};
    const qty = Number(item.qty) || 1;
    const rate = Number(item.price ?? item.rate) || 0;
    const amount = Number(item.subtotal) || qty * rate;
    subTotal += amount;
    const name = item.name || item.product_name || "Item";
    const sku = item.sku || item.product_code || "";
    const rowTop = cursorY;
    const rowBottom = cursorY - rowH;
    // Vertically center thumbnail inside the row (below header/rule).
    const thumbY = rowBottom + (rowH - thumbSize) / 2;
    const textMidY = rowBottom + rowH / 2 - 3;

    page.drawLine({
      start: { x: marginX, y: rowTop },
      end: { x: width - marginX, y: rowTop },
      thickness: 0.5,
      color: line,
    });

    page.drawText(String(i + 1), {
      x: colHash + 4,
      y: textMidY,
      size: 8,
      font,
      color: ink,
    });

    if (item.imageUrl || item.image || item.product_image) {
      try {
        const imgBytes = await readLogoBytes(
          item.imageUrl || item.image || item.product_image,
        );
        const thumb = imgBytes ? await embedImage(pdfDoc, imgBytes) : null;
        if (thumb) {
          page.drawRectangle({
            x: colImg - 0.5,
            y: thumbY - 0.5,
            width: thumbSize + 1,
            height: thumbSize + 1,
            color: rgb(1, 1, 1),
            borderColor: line,
            borderWidth: 0.4,
          });
          page.drawImage(thumb, {
            x: colImg,
            y: thumbY,
            width: thumbSize,
            height: thumbSize,
          });
        }
      } catch {
        /* skip thumb */
      }
    }

    page.drawText(clip(fontBold, name, 8, colQty - colProduct - 8), {
      x: colProduct,
      y: sku ? textMidY + 5 : textMidY,
      size: 8,
      font: fontBold,
      color: ink,
    });
    if (sku) {
      page.drawText(clip(font, `SKU: ${sku}`, 7, colQty - colProduct - 8), {
        x: colProduct,
        y: textMidY - 7,
        size: 7,
        font,
        color: muted,
      });
    }

    page.drawText(String(qty), {
      x: colQty,
      y: textMidY,
      size: 8,
      font,
      color: ink,
    });
    page.drawText(moneyRs(rate), {
      x: colRate,
      y: textMidY,
      size: 8,
      font,
      color: ink,
    });
    page.drawText(moneyRs(amount), {
      x: colAmt,
      y: textMidY,
      size: 8,
      font: fontBold,
      color: ink,
    });

    cursorY = rowBottom;
  }

  page.drawLine({
    start: { x: marginX, y: cursorY },
    end: { x: width - marginX, y: cursorY },
    thickness: 0.5,
    color: line,
  });

  const shipping = Number(order.shipping ?? order.shipment ?? 0) || 0;
  const discount = Number(order.discount ?? order.discount_amount ?? 0) || 0;
  const total =
    Number(order.total_amount ?? order.totalAmount ?? order.grand_total ?? 0) ||
    Math.max(0, subTotal - discount + shipping);

  const sumX = width - marginX - 180;
  let sumY = cursorY - 18;
  page.drawText("Delivery Charges", {
    x: sumX,
    y: sumY,
    size: 9,
    font,
    color: muted,
  });
  page.drawText(moneyRs(shipping), {
    x: sumX + 110,
    y: sumY,
    size: 9,
    font,
    color: ink,
  });
  sumY -= 16;
  page.drawText("Total Amount", {
    x: sumX,
    y: sumY,
    size: 11,
    font: fontBold,
    color: ink,
  });
  page.drawText(moneyRs(total), {
    x: sumX + 110,
    y: sumY,
    size: 11,
    font: fontBold,
    color: ink,
  });

  const out = await pdfDoc.save();
  return Buffer.from(out);
}

module.exports = {
  stampPostexLabelLogos,
  stampFlagshipLabelStoreLogo,
  composeFlagshipLabelWithInvoice,
  readLogoBytes,
  formatCodAmountLabel,
};
