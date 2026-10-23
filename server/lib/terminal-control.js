/**
 * @file terminal-control.js
 * @description Reaches the terminal a local Claude Code / Codex session runs in.
 * Hook handlers report the session's tmux pane (`$TMUX_PANE` plus the socket
 * from `$TMUX`) and the CLI's pid; this module validates that record, focuses
 * the session (tmux select/switch-client, then raises the terminal app on
 * macOS — in Ghostty, the exact window/tab/split), and types a reply into a
 * tmux pane or, outside tmux, a Ghostty surface. Every external command runs via execFile with an argument array
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
 * @returns {{tmux_pane?: string, tmux_socket?: string, pid?: number, ghostty?: true} | null}
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
  if (raw.ghostty === true && out.pid && !out.tmux_pane) out.ghostty = true;
  return Object.keys(out).length ? out : null;
}

/**
 * Parse the `sessions.terminal` column; null when absent or malformed. Keeps
 * `seen_at`, which only the server writes (hooks cannot supply it).
 */
function parseTerminal(json) {
  if (!json) return null;
  try {
    const raw = JSON.parse(json);
    const term = sanitizeTerminal(raw);
    if (term?.ghostty && typeof raw.seen_at === "string") term.seen_at = raw.seen_at;
    return term;
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
// it. LIST snapshots titles first so the real one can be put back; records
// end in RS (\x1e), fields split on US (\x1f), so trimming the output never
// eats a title's own whitespace.
const GHOSTTY_LIST = `on run argv
  tell application "Ghostty" to set {ids, names} to {id, name} of every terminal
  set out to ""
  repeat with i from 1 to count of ids
    set out to out & item i of ids & (character id 31) & item i of names & (character id 30)
  end repeat
  return out
end run`;
// Waits up to ~1 s for the marker title to reach Ghostty and returns that
// surface's id ("" when it never showed). Mode "focus" also focuses it
// (activating first, or macOS may raise the last-active window over it) and
// "!"-prefixes the id when that failed.
const GHOSTTY_FIND = `on run argv
  set {marker, mode} to {item 1 of argv, item 2 of argv}
  tell application "Ghostty"
    if mode is "focus" then activate
    repeat 20 times
      set hits to (every terminal whose name is marker)
      if (count of hits) > 0 then
        set t to item 1 of hits
        set tid to id of t
        if mode is "focus" then
          try
            focus t
          on error
            return "!" & tid
          end try
        end if
        return tid
      end if
      delay 0.05
    end repeat
  end tell
  return ""
end run`;

// Pastes argv 2 into terminal argv 1, or presses Enter there when no text is
// given. Focus does not change.
const GHOSTTY_TYPE = `on run argv
  tell application "Ghostty"
    set t to first terminal whose id is (item 1 of argv)
    if (count of argv) > 1 then
      input text (item 2 of argv) to t
    else
      send key "enter" to t
    end if
  end tell
end run`;

/** Parse GHOSTTY_LIST output into a Map of terminal id -> title. */
function parseGhosttyTerminals(out) {
  const titles = new Map();
  for (const record of String(out).split("\x1e")) {
    const sep = record.indexOf("\x1f");
    if (sep > 0) titles.set(record.slice(0, sep), record.slice(sep + 1));
  }
  return titles;
}

/**
 * A title safe to embed in OSC 2: no C0/C1 controls (ESC/BEL end the
 * sequence), under 256 UTF-8 bytes (Ghostty ignores longer titles).
 */
function sanitizeTitle(title) {
  // eslint-disable-next-line no-control-regex
  const chars = Array.from(String(title ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, ""));
  let bytes = Buffer.byteLength(chars.join(""));
  while (bytes > 255) bytes -= Buffer.byteLength(chars.pop());
  return chars.join("");
}

function writeTitle(tty, title) {
  // O_NOCTTY: the server must not adopt the session's tty as its own.
  // O_NONBLOCK: a terminal paused with ^S must not hang the request.
  const { O_WRONLY, O_NOCTTY, O_NONBLOCK } = fs.constants;
  const fd = fs.openSync(tty, O_WRONLY | O_NOCTTY | O_NONBLOCK);
  // A full tty buffer can take part of it; finish or throw (EAGAIN), never
  // stop mid-sequence silently. `partial` tells the caller bytes got through.
  const buf = Buffer.from(`\x1b]2;${sanitizeTitle(title)}\x07`);
  let off = 0;
  try {
    while (off < buf.length) off += fs.writeSync(fd, buf, off);
  } catch (err) {
    err.partial = off > 0;
    throw err;
  } finally {
    fs.closeSync(fd);
  }
}

const MARKER_RE = /^ccam-[0-9a-f-]{36}$/;
// Title each surface was last restored to. Ghostty applies OSC 2 a moment
// after the write, so a back-to-back snapshot can still show the old marker.
const restoredTitles = new Map();

/**
 * Find the Ghostty surface attached to `tty` (`mode` "find") and focus it
 * (`mode` "focus"). Returns its terminal id, or "" when it was not found or
 * focus failed; throws when Ghostty or the tty cannot be reached.
 */
async function findGhosttySurface(tty, mode) {
  const marker = `ccam-${crypto.randomUUID()}`;
  const titles = parseGhosttyTerminals(await run("osascript", ["-e", GHOSTTY_LIST]));
  try {
    writeTitle(tty, marker);
  } catch (err) {
    // Nothing written leaves the title untouched; a cut-short marker must not
    // stay mid-sequence.
    if (err.partial) writeTitle(tty, "");
    throw err;
  }
  let found = "";
  try {
    found = await run("osascript", ["-e", GHOSTTY_FIND, marker, mode]);
  } finally {
    // ponytail: marker never seen -> the surface and its old title are
    // unknown, so the title is cleared (better than leaving the marker); the
    // CLI or shell sets a fresh one on its next redraw/prompt.
    const id = found.replace(/^!/, "");
    let title = titles.get(id) ?? "";
    if (MARKER_RE.test(title)) title = restoredTitles.get(id) ?? "";
    if (id) restoredTitles.set(id, title);
    writeTitle(tty, title);
  }
  return found.startsWith("!") ? "" : found;
}

/** `/dev/ttysNNN` the process `pid` writes to, or null (no tty / gone). */
async function ttyOf(pid) {
  const name = await run("ps", ["-o", "tty=", "-p", String(pid)]).catch(() => "");
  return /^ttys\d+$/.test(name) ? `/dev/${name}` : null;
}

/** Bundle path of the first `.app` among `pid`'s ancestors, or null. */
async function hostBundle(pid) {
  for (const { comm } of await processChain(pid)) {
    const m = comm.match(/^(\/.+?\.app)\/Contents\/MacOS\//);
    if (m) return m[1];
  }
  return null;
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
  const bundle = process.platform === "darwin" && pid ? await hostBundle(pid) : null;
  if (!bundle) return { app: null, exact: false };
  const app = path.basename(bundle, ".app");
  let exact = false;
  if (app === "Ghostty") {
    const surface = tty || (await ttyOf(pid));
    if (surface) exact = Boolean(await findGhosttySurface(surface, "focus").catch(() => ""));
  }
  if (!exact) await run("open", ["-a", bundle]);
  return { app, exact };
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

// Focus and input requests run one at a time, start to finish: an overlapping
// one could switch the tmux client between the other's selection and its
// Ghostty probe, or snapshot the other's marker as the title to restore.
// ponytail: one global queue; key it by tty if requests ever pile up.
let terminalQueue = Promise.resolve();
function queued(fn) {
  const turn = terminalQueue.then(fn);
  terminalQueue = turn.catch(() => {});
  return turn;
}

/**
 * Bring the session's terminal to the front: select its tmux window and pane,
 * switch an attached client to it, and raise the terminal app hosting that
 * client. Without tmux, raise the app hosting the CLI process. `exact` says
 * whether the precise window/tab/split was focused (Ghostty only).
 */
function focusTerminal(term) {
  return queued(() => focusNow(term));
}

async function focusNow(term) {
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

function checkInput(text) {
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
}

/** Milliseconds in a `ps -o etime` value (`[[dd-]hh:]mm:ss`); NaN if malformed. */
function etimeMs(etime) {
  const [days, clock] = String(etime).includes("-") ? etime.split("-") : [0, etime];
  const secs = String(clock)
    .split(":")
    .reduce((acc, part) => acc * 60 + Number(part), 0);
  return (Number(days) * 86400 + secs) * 1000;
}

/**
 * Throw unless `pid` is still the session's CLI and owns `tty`'s foreground.
 * It must have started no later than the last hook that reported it
 * (`seenAt`), or the pid was reused; it must still sit on `tty` and lead the foreground
 * process group, and that group must not be a shell (the CLI exited).
 */
async function assertCliForeground(pid, tty, seenAt) {
  const line = await run("ps", ["-o", "pgid=,tpgid=,tty=,etime=", "-p", String(pid)]).catch(
    () => ""
  );
  const [pgid, tpgid, ttyName, etime] = line.split(/\s+/);
  const fg = tpgid ? await run("ps", ["-o", "comm=", "-p", tpgid]).catch(() => "") : "";
  if (!fg || SHELLS.has(path.basename(fg).replace(/^-/, ""))) {
    throw new TerminalError(
      "EPANESHELL",
      "the session's CLI is no longer running in that terminal"
    );
  }
  // etime truncates to whole seconds, so `started` can run up to 1 s late.
  // ponytail: a pid reused within 1 s of the CLI's last hook, on the same tty
  // and in its foreground, still passes; an OS start-time API would close it.
  const started = Date.now() - etimeMs(etime);
  if (`/dev/${ttyName}` !== tty || !(started <= Date.parse(seenAt) + 1000)) {
    throw new TerminalError("EPANEMISMATCH", "that process no longer belongs to this session");
  }
  if (pgid !== tpgid) {
    throw new TerminalError(
      "EPANEMISMATCH",
      "the session's CLI is not in the foreground of its terminal"
    );
  }
}

/**
 * Outside tmux: paste `text` into the Ghostty surface on the CLI's tty and
 * press Enter. The CLI's ownership of that tty is checked before the surface
 * is looked up, again right before the paste, and again before Enter.
 */
async function sendGhosttyInput(term, text) {
  const tty = process.platform === "darwin" && term?.pid ? await ttyOf(term.pid) : null;
  const bundle = tty ? await hostBundle(term.pid) : null;
  if (!bundle || path.basename(bundle, ".app") !== "Ghostty") {
    throw new TerminalError("ENOTMUX", "session is not running inside tmux or Ghostty");
  }
  checkInput(text);
  const ensure = () => assertCliForeground(term.pid, tty, term.seen_at);
  await ensure();
  const id = await findGhosttySurface(tty, "find");
  if (!id) {
    throw new TerminalError("ENOSURFACE", "the session's Ghostty terminal could not be found");
  }
  await ensure();
  await run("osascript", ["-e", GHOSTTY_TYPE, id, text]);
  await new Promise((r) => setTimeout(r, SUBMIT_DELAY_MS));
  // ponytail: ~100 ms (one osascript launch) remain between this check and
  // Enter; closing that needs Ghostty to report a surface's pid or tty.
  await ensure();
  await run("osascript", ["-e", GHOSTTY_TYPE, id]);
  return { sent: true };
}

/**
 * Type `text` into the session's tmux pane and press Enter. Refuses unless the
 * pane still runs the session's CLI: the foreground command must not be a
 * shell, and the recorded CLI pid (when known) must be a descendant of the
 * pane's process. Outside tmux, Ghostty sessions go through sendGhosttyInput.
 */
function sendInput(term, text) {
  return queued(() => (term?.tmux_pane ? sendTmuxInput(term, text) : sendGhosttyInput(term, text)));
}

async function sendTmuxInput(term, text) {
  checkInput(text);
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
  etimeMs,
  MAX_INPUT_CHARS,
};
