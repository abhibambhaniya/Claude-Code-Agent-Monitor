/**
 * @file terminal-control.js
 * @description Reaches the terminal a local Claude Code / Codex session runs in.
 * Hook handlers report the session's tmux pane (`$TMUX_PANE` plus the socket
 * from `$TMUX`) and the CLI's pid; this module validates that record, focuses
 * the session (tmux select/switch-client, then raises the terminal app on
 * macOS — in Ghostty, the exact window/tab/split), and types a reply into a
 * tmux pane. Every external command runs via execFile with an argument array
 * — never through a shell.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const CMD_TIMEOUT_MS = 3000;
const MAX_INPUT_CHARS = 4000;
// Gap between the bracketed paste and the Enter key. Claude Code's input box
// treats keys that arrive in the same burst as a paste swallows Enter as a
// newline; a short pause makes it a submit. Raise it if replies land unsent.
const SUBMIT_DELAY_MS = 300;
// Foreground commands that mean the CLI has exited and the pane is back at a
// prompt. Typing into one would run the reply as a shell command.
const SHELLS = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "tcsh",
  "csh",
  "nu",
  "pwsh",
  "login",
]);

class TerminalError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Validate the terminal record a hook handler sent. Untrusted JSON, so every
 * field is shape-checked; anything off is dropped.
 * @returns {{tmux_pane?: string, tmux_socket?: string, pid?: number} | null}
 */
function sanitizeTerminal(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  if (
    typeof raw.tmux_pane === "string" &&
    /^%\d{1,7}$/.test(raw.tmux_pane) &&
    typeof raw.tmux_socket === "string" &&
    raw.tmux_socket.length <= 1024 &&
    path.isAbsolute(raw.tmux_socket) &&
    !raw.tmux_socket.includes("\0")
  ) {
    out.tmux_pane = raw.tmux_pane;
    out.tmux_socket = raw.tmux_socket;
  }
  if (Number.isInteger(raw.pid) && raw.pid > 1 && raw.pid < 2 ** 31) out.pid = raw.pid;
  return Object.keys(out).length ? out : null;
}

/** Parse the `sessions.terminal` column; null when absent or malformed. */
function parseTerminal(json) {
  if (!json) return null;
  try {
    return sanitizeTerminal(JSON.parse(json));
  } catch {
    return null;
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: CMD_TIMEOUT_MS }, (err, stdout) => {
      if (err) {
        if (err.code === "ENOENT") {
          reject(new TerminalError("ENOTOOL", `${cmd} is not installed`, 501));
        } else {
          reject(err);
        }
      } else {
        resolve(String(stdout).trim());
      }
    });
  });
}

const tmux = (term, args) => run("tmux", ["-S", term.tmux_socket, ...args]);

/** Ancestor chain of `pid` (pid first) as [{pid, comm}]. Empty if pid is gone. */
async function processChain(pid) {
  const chain = [];
  let cur = pid;
  for (let i = 0; i < 32 && cur > 1; i++) {
    let line;
    try {
      line = await run("ps", ["-o", "ppid=,comm=", "-p", String(cur)]);
    } catch {
      break;
    }
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) break;
    chain.push({ pid: cur, comm: m[2] });
    cur = Number(m[1]);
  }
  return chain;
}

// Ghostty's AppleScript dictionary exposes terminal titles but not ttys, so a
// surface is found by writing a unique OSC 2 title to its tty and looking for
// it. LIST snapshots titles first so the real one can be put back.
const GHOSTTY_LIST = `on run argv
  tell application "Ghostty" to set {ids, names} to {id, name} of every terminal
  set out to ""
  repeat with i from 1 to count of ids
    set out to out & item i of ids & (character id 9) & item i of names & (character id 10)
  end repeat
  return out
end run`;
// Waits up to ~1 s for the title to reach Ghostty, focuses that surface and
// returns its id ("" when it never showed up).
const GHOSTTY_FOCUS = `on run argv
  set marker to item 1 of argv
  tell application "Ghostty"
    activate
    repeat 20 times
      set hits to (every terminal whose name is marker)
      if (count of hits) > 0 then
        set t to item 1 of hits
        focus t
        return id of t
      end if
      delay 0.05
    end repeat
  end tell
  return ""
end run`;

