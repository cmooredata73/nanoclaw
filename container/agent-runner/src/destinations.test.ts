import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from './db/connection.js';
import { buildSystemPromptAddendum, findByName, findByRouting } from './destinations.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function seedDestination(name: string, displayName: string, channelType: string, platformId: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', ?, ?, NULL)`,
    )
    .run(name, displayName, channelType, platformId);
}

function seedAgentDestination(name: string, agentGroupId: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'agent', NULL, NULL, ?)`,
    )
    .run(name, name, agentGroupId);
}

function seedSessionRouting(channelType: string, platformId: string, threadId: string | null = null): void {
  getInboundDb()
    .prepare(`INSERT INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, ?, ?, ?)`)
    .run(channelType, platformId, threadId);
}

describe('buildSystemPromptAddendum — multi-destination routing guidance', () => {
  it('includes default-routing nudge when there are >1 destinations', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');
    seedDestination('whatsapp-mg-17780', 'whatsapp-mg-17780', 'whatsapp', 'phone-2@s.whatsapp.net');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('Default routing');
    expect(prompt).toContain('from="name"');
    expect(prompt).toContain('`casa`');
    expect(prompt).toContain('`whatsapp-mg-17780`');
  });

  it('requires explicit wrapping even for a single destination', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('Every response must be wrapped');
    expect(prompt).toContain('<message to="name">');
    expect(prompt).toContain('`casa`');
  });

  it('handles the no-destination case without crashing', () => {
    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('no configured destinations');
    expect(prompt).not.toContain('Default routing');
  });

  it('includes default-routing and wrapping instructions for single destination', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('Every response must be wrapped');
    expect(prompt).toContain('<message to="name">');
    expect(prompt).toContain('Default routing');
    expect(prompt).toContain('`casa`');
  });
});

// Regression coverage for the "Hondo says it replied to you directly, you
// don't see it" bug: an agent-to-agent-only agent (e.g. Jocko) whose session
// originated from a channel message it has no *named* channel destination
// for. Before the `current` fallback, `findByRouting` missed, `originAttr`
// stamped `from="unknown:<channel>:<platform>"`, the agent echoed that
// literal string back as `to=`, and `findByName` could never resolve it —
// the reply was silently dropped on every single message in that chat.
describe('origin-chat fallback ("current")', () => {
  it('findByRouting resolves the session\'s own origin chat to "current" when no named destination covers it', () => {
    seedAgentDestination('hondo', 'ag-hondo');
    seedSessionRouting('telegram', 'telegram:8673467010');

    const dest = findByRouting('telegram', 'telegram:8673467010');

    expect(dest?.name).toBe('current');
    expect(dest?.type).toBe('channel');
    expect(dest?.channelType).toBe('telegram');
    expect(dest?.platformId).toBe('telegram:8673467010');
  });

  it('findByRouting still returns undefined for routing that matches neither a destination nor the session origin', () => {
    seedAgentDestination('hondo', 'ag-hondo');
    seedSessionRouting('telegram', 'telegram:8673467010');

    expect(findByRouting('telegram', 'telegram:999999')).toBeUndefined();
  });

  it('findByName("current") resolves via session_routing even with zero channel destinations', () => {
    seedAgentDestination('hondo', 'ag-hondo');
    seedSessionRouting('telegram', 'telegram:8673467010');

    const dest = findByName('current');

    expect(dest?.type).toBe('channel');
    expect(dest?.channelType).toBe('telegram');
    expect(dest?.platformId).toBe('telegram:8673467010');
  });

  it('findByName("current") returns undefined when the session has no origin chat', () => {
    seedAgentDestination('hondo', 'ag-hondo');

    expect(findByName('current')).toBeUndefined();
  });

  it('an explicit admin-configured "current" destination wins over the reserved fallback', () => {
    seedDestination('current', 'Explicit Current', 'slack', 'C-EXPLICIT');
    seedSessionRouting('telegram', 'telegram:8673467010');

    const dest = findByName('current');

    expect(dest?.channelType).toBe('slack');
    expect(dest?.platformId).toBe('C-EXPLICIT');
  });

  it('advertises "current" in the system prompt for an agent-only agent bound to a channel origin', () => {
    seedAgentDestination('hondo', 'ag-hondo');
    seedSessionRouting('telegram', 'telegram:8673467010');

    const prompt = buildSystemPromptAddendum('Jocko');

    expect(prompt).toContain('`current`');
    expect(prompt).not.toContain('no configured destinations');
  });

  it('handles zero named destinations but a valid session origin without the "no destinations" dead end', () => {
    seedSessionRouting('telegram', 'telegram:8673467010');

    const prompt = buildSystemPromptAddendum('Jocko');

    expect(prompt).toContain('`current`');
    expect(prompt).not.toContain('no configured destinations');
  });
});
