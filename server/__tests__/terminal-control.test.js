/**
 * @file Tests for terminal-control: validation of hook-reported terminal
 * records, and reply delivery into a tmux pane on a private, throwaway tmux
 * server (skipped when tmux is not installed).
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { sanitizeTerminal, parseTerminal, sendInput } = require("../lib/terminal-control");

describe("sanitizeTerminal", () => {
  it("keeps a well-formed record", () => {
    assert.deepEqual(
      sanitizeTerminal({ pid: 42, tmux_pane: "%3", tmux_socket: "/tmp/t/default" }),
      {
        pid: 42,
        tmux_pane: "%3",
        tmux_socket: "/tmp/t/default",
      }
    );
  });

  it("drops malformed panes, relative sockets and bad pids", () => {
    assert.equal(sanitizeTerminal({ tmux_pane: "%3; rm", tmux_socket: "/tmp/x", pid: -1 }), null);
    assert.equal(sanitizeTerminal({ tmux_pane: "%3", tmux_socket: "rel/sock" }), null);
    assert.deepEqual(sanitizeTerminal({ pid: 7, tmux_pane: "%1" }), { pid: 7 });
    assert.equal(sanitizeTerminal("nope"), null);
    assert.equal(parseTerminal("{not json"), null);
  });
});

let hasTmux = true;
try {
  execFileSync("tmux", ["-V"]);
} catch {
  hasTmux = false;
}

describe("sendInput", { skip: !hasTmux && "tmux not installed" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccam-tmux-"));
  const socket = path.join(dir, "sock");
  const tmux = (...args) =>
    execFileSync("tmux", ["-S", socket, ...args])
      .toString()
      .trim();
  let catPane;
  let catPid;
  let shellPane;

  before(() => {
    tmux("new-session", "-d", "-s", "t", "-x", "120", "-y", "20", "cat");
    catPane = tmux("display-message", "-p", "-t", "t", "#{pane_id}");
    catPid = Number(tmux("display-message", "-p", "-t", catPane, "#{pane_pid}"));
    shellPane = tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", "t", "/bin/sh");
  });

  after(() => {
    try {
      tmux("kill-server");
    } catch {
      /* already gone */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("types the reply into the CLI's pane and presses Enter", async () => {
    await sendInput({ tmux_pane: catPane, tmux_socket: socket, pid: catPid }, "hello from ui");
    const screen = tmux("capture-pane", "-p", "-t", catPane);
    // cat echoes the line once as typed input and once as its output.
    assert.equal(screen.split("\n").filter((l) => l === "hello from ui").length, 2);
  });

  it("refuses a pane that is back at a shell prompt", async () => {
    await assert.rejects(
      sendInput({ tmux_pane: shellPane, tmux_socket: socket }, "ls"),
      (err) => err.code === "EPANESHELL"
    );
  });

  it("refuses when the recorded CLI pid does not live in that pane", async () => {
    await assert.rejects(
      sendInput({ tmux_pane: catPane, tmux_socket: socket, pid: process.pid }, "hi"),
      (err) => err.code === "EPANEMISMATCH"
    );
  });

  it("rejects control characters", async () => {
    await assert.rejects(
      sendInput({ tmux_pane: catPane, tmux_socket: socket }, "hi\x1b[A"),
      (err) => err.code === "INVALID_INPUT"
    );
  });
});
