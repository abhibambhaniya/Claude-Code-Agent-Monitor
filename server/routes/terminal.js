/**
 * @file terminal.js
 * @description HTTP routes that reach a live session's terminal:
 * `POST /api/terminal/:sessionId/focus` raises the session's tmux pane and
 * terminal app, and `POST /api/terminal/:sessionId/input` types a reply into
 * its tmux pane. Both act on processes on this machine, so they share the Run
 * Agent loopback-Origin guard against cross-site drive-bys.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { Router } = require("express");
const { stmts } = require("../db");
const { __sameOriginGuard: sameOriginGuard } = require("./run");
const {
  TerminalError,
  parseTerminal,
  focusTerminal,
  sendInput,
} = require("../lib/terminal-control");

const router = Router();
router.use(sameOriginGuard);

/** Resolve the session and its terminal record, or answer with an error. */
function loadTerminal(req, res) {
  const session = stmts.getSession.get(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "session not found" } });
    return null;
  }
  if (session.status !== "active") {
    res.status(409).json({ error: { code: "ENOTACTIVE", message: "session is no longer active" } });
    return null;
  }
  const terminal = parseTerminal(session.terminal);
  if (!terminal) {
    res.status(409).json({
      error: { code: "ENOTERMINAL", message: "no terminal recorded for this session" },
    });
    return null;
  }
  return terminal;
}

function sendError(res, err) {
  if (err instanceof TerminalError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  return res
    .status(500)
    .json({ error: { code: "ETERMINAL", message: err?.message || "terminal command failed" } });
}

router.post("/:sessionId/focus", async (req, res) => {
  const terminal = loadTerminal(req, res);
  if (!terminal) return;
  try {
    res.json({ ok: true, ...(await focusTerminal(terminal)) });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/:sessionId/input", async (req, res) => {
  const terminal = loadTerminal(req, res);
  if (!terminal) return;
  try {
    res.json({ ok: true, ...(await sendInput(terminal, req.body?.text)) });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
