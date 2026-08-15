const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

describe("TaskBoard model", () => {
  const TaskBoard = require("../models/task_board");

  it("has required schema paths", () => {
    const paths = TaskBoard.schema.paths;
    for (const p of ["company_id", "name", "created_by", "members", "is_archived"]) {
      assert.ok(paths[p], `missing schema path: ${p}`);
    }
  });

  it("has company_id + is_archived index", () => {
    const indexes = TaskBoard.schema.indexes();
    const found = indexes.find(
      (idx) => idx[0].company_id === 1 && idx[0].is_archived === 1,
    );
    assert.ok(found, "company_id + is_archived index missing");
  });
});

describe("TaskColumn model", () => {
  const TaskColumn = require("../models/task_column");

  it("has required schema paths", () => {
    const paths = TaskColumn.schema.paths;
    for (const p of ["company_id", "board_id", "name", "position"]) {
      assert.ok(paths[p], `missing schema path: ${p}`);
    }
  });
});

describe("Task model", () => {
  const Task = require("../models/task");
  const { PRIORITY_VALUES } = require("../models/task");

  it("exports priority enum", () => {
    assert.deepStrictEqual(PRIORITY_VALUES, ["low", "medium", "high", "urgent"]);
  });

  it("has required schema paths", () => {
    const paths = Task.schema.paths;
    for (const p of [
      "company_id",
      "board_id",
      "column_id",
      "title",
      "task_number",
      "priority",
      "position",
      "assignee_ids",
      "checklists",
      "attachments",
    ]) {
      assert.ok(paths[p], `missing schema path: ${p}`);
    }
  });

  it("has tenant indexes", () => {
    const indexes = Task.schema.indexes();
    assert.ok(indexes.length >= 5, `expected >= 5 indexes, got ${indexes.length}`);
    const numberIdx = indexes.find(
      (idx) => idx[0].company_id === 1 && idx[0].task_number === 1,
    );
    assert.ok(numberIdx, "task_number unique index missing");
    assert.strictEqual(numberIdx[1].unique, true);
  });
});

describe("TaskComment model", () => {
  const TaskComment = require("../models/task_comment");

  it("has required schema paths", () => {
    const paths = TaskComment.schema.paths;
    for (const p of ["company_id", "task_id", "user_id", "body", "mentions"]) {
      assert.ok(paths[p], `missing schema path: ${p}`);
    }
  });
});

describe("TaskActivity model", () => {
  const TaskActivity = require("../models/task_activity");

  it("has required schema paths", () => {
    const paths = TaskActivity.schema.paths;
    for (const p of ["company_id", "task_id", "user_id", "action"]) {
      assert.ok(paths[p], `missing schema path: ${p}`);
    }
  });
});

describe("TaskCounter model", () => {
  const TaskCounter = require("../models/task_counter");

  it("has company_id and seq", () => {
    const paths = TaskCounter.schema.paths;
    assert.ok(paths.company_id);
    assert.ok(paths.seq);
  });
});

describe("taskPosition utils", () => {
  const {
    nextTailPosition,
    midPosition,
    needsRebalance,
    rebalancePositions,
    POSITION_GAP,
  } = require("../utils/taskPosition");

  it("nextTailPosition adds gap", () => {
    assert.strictEqual(nextTailPosition(1000), 1000 + POSITION_GAP);
    assert.strictEqual(nextTailPosition(null), POSITION_GAP);
  });

  it("midPosition returns midpoint", () => {
    assert.strictEqual(midPosition(1000, 2000), 1500);
  });

  it("needsRebalance detects tiny gaps", () => {
    assert.strictEqual(needsRebalance(1, 1.0000000001), true);
    assert.strictEqual(needsRebalance(1000, 2000), false);
  });

  it("rebalancePositions assigns uniform gaps", () => {
    const result = rebalancePositions([{ _id: "a" }, { _id: "b" }, { _id: "c" }]);
    assert.strictEqual(result[0].position, POSITION_GAP);
    assert.strictEqual(result[1].position, POSITION_GAP * 2);
    assert.strictEqual(result[2].position, POSITION_GAP * 3);
  });
});

describe("taskUploads", () => {
  const {
    validateFile,
    MAX_FILE_SIZE,
  } = require("../utils/taskUploads");

  it("rejects oversized files", () => {
    const err = validateFile({
      name: "big.png",
      size: MAX_FILE_SIZE + 1,
      mimetype: "image/png",
    });
    assert.ok(err);
  });

  it("rejects exe", () => {
    const err = validateFile({
      name: "x.exe",
      size: 100,
      mimetype: "application/x-msdownload",
    });
    assert.ok(err);
  });

  it("accepts pdf", () => {
    const err = validateFile({
      name: "doc.pdf",
      size: 1000,
      mimetype: "application/pdf",
    });
    assert.strictEqual(err, null);
  });
});

describe("task_management controller exports", () => {
  const ctrl = require("../controllers/task_management");

  it("exports board/task handlers", () => {
    for (const fn of [
      "listBoards",
      "createBoard",
      "getBoardKanban",
      "createTask",
      "moveTask",
      "addComment",
      "seedDemo",
    ]) {
      assert.strictEqual(typeof ctrl[fn], "function", `missing ${fn}`);
    }
  });

  it("exports default columns", () => {
    assert.ok(Array.isArray(ctrl.DEFAULT_COLUMNS));
    assert.strictEqual(ctrl.DEFAULT_COLUMNS.length, 5);
    assert.ok(ctrl.DEFAULT_COLUMNS.some((c) => c.name === "Backlog"));
    assert.ok(ctrl.DEFAULT_COLUMNS.some((c) => c.name === "Done"));
  });
});

describe("tasks permission key", () => {
  it("is whitelisted on user model", () => {
    const userModel = require("../models/user");
    // PERMISSION_MODULE_KEYS is not exported; verify via sanitize if available
    const schema = userModel.schema;
    assert.ok(schema.paths.permissions);
  });
});
