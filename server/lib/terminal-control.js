/**
 * @file terminal-control.js
 * @description Reaches the terminal a local Claude Code / Codex session runs in.
 * Hook handlers report the session's tmux pane (`$TMUX_PANE` plus the socket
 * from `$TMUX`) and the CLI's pid; this module validates that record, focuses
 * the session (tmux select/switch-client, then raises the terminal app on
 * macOS), and types a reply into a tmux pane. Every external command runs via
 * execFile with an argument array — never through a shell.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
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

/**
 * Raise the macOS app that hosts `pid` (the first `.app` bundle among its
 * ancestors). Returns the app name, or null when none is found / not macOS.
 * ponytail: brings the app forward, not the exact tab or window; add
 * per-terminal AppleScript (iTerm2/Terminal select by tty) if that matters.
 */
async function activateApp(pid) {
  if (process.platform !== "darwin" || !pid) return null;
  for (const { comm } of await processChain(pid)) {
    const m = comm.match(/^(\/.+?\.app)\/Contents\/MacOS\//);
    if (m) {
      await run("open", ["-a", m[1]]);
      return path.basename(m[1], ".app");
    }
  }
  return null;
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
 * client. Without tmux, raise the app hosting the CLI process.
 */
async function focusTerminal(term) {
  if (term?.tmux_pane) {
    const info = await paneInfo(term);
    await tmux(term, ["select-window", "-t", term.tmux_pane]);
    await tmux(term, ["select-pane", "-t", term.tmux_pane]);
    const clients = (
      await tmux(term, ["list-clients", "-F", "#{client_pid}\t#{client_name}\t#{client_session}"])
    )
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [pid, name, session] = l.split("\t");
        return { pid: Number(pid), name, session };
      });
    const client = clients.find((c) => c.session === info.session) || clients[0];
    if (!client) return { tmux: true, attached: false, app: null };
    await tmux(term, ["switch-client", "-c", client.name, "-t", term.tmux_pane]);
    return { tmux: true, attached: true, app: await activateApp(client.pid) };
  }
  if (term?.pid) {
    const app = await activateApp(term.pid);
    if (app) return { tmux: false, attached: true, app };
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
  MAX_INPUT_CHARS,
};
