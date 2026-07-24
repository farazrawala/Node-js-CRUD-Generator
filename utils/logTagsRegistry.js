const fs = require("fs");
const path = require("path");

const LOG_TAGS_FILE = path.join(__dirname, "..", "public", "log-tags.txt");

/** @type {Set<string> | null} */
let knownTags = null;
/** @type {Set<string>} */
const pending = new Set();
let writeTimer = null;
let writing = false;

function normalizeTag(raw) {
  return String(raw ?? "").trim();
}

function ensureLoaded() {
  if (knownTags) return;
  knownTags = new Set();
  try {
    if (fs.existsSync(LOG_TAGS_FILE)) {
      const text = fs.readFileSync(LOG_TAGS_FILE, "utf8");
      for (const line of text.split(/\r?\n/)) {
        const t = normalizeTag(line);
        if (t) knownTags.add(t);
      }
    }
  } catch (err) {
    console.warn(
      "[logTagsRegistry] failed to load log-tags.txt:",
      err?.message || err,
    );
  }
}

function sortedTagList() {
  ensureLoaded();
  return [...knownTags].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}

function writeFileNow(done) {
  ensureLoaded();
  const list = sortedTagList();
  const body = list.length ? list.join("\n") + "\n" : "";

  fs.mkdir(path.dirname(LOG_TAGS_FILE), { recursive: true }, (mkdirErr) => {
    if (mkdirErr) {
      console.warn(
        "[logTagsRegistry] mkdir failed:",
        mkdirErr?.message || mkdirErr,
      );
      if (done) done(mkdirErr);
      return;
    }
    fs.writeFile(LOG_TAGS_FILE, body, "utf8", (err) => {
      if (err) {
        console.warn(
          "[logTagsRegistry] write failed:",
          err?.message || err,
        );
      }
      if (done) done(err || null, list.length);
    });
  });
}

function scheduleWrite() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    flushPending();
  }, 250);
}

function flushPending() {
  if (writing || pending.size === 0) return;
  ensureLoaded();

  let added = 0;
  for (const t of pending) {
    if (!knownTags.has(t)) {
      knownTags.add(t);
      added++;
    }
  }
  pending.clear();
  if (!added) return;

  writing = true;
  writeFileNow((err) => {
    writing = false;
    if (!err && pending.size) scheduleWrite();
  });
}

/**
 * Merge tags into public/log-tags.txt (async, non-blocking).
 * No max count — every distinct tag is kept.
 * @param {string[] | string | null | undefined} tags
 */
function registerLogTags(tags) {
  if (tags == null || tags === "") return;
  const arr = Array.isArray(tags) ? tags : [tags];
  ensureLoaded();

  let hasNew = false;
  for (const raw of arr) {
    const t = normalizeTag(raw);
    if (!t) continue;
    if (knownTags.has(t) || pending.has(t)) continue;
    pending.add(t);
    hasNew = true;
  }
  if (hasNew) scheduleWrite();
}

/**
 * Load every distinct tag from the `logs` collection into the public file.
 * Call once after MongoDB connects so the frontend gets the full historical set.
 * @returns {Promise<{ ok: boolean, count?: number, error?: unknown }>}
 */
async function syncLogTagsFromDatabase() {
  try {
    const Logs = require("../models/logs");
    ensureLoaded();

    const fromDb = await Logs.distinct("tags");
    let added = 0;
    for (const raw of fromDb) {
      const t = normalizeTag(raw);
      if (!t || knownTags.has(t)) continue;
      knownTags.add(t);
      added++;
    }

    if (added === 0 && fs.existsSync(LOG_TAGS_FILE)) {
      return { ok: true, count: knownTags.size, added: 0 };
    }

    await new Promise((resolve, reject) => {
      writeFileNow((err, count) => (err ? reject(err) : resolve(count)));
    });

    console.log(
      `[logTagsRegistry] synced ${knownTags.size} tag(s) to log-tags.txt` +
        (added ? ` (+${added} from DB)` : ""),
    );
    return { ok: true, count: knownTags.size, added };
  } catch (err) {
    console.warn(
      "[logTagsRegistry] sync from DB failed:",
      err?.message || err,
    );
    return { ok: false, error: err };
  }
}

module.exports = {
  registerLogTags,
  syncLogTagsFromDatabase,
  LOG_TAGS_FILE,
};
