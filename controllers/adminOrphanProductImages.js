const Company = require("../models/company");
const routeRegistry = require("../utils/routeRegistry");
const {
  findOrphanProductImages,
  deleteOrphanProductImages,
  formatBytes,
} = require("../utils/orphanProductImages");
const { withBasePath } = require("../utils/basePath");

const PAGE_PATH = "/admin/products/unused-images";
const pageUrl = (qs = "") => withBasePath(`${PAGE_PATH}${qs}`);

function parsePage(value, fallback = 1) {
  const n = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseLimit(value, fallback = 50) {
  const n = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 200);
}

async function loadCompanies() {
  return Company.find({
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  })
    .select("company_name")
    .sort({ company_name: 1 })
    .lean();
}

function buildQueryString(params) {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      q.set(key, String(value));
    }
  });
  const s = q.toString();
  return s ? `?${s}` : "";
}

async function renderUnusedImages(req, res) {
  try {
    const companyId = String(req.query.company_id || "").trim() || null;
    const activeOnly = String(req.query.active_only || "") === "1";
    const search = String(req.query.search || "").trim().toLowerCase();
    const page = parsePage(req.query.page, 1);
    const limit = parseLimit(req.query.limit, 50);

    const [companies, scan] = await Promise.all([
      loadCompanies(),
      findOrphanProductImages({ companyId, activeOnly }),
    ]);

    let orphans = scan.orphans;
    if (search) {
      orphans = orphans.filter(
        (o) =>
          o.key.toLowerCase().includes(search) ||
          o.fileName.toLowerCase().includes(search) ||
          String(o.productId || "")
            .toLowerCase()
            .includes(search),
      );
    }

    const totalItems = orphans.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / limit));
    const currentPage = Math.min(page, totalPages);
    const start = (currentPage - 1) * limit;
    const pageItems = orphans.slice(start, start + limit);
    const totalBytes = orphans.reduce((sum, o) => sum + (o.size || 0), 0);

    const filterParams = {
      company_id: companyId || "",
      active_only: activeOnly ? "1" : "",
      search: search || "",
      limit: String(limit),
    };

    res.render("admin/orphan-product-images", {
      title: "Unused Product Images",
      modelName: "products",
      routes: req.routes || routeRegistry.getEnabledRoutes(),
      baseUrl: req.baseUrl || process.env.BASE_URL || "http://localhost:8000",
      customTabs: routeRegistry.getCustomTabs("products"),
      customTabsActivePath: PAGE_PATH,
      companies,
      filters: {
        company_id: companyId || "",
        active_only: activeOnly,
        search: search || "",
        limit,
      },
      stats: {
        productsScanned: scan.productsScanned,
        filesOnDisk: scan.filesOnDisk,
        linkedPaths: scan.linkedPaths,
        orphanCount: totalItems,
        orphanSizeLabel: formatBytes(totalBytes),
      },
      orphans: pageItems,
      pagination: {
        currentPage,
        totalPages,
        totalItems,
        itemsPerPage: limit,
        hasNextPage: currentPage < totalPages,
        hasPrevPage: currentPage > 1,
        prevUrl:
          currentPage > 1
            ? pageUrl(
                buildQueryString({ ...filterParams, page: currentPage - 1 }),
              )
            : null,
        nextUrl:
          currentPage < totalPages
            ? pageUrl(
                buildQueryString({ ...filterParams, page: currentPage + 1 }),
              )
            : null,
      },
      success: req.flash ? req.flash("success") : [],
      error: req.flash ? req.flash("error") : [],
    });
  } catch (error) {
    console.error("Unused product images error:", error);
    res.status(500).render("admin/error", {
      title: "Error",
      message: "Error loading unused product images",
      error: { statusCode: 500, message: error.message || "Internal server error" },
    });
  }
}

async function deleteUnusedImages(req, res) {
  const companyId = String(req.body.company_id || req.query.company_id || "").trim() || null;
  const activeOnly =
    String(req.body.active_only || req.query.active_only || "") === "1";
  const search = String(req.body.search || req.query.search || "").trim();
  const limit = parseLimit(req.body.limit || req.query.limit, 50);
  const page = parsePage(req.body.page || req.query.page, 1);

  const redirectQs = buildQueryString({
    company_id: companyId || "",
    active_only: activeOnly ? "1" : "",
    search,
    limit: String(limit),
    page: String(page),
  });

  try {
    let keys = req.body.keys || req.body.key || [];
    if (!Array.isArray(keys)) keys = [keys];
    keys = keys.map((k) => String(k || "").trim()).filter(Boolean);

    if (String(req.body.delete_all || "") === "1") {
      const scan = await findOrphanProductImages({ companyId, activeOnly });
      let orphans = scan.orphans;
      if (search) {
        const q = search.toLowerCase();
        orphans = orphans.filter(
          (o) =>
            o.key.toLowerCase().includes(q) ||
            o.fileName.toLowerCase().includes(q),
        );
      }
      keys = orphans.map((o) => o.key);
    }

    if (!keys.length) {
      if (req.flash) req.flash("error", "No images selected for deletion.");
      return res.redirect(pageUrl(redirectQs));
    }

    const result = await deleteOrphanProductImages(keys, {
      companyId,
      activeOnly,
    });

    if (req.flash) {
      const parts = [`Deleted ${result.deleted.length} file(s) from disk.`];
      if (result.skipped.length) {
        parts.push(`Skipped ${result.skipped.length}.`);
      }
      if (result.errors.length) {
        parts.push(`${result.errors.length} error(s).`);
      }
      if (result.deleted.length) {
        req.flash("success", parts.join(" "));
      } else {
        req.flash("error", parts.join(" ") || "Nothing was deleted.");
      }
    }

    return res.redirect(pageUrl(redirectQs));
  } catch (error) {
    console.error("Delete unused product images error:", error);
    if (req.flash) {
      req.flash("error", error.message || "Failed to delete unused images.");
    }
    return res.redirect(pageUrl(redirectQs));
  }
}

module.exports = {
  renderUnusedImages,
  deleteUnusedImages,
  PAGE_PATH,
};
