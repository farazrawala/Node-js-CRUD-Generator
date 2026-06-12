/** Subdirectory mount, e.g. BASE_PATH=/pos_admin → routes at /pos_admin/api/... */
function normalizeBasePath(raw) {
  if (raw == null || raw === "" || raw === "/") return "";
  let p = String(raw).trim();
  if (!p.startsWith("/")) p = `/${p}`;
  return p.replace(/\/$/, "");
}

function getBasePath() {
  return normalizeBasePath(process.env.BASE_PATH);
}

function withBasePath(path, base = getBasePath()) {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  const b = normalizeBasePath(base);
  return `${b}${suffix}`;
}

module.exports = {
  normalizeBasePath,
  getBasePath,
  withBasePath,
};
