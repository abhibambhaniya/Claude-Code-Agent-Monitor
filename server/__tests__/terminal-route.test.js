/**
 * @file Route tests for the terminal actions: hooks from this machine store the
 * session's terminal record, and `/api/terminal/:sessionId/*` refuses
 * cross-origin calls, unknown sessions, and sessions with no record.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const TEST_DB = path.join(os.tmpdir(), `dashboard-terminal-${Date.now()}-${process.pid}.db`);
process.env.DASHBOARD_DB_PATH = TEST_DB;
process.env.DASHBOARD_LIVENESS_PROBE = "0";

const { createApp, startServer } = require("../index");
const { db, stmts } = require("../db");

let server;
let BASE;

const post = (urlPath, body, headers = {}) =>
  fetch(`${BASE}${urlPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

before(async () => {
  server = await startServer(createApp(), 0);
  BASE = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(TEST_DB + suffix, { force: true });
});

describe("terminal record ingestion", () => {
  it("stores the sanitized terminal record from a local hook", async () => {
    const res = await post("/api/hooks/event", {
      hook_type: "SessionStart",
      data: { session_id: "term-1", cwd: "/tmp", source: "startup" },
      terminal: { pid: 4242, tmux_pane: "%7", tmux_socket: "/tmp/tmux-501/default", junk: 1 },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(stmts.getSession.get("term-1").terminal), {
      tmux_pane: "%7",
      tmux_socket: "/tmp/tmux-501/default",
      pid: 4242,
    });
  });

  it("ignores a malformed record", async () => {
    await post("/api/hooks/event", {
      hook_type: "SessionStart",
      data: { session_id: "term-2", cwd: "/tmp", source: "startup" },
      terminal: { tmux_pane: "$(id)", tmux_socket: "x", pid: "1" },
    });
    assert.equal(stmts.getSession.get("term-2").terminal, null);
  });
});

describe("/api/terminal guards", () => {
  it("rejects a cross-origin browser request", async () => {
    const res = await post(
      "/api/terminal/term-1/input",
      { text: "hi" },
      {
        Origin: "http://evil.example",
      }
    );
    assert.equal(res.status, 403);
  });

  it("404s an unknown session", async () => {
    const res = await post("/api/terminal/nope/focus", {});
    assert.equal(res.status, 404);
  });

  it("409s a session with no terminal record", async () => {
    const res = await post("/api/terminal/term-2/input", { text: "hi" });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, "ENOTERMINAL");
  });
});
