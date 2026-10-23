/**
 * @file Tests for terminal-control: validation of hook-reported terminal
 * records, and reply delivery into a tmux pane on a private, throwaway tmux
 * server (skipped when tmux is not installed).
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { describe, it, before, after, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { execFileSync } = childProcess;
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  sanitizeTerminal,
  parseTerminal,
  sendInput,
  parseGhosttyTerminals,
  sanitizeTitle,
  etimeMs,
} = require("../lib/terminal-control");

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

  it("keeps the Ghostty flag only for a pid outside tmux", () => {
    assert.deepEqual(sanitizeTerminal({ pid: 7, ghostty: true }), { pid: 7, ghostty: true });
    assert.deepEqual(sanitizeTerminal({ pid: 7, ghostty: "yes" }), { pid: 7 });
    assert.equal(sanitizeTerminal({ ghostty: true }), null);
    assert.deepEqual(
      sanitizeTerminal({ pid: 7, ghostty: true, tmux_pane: "%1", tmux_socket: "/tmp/s" }),
      { pid: 7, tmux_pane: "%1", tmux_socket: "/tmp/s" }
    );
  });
});

describe("Ghostty exact-tab helpers", () => {
  it("maps terminal ids to titles, keeping a title's own whitespace", () => {
    const titles = parseGhosttyTerminals("A-1\x1f✳ fix bug\x1eB-2\x1fsession  \x1ebad\x1e");
    assert.deepEqual(
      [...titles],
      [
        ["A-1", "✳ fix bug"],
        ["B-2", "session  "],
      ]
    );
  });

  it("strips the controls that would end or inject an OSC sequence", () => {
    assert.equal(sanitizeTitle("a\x1b]2;evil\x07b\x9cc\n"), "a]2;evilbc");
    assert.equal(sanitizeTitle(undefined), "");
  });

  it("reads ps etime values", () => {
    assert.equal(etimeMs("00:05"), 5000);
    assert.equal(etimeMs("02:03:04"), (2 * 3600 + 3 * 60 + 4) * 1000);
    assert.equal(etimeMs("1-00:00:01"), (86400 + 1) * 1000);
    assert.ok(Number.isNaN(etimeMs(undefined)));
  });

  it("keeps titles under Ghostty's 256-byte limit on a code point boundary", () => {
    assert.equal(sanitizeTitle("x".repeat(300)).length, 255);
    const cut = sanitizeTitle("✳".repeat(100)); // 3 bytes each
    assert.equal(cut, "✳".repeat(85));
  });
});

describe("focusTerminal and sendInput in Ghostty", () => {
  // A fake Ghostty: one terminal on /dev/ttys009 hosting pid 100, whose title
  // follows the OSC 2 sequences written to that tty. A fake tmux server on
  // socket /s has panes %1 and %2 and one client on that same tty.
  let ghostty;
  let terminalControl;
  const platform = Object.getOwnPropertyDescriptor(process, "platform");

  function fakeExecFile(cmd, args, _opts, cb) {
    const reply = (out) => setImmediate(() => cb(null, out));
    const joined = args.join(" ");
    if (cmd === "ps" && joined === "-o ppid=,comm= -p 100") return reply("50 claude");
    if (cmd === "ps" && joined === "-o ppid=,comm= -p 50") {
      return reply("1 /Applications/Ghostty.app/Contents/MacOS/ghostty");
    }
    if (cmd === "ps" && joined === "-o tty= -p 100") return reply("ttys009");
    if (cmd === "ps" && joined === "-o pgid=,tpgid=,tty=,etime= -p 100") {
      return reply(`100 ${ghostty.foreground} ${ghostty.tty} ${ghostty.etime}`);
    }
    if (cmd === "ps" && joined === "-o comm= -p 100") return reply("claude");
    if (cmd === "ps" && joined === "-o comm= -p 200") return reply("-zsh");
    if (cmd === "ps" && joined === "-o comm= -p 101") return reply("vim");
    if (cmd === "tmux") {
      const [verb, ...rest] = args.slice(2);
      const target = rest[rest.indexOf("-t") + 1];
      if (verb === "display-message") return reply("s\t42\tclaude");
      if (verb === "list-clients") return reply("100\t/dev/ttys009\ts\t/dev/ttys009");
      if (verb === "select-pane" || verb === "switch-client") ghostty.pane = target;
      return reply("");
    }
    if (cmd === "open") {
      ghostty.opened.push(args[1]);
      return reply("");
    }
    if (cmd === "osascript" && args.length === 2) {
      return reply(`T-1\x1f${ghostty.title}\x1e`);
    }
    if (cmd === "osascript" && args[2].startsWith("ccam-")) {
      // Answer only once the marker is the live title, a little later, so
      // overlapping requests really interleave without the queue.
      return setTimeout(() => {
        const hit = ghostty.seesMarker && ghostty.title === args[2];
        if (hit && args[3] === "focus") ghostty.shown.push(ghostty.pane);
        if (hit && args[3] === "find") ghostty.onFind?.();
        cb(null, hit ? "T-1" : "");
      }, 20);
    }
    if (cmd === "osascript" && args[2] === "T-1") {
      if (args.length === 4) {
        ghostty.typed.push(args[3]);
        ghostty.onPaste?.();
      } else {
        ghostty.keys.push("enter");
      }
      return reply("");
    }
    return setImmediate(() => cb(new Error(`unexpected ${cmd} ${joined}`)));
  }

  before(() => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mock.method(childProcess, "execFile", fakeExecFile);
    mock.method(fs, "openSync", () => 99);
    mock.method(fs, "closeSync", () => {});
    // Take at most 8 bytes per write, like a nearly full tty buffer, and, like
    // Ghostty, apply a completed title a moment later.
    mock.method(fs, "writeSync", (_fd, buf, off) => {
      if (ghostty.ttyFull) {
        ghostty.ttyFull = false; // full for one write, then drained
        throw Object.assign(new Error("EAGAIN"), { code: "EAGAIN" });
      }
      const n = Math.min(8, buf.length - off);
      ghostty.written = Buffer.concat([ghostty.written, buf.subarray(off, off + n)]);
      const done = /^\x1b\]2;(.*)\x07$/s.exec(ghostty.written.toString());
      if (done) {
        ghostty.written = Buffer.alloc(0);
        setTimeout(() => (ghostty.title = done[1]), 5);
      }
      return n;
    });
    // Reload so the module picks up the mocked execFile it destructures.
    delete require.cache[require.resolve("../lib/terminal-control")];
    terminalControl = require("../lib/terminal-control");
  });

  after(() => {
    mock.restoreAll();
    Object.defineProperty(process, "platform", platform);
    delete require.cache[require.resolve("../lib/terminal-control")];
  });

  beforeEach(() => {
    ghostty = {
      title: "✳ my session",
      seesMarker: true,
      foreground: 100,
      tty: "ttys009",
      etime: "10:00",
      keys: [],
      pane: null,
      shown: [],
      typed: [],
      opened: [],
      written: Buffer.alloc(0),
    };
  });

  it("focuses the marked surface and restores its title", async () => {
    const res = await terminalControl.focusTerminal({ pid: 100 });
    assert.deepEqual(res, { tmux: false, attached: true, app: "Ghostty", exact: true });
    assert.equal(ghostty.shown.length, 1);
    assert.deepEqual(ghostty.opened, []);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(ghostty.title, "✳ my session");
  });

  it("serializes overlapping requests so neither restores the other's marker", async () => {
    const both = await Promise.all([
      terminalControl.focusTerminal({ pid: 100 }),
      terminalControl.focusTerminal({ pid: 100 }),
    ]);
    assert.deepEqual(
      both.map((r) => r.exact),
      [true, true]
    );
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(ghostty.title, "✳ my session");
  });

  it("shows each overlapping tmux request its own pane", async () => {
    const term = (pane) => ({ pid: 4242, tmux_pane: pane, tmux_socket: "/s" });
    const both = await Promise.all([
      terminalControl.focusTerminal(term("%1")),
      terminalControl.focusTerminal(term("%2")),
    ]);
    assert.deepEqual(
      both.map((r) => r.exact),
      [true, true]
    );
    assert.deepEqual(ghostty.shown, ["%1", "%2"]);
  });

  it("leaves the title alone when the marker cannot be written at all", async () => {
    ghostty.ttyFull = true;
    const res = await terminalControl.focusTerminal({ pid: 100 });
    assert.equal(res.exact, false);
    assert.deepEqual(ghostty.opened, ["/Applications/Ghostty.app"]);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(ghostty.title, "✳ my session");
  });

  it("falls back to raising the app when the marker never shows up", async () => {
    ghostty.seesMarker = false;
    const res = await terminalControl.focusTerminal({ pid: 100 });
    assert.equal(res.exact, false);
    assert.deepEqual(ghostty.opened, ["/Applications/Ghostty.app"]);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(ghostty.title, "");
  });

  const now = () => new Date().toISOString();
  const reply = (text, lastSeen = now()) => terminalControl.sendInput({ pid: 100 }, text, lastSeen);

  it("types a reply into the CLI's surface without focusing it", async () => {
    assert.deepEqual(await reply("yes\ngo"), { sent: true });
    assert.deepEqual(ghostty.typed, ["yes\ngo"]);
    assert.deepEqual(ghostty.keys, ["enter"]);
    assert.deepEqual(ghostty.shown, []);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(ghostty.title, "✳ my session");
  });

  it("refuses unless the session's CLI owns its tty's foreground", async () => {
    ghostty.foreground = 200; // a shell took the terminal back
    await assert.rejects(reply("hi"), { code: "EPANESHELL" });
    ghostty.foreground = 101; // some other job has the keyboard
    await assert.rejects(reply("hi"), { code: "EPANEMISMATCH" });
    ghostty.foreground = 100;
    // The pid started 5 s ago, after the session's last hook a minute ago:
    // another process reused it.
    ghostty.etime = "00:05";
    await assert.rejects(reply("hi", new Date(Date.now() - 60_000).toISOString()), {
      code: "EPANEMISMATCH",
    });
    ghostty.etime = "10:00";
    await assert.rejects(reply("hi", null), { code: "EPANEMISMATCH" });
    ghostty.seesMarker = false;
    await assert.rejects(reply("hi"), { code: "ENOSURFACE" });
    assert.deepEqual(ghostty.typed, []);
  });

  it("re-checks the foreground before the paste and before Enter", async () => {
    ghostty.onFind = () => (ghostty.foreground = 200); // CLI exits during the lookup
    await assert.rejects(reply("hi"), { code: "EPANESHELL" });
    assert.deepEqual(ghostty.typed, []);
    ghostty.onFind = null;
    ghostty.foreground = 100;
    ghostty.onPaste = () => (ghostty.foreground = 200); // ...or right after the paste
    await assert.rejects(reply("hi"), { code: "EPANESHELL" });
    assert.deepEqual(ghostty.typed, ["hi"]);
    assert.deepEqual(ghostty.keys, []);
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
