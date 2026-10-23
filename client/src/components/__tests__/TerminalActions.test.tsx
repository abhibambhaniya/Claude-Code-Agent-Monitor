/**
 * @file Tests for TerminalActions: hidden without a terminal record, "Open
 * terminal" for any active local session, and the reply box only while the
 * session waits inside tmux.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TerminalActions } from "../TerminalActions";
import type { Session } from "../../lib/types";

const input = vi.fn().mockResolvedValue({ ok: true, sent: true });
vi.mock("../../lib/api", () => ({
  api: {
    terminal: {
      focus: vi.fn().mockResolvedValue({ ok: true }),
      input: (...a: unknown[]) => input(...a),
    },
  },
}));

const session = (terminal: string | null) =>
  ({ id: "s1", status: "active", started_at: "", updated_at: "", terminal }) as unknown as Session;
const TMUX = JSON.stringify({ pid: 9, tmux_pane: "%1", tmux_socket: "/tmp/s" });

describe("TerminalActions", () => {
  it("renders nothing without a terminal record", () => {
    const { container } = render(<TerminalActions session={session(null)} waiting />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers Open terminal but no reply box outside tmux", () => {
    render(<TerminalActions session={session(JSON.stringify({ pid: 9 }))} waiting />);
    expect(screen.getByText("Open terminal")).toBeInTheDocument();
    expect(screen.queryByLabelText("Reply to this session…")).toBeNull();
  });

  it("hides the reply box while the session is not waiting", () => {
    render(<TerminalActions session={session(TMUX)} waiting={false} />);
    expect(screen.queryByLabelText("Reply to this session…")).toBeNull();
  });

  it("sends the reply and clears the box", async () => {
    render(<TerminalActions session={session(TMUX)} waiting />);
    const box = screen.getByLabelText("Reply to this session…");
    fireEvent.change(box, { target: { value: "go ahead" } });
    fireEvent.click(screen.getByLabelText("Send reply"));
    await waitFor(() => expect(screen.getByText("Reply sent")).toBeInTheDocument());
    expect(input).toHaveBeenCalledWith("s1", "go ahead");
    expect(box).toHaveValue("");
  });
});
