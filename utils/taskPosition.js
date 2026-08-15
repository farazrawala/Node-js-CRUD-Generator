/** Sparse gap positioning for Kanban reorder without rewriting every row. */

const POSITION_GAP = 1000;
const MIN_GAP = 0.000001;

function nextTailPosition(lastPosition) {
  const n = Number(lastPosition);
  if (!Number.isFinite(n)) return POSITION_GAP;
  return n + POSITION_GAP;
}

function midPosition(before, after) {
  const a = Number(before);
  const b = Number(after);
  if (Number.isFinite(a) && Number.isFinite(b)) {
    return (a + b) / 2;
  }
  if (Number.isFinite(a) && !Number.isFinite(b)) {
    return a + POSITION_GAP;
  }
  if (!Number.isFinite(a) && Number.isFinite(b)) {
    return b / 2;
  }
  return POSITION_GAP;
}

function needsRebalance(before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after)) return false;
  return after - before < MIN_GAP;
}

/**
 * Reassign positions for ordered ids with uniform gaps.
 * @param {Array<{_id: any}>} orderedDocs
 * @returns {Array<{_id: any, position: number}>}
 */
function rebalancePositions(orderedDocs) {
  return (orderedDocs || []).map((doc, i) => ({
    _id: doc._id,
    position: (i + 1) * POSITION_GAP,
  }));
}

module.exports = {
  POSITION_GAP,
  nextTailPosition,
  midPosition,
  needsRebalance,
  rebalancePositions,
};