/** Parse GHOSTTY_LIST output into a Map of terminal id -> title. */
function parseGhosttyTerminals(out) {
  const titles = new Map();
  for (const line of String(out).split("\n")) {
    const tab = line.indexOf("\t");
    if (tab > 0) titles.set(line.slice(0, tab), line.slice(tab + 1));
  }
  return titles;
}

/** A title safe to embed in OSC 2: no C0/C1 controls (ESC/BEL end the sequence). */
function sanitizeTitle(title) {
  // eslint-disable-next-line no-control-regex
  return String(title ?? "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    .slice(0, 256);
}

function writeTitle(tty, title) {
  // O_NOCTTY: the server must not adopt the session's tty as its own.
  // O_NONBLOCK: a terminal paused with ^S must not hang the request.
  const { O_WRONLY, O_NOCTTY, O_NONBLOCK } = fs.constants;
  const fd = fs.openSync(tty, O_WRONLY | O_NOCTTY | O_NONBLOCK);
  try {
    fs.writeSync(fd, `\x1b]2;${sanitizeTitle(title)}\x07`);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Focus the Ghostty surface attached to `tty`. True when it was found and
 * focused; throws when Ghostty or the tty cannot be reached.
 */
async function focusGhosttySurface(tty) {
  const marker = `ccam-${crypto.randomUUID()}`;
  const titles = parseGhosttyTerminals(await run("osascript", ["-e", GHOSTTY_LIST]));
  writeTitle(tty, marker);
  let id = "";
  try {
    id = await run("osascript", ["-e", GHOSTTY_FOCUS, marker]);
  } finally {
    // ponytail: marker never seen -> the old title is unknown, so the title is
    // cleared; the CLI or shell sets a fresh one on its next redraw/prompt.
    writeTitle(tty, titles.get(id) ?? "");
  }
  return Boolean(id);
}

/** `/dev/ttysNNN` the process `pid` writes to, or null (no tty / gone). */
async function ttyOf(pid) {
  const name = await run("ps", ["-o", "tty=", "-p", String(pid)]).catch(() => "");
  return /^ttys\d+$/.test(name) ? `/dev/${name}` : null;
}

/**
 * Raise the macOS app that hosts `pid` (the first `.app` bundle among its
 * ancestors). In Ghostty, focus the exact surface on `tty` (default: the
 * pid's own tty) first; any failure there falls back to raising the app.
 * Returns {app, exact}; app is null when none is found / not macOS.
 * ponytail: other apps get the app, not the tab; add per-terminal
 * AppleScript (iTerm2/Terminal select by tty) if that matters.
 */
async function activateApp(pid, tty) {
  if (process.platform !== "darwin" || !pid) return { app: null, exact: false };
  for (const { comm } of await processChain(pid)) {
    const m = comm.match(/^(\/.+?\.app)\/Contents\/MacOS\//);
    if (!m) continue;
    const app = path.basename(m[1], ".app");
    let exact = false;
    if (app === "Ghostty") {
      const surface = tty || (await ttyOf(pid));
      if (surface) exact = await focusGhosttySurface(surface).catch(() => false);
    }
    if (!exact) await run("open", ["-a", m[1]]);
    return { app, exact };
  }
  return { app: null, exact: false };
}

async function paneInfo(term) {
  try {
    const out = await tmux(term, [
      "display-message",
      "-p",
      "-t",
      term.tmux_pane,
      "#{session_name}\t#{pane_pid}\t#{pane_current_command}",
    ]);
    const [session, panePid, command] = out.split("\t");
    return { session, panePid: Number(panePid), command };
  } catch (err) {
    if (err instanceof TerminalError) throw err;
    throw new TerminalError("EPANEGONE", "tmux pane no longer exists");
  }
}

/**
 * Bring the session's terminal to the front: select its tmux window and pane,
 * switch an attached client to it, and raise the terminal app hosting that
 * client. Without tmux, raise the app hosting the CLI process. `exact` says
 * whether the precise window/tab/split was focused (Ghostty only).
 */
async function focusTerminal(term) {
  if (term?.tmux_pane) {
    const info = await paneInfo(term);
    await tmux(term, ["select-window", "-t", term.tmux_pane]);
    await tmux(term, ["select-pane", "-t", term.tmux_pane]);
    const clients = (
      await tmux(term, [
        "list-clients",
        "-F",
        "#{client_pid}\t#{client_name}\t#{client_session}\t#{client_tty}",
      ])
    )
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [pid, name, session, tty] = l.split("\t");
        return { pid: Number(pid), name, session, tty };
      });
    const client = clients.find((c) => c.session === info.session) || clients[0];
    if (!client) return { tmux: true, attached: false, app: null, exact: false };
    await tmux(term, ["switch-client", "-c", client.name, "-t", term.tmux_pane]);
    const tty = /^\/dev\/ttys\d+$/.test(client.tty) ? client.tty : null;
    return { tmux: true, attached: true, ...(await activateApp(client.pid, tty)) };
  }
  if (term?.pid) {
    const raised = await activateApp(term.pid);
    if (raised.app) return { tmux: false, attached: true, ...raised };
  }
  throw new TerminalError("ENOTERMINAL", "no reachable terminal recorded for this session");
}

/**
 * Type `text` into the session's tmux pane and press Enter. Refuses unless the
 * pane still runs the session's CLI: the foreground command must not be a
 * shell, and the recorded CLI pid (when known) must be a descendant of the
 * pane's process.
 */
async function sendInput(term, text) {
  if (!term?.tmux_pane) {
    throw new TerminalError("ENOTMUX", "session is not running inside tmux");
  }
  if (typeof text !== "string" || !text.trim()) {
    throw new TerminalError("INVALID_INPUT", "text is required", 400);
  }
  if (text.length > MAX_INPUT_CHARS) {
    throw new TerminalError("INVALID_INPUT", `text exceeds ${MAX_INPUT_CHARS} characters`, 400);
  }
  // Escape sequences could drive the TUI (or the terminal) in ways the user
  // never typed; only printable text, newlines and tabs go through.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(text)) {
    throw new TerminalError("INVALID_INPUT", "text contains control characters", 400);
  }
  const info = await paneInfo(term);
  if (SHELLS.has(path.basename(info.command || "").replace(/^-/, ""))) {
    throw new TerminalError("EPANESHELL", "the session's CLI is no longer running in that pane");
  }
  if (term.pid) {
    const chain = await processChain(term.pid);
    if (!chain.some((p) => p.pid === info.panePid)) {
      throw new TerminalError("EPANEMISMATCH", "that pane no longer runs this session");
    }
  }
  const buffer = `ccam-${crypto.randomUUID()}`;
  await tmux(term, ["set-buffer", "-b", buffer, "--", text]);
  // -p: bracketed paste, so a multi-line reply arrives as one message.
  await tmux(term, ["paste-buffer", "-p", "-d", "-b", buffer, "-t", term.tmux_pane]);
  await new Promise((r) => setTimeout(r, SUBMIT_DELAY_MS));
  await tmux(term, ["send-keys", "-t", term.tmux_pane, "Enter"]);
  return { sent: true };
}

module.exports = {
  TerminalError,
  sanitizeTerminal,
  parseTerminal,
  focusTerminal,
  sendInput,
  parseGhosttyTerminals,
  sanitizeTitle,
  MAX_INPUT_CHARS,
};
