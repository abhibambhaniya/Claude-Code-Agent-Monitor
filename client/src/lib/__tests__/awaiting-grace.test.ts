/**
 * @file Unit tests for the awaiting-input grace period: a 'stop' or
 * 'session_start' wait only counts as waiting after AWAITING_GRACE_MS, while a
 * 'notification' (permission prompt) wait counts at once.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AWAITING_GRACE_MS,
  effectiveAgentStatus,
  effectiveSessionStatus,
  isSessionAwaitingInput,
} from "../types";
import type { Agent, Session } from "../types";

const NOW = Date.parse("2026-10-22T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const session = (since: string, reason: string) =>
  ({ id: "s", status: "active", awaiting_input_since: since, awaiting_reason: reason }) as Session;
const agent = (since: string, reason: string) =>
  ({ id: "a", status: "waiting", awaiting_input_since: since, awaiting_reason: reason }) as Agent;

describe("awaiting grace period", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("keeps a fresh stop wait out of Waiting", () => {
    expect(isSessionAwaitingInput(session(ago(5_000), "stop"))).toBe(false);
    expect(effectiveSessionStatus(session(ago(5_000), "stop"))).toBe("active");
    expect(effectiveAgentStatus(agent(ago(5_000), "stop"))).toBe("working");
  });

  it("moves a stop wait to Waiting once the grace period passes", () => {
    expect(effectiveSessionStatus(session(ago(AWAITING_GRACE_MS), "stop"))).toBe("waiting");
    expect(effectiveAgentStatus(agent(ago(AWAITING_GRACE_MS), "stop"))).toBe("waiting");
  });

  it("shows a permission prompt as Waiting at once", () => {
    expect(effectiveSessionStatus(session(ago(0), "notification"))).toBe("waiting");
    expect(effectiveAgentStatus(agent(ago(0), "notification"))).toBe("waiting");
  });

  it("treats an unparseable timestamp as elapsed", () => {
    expect(isSessionAwaitingInput(session("not-a-date", "stop"))).toBe(true);
  });
});
