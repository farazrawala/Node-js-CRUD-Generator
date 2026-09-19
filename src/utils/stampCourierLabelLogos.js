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

const readLogoBytes = async (company) => {
  const raw =
    company?.company_logo ||
    company?.companyLogo ||
    company?.logo ||
    company?.logo_image ||
    "";
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
  const abs = path.join(process.cwd(), relative);
  try {
    if (!fs.existsSync(abs)) return null;
    return fs.readFileSync(abs);
  } catch {
    return null;
  }
};

const embedImage = async (pdfDoc, bytes) => {
  if (!bytes || !bytes.length) return null;
  try {
    return await pdfDoc.embedPng(bytes);
  } catch {
    try {
      return await pdfDoc.embedJpg(bytes);
    } catch {
      return null;
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

module.exports = {
  stampPostexLabelLogos,
  readLogoBytes,
  formatCodAmountLabel,
};
