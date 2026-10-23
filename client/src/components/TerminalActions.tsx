/**
 * @file TerminalActions.tsx
 * @description Card footer actions that reach a live session's terminal: an
 * "Open terminal" button (focuses the session's tmux pane and raises the
 * terminal app) and, while the session waits inside tmux or Ghostty, a one-line
 * reply box that types into its pane or surface. Renders nothing for sessions without a terminal
 * record (remote, imported, or started before the hooks reported one).
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SquareTerminal, Send } from "lucide-react";
import { api } from "../lib/api";
import { sessionTerminal } from "../lib/types";
import type { Session } from "../lib/types";

interface TerminalActionsProps {
  session: Session;
  /** Show the reply box (the session is waiting on the user). */
  waiting: boolean;
}

export function TerminalActions({ session, waiting }: TerminalActionsProps) {
  const { t } = useTranslation("kanban");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const terminal = sessionTerminal(session);
  if (!terminal || session.status !== "active") return null;

  async function act(fn: () => Promise<unknown>, okText: string | null) {
    setBusy(true);
    setNote(null);
    try {
      await fn();
      if (okText) setNote({ ok: true, text: okText });
      return true;
    } catch (err) {
      setNote({ ok: false, text: t("terminal.failed", { message: (err as Error).message }) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!text.trim()) return;
    if (await act(() => api.terminal.input(session.id, text), t("terminal.sent"))) setText("");
  }

  return (
    // Cards navigate on click; keep clicks and keys inside these controls.
    <div
      className="mt-3 space-y-1.5"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={() => act(() => api.terminal.focus(session.id), null)}
          title={t("terminal.openTitle")}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-gray-300 bg-surface-3 hover:bg-surface-4 border border-border disabled:opacity-50 flex-shrink-0"
        >
          <SquareTerminal className="w-3 h-3" />
          {t("terminal.open")}
        </button>
        {waiting && (terminal.tmux || terminal.ghostty) && (
          <form
            className="flex items-center gap-1 min-w-0 flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t("terminal.replyPlaceholder")}
              aria-label={t("terminal.replyPlaceholder")}
              maxLength={4000}
              className="min-w-0 flex-1 px-2 py-1 rounded-md text-[11px] bg-surface-2 border border-border text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-accent/50"
            />
            <button
              type="submit"
              disabled={busy || !text.trim()}
              aria-label={t("terminal.send")}
              title={t("terminal.send")}
              className="p-1.5 rounded-md text-accent bg-accent/15 hover:bg-accent/25 disabled:opacity-40 flex-shrink-0"
            >
              <Send className="w-3 h-3" />
            </button>
          </form>
        )}
      </div>
      {note && (
        <p
          role="status"
          className={`text-[11px] truncate ${note.ok ? "text-emerald-400" : "text-red-400"}`}
          title={note.text}
        >
          {note.text}
        </p>
      )}
    </div>
  );
}
