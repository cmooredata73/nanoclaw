/**
 * Destination map — lives in inbound.db's `destinations` table.
 *
 * The host writes this table before every container wake AND on demand
 * (e.g. when a new child agent is created mid-session). The container
 * queries the table live on every lookup, so admin changes take effect
 * immediately — no restart required.
 *
 * This table is BOTH the routing map and the container-visible ACL.
 * The host re-validates on the delivery side against the central DB,
 * so even if this table is stale the host's enforcement is authoritative.
 */
import { getInboundDb } from './db/connection.js';
import { getSessionRouting } from './db/session-routing.js';

/**
 * Reserved destination name meaning "the chat/channel this session
 * originated from" — mirrors the host's `isOriginChat` permission rule in
 * delivery.ts, which always allows a reply to a session's own origin
 * messaging group even without an explicit `agent_destinations` row.
 *
 * Without this, a session whose origin chat isn't also wired as a named
 * destination (e.g. an agent-to-agent-only agent whose session nonetheless
 * started from a channel message) can never resolve a `to=` name for that
 * chat: `findByRouting` misses, `originAttr` stamps a synthetic
 * `unknown:<channel>:<platform>` label as `from=`, the agent dutifully
 * echoes that back per the "reply to the same destination as `from`"
 * instruction, and `findByName` can never resolve it — the reply is
 * silently dropped, deterministically, on every message in that chat.
 * `current` closes that gap by giving the origin chat a name that both
 * lookup functions below can always resolve.
 */
const CURRENT_NAME = 'current';

function currentDestinationEntry(): DestinationEntry | undefined {
  const routing = getSessionRouting();
  if (!routing.channel_type || !routing.platform_id) return undefined;
  return {
    name: CURRENT_NAME,
    displayName: 'current conversation',
    type: 'channel',
    channelType: routing.channel_type,
    platformId: routing.platform_id,
  };
}

export interface DestinationEntry {
  name: string;
  displayName: string;
  type: 'channel' | 'agent';
  channelType?: string;
  platformId?: string;
  agentGroupId?: string;
}

interface DestRow {
  name: string;
  display_name: string | null;
  type: 'channel' | 'agent';
  channel_type: string | null;
  platform_id: string | null;
  agent_group_id: string | null;
}

function rowToEntry(row: DestRow): DestinationEntry {
  return {
    name: row.name,
    displayName: row.display_name ?? row.name,
    type: row.type,
    channelType: row.channel_type ?? undefined,
    platformId: row.platform_id ?? undefined,
    agentGroupId: row.agent_group_id ?? undefined,
  };
}

export function getAllDestinations(): DestinationEntry[] {
  const rows = getInboundDb().prepare('SELECT * FROM destinations ORDER BY name').all() as DestRow[];
  return rows.map(rowToEntry);
}

export function findByName(name: string): DestinationEntry | undefined {
  const row = getInboundDb().prepare('SELECT * FROM destinations WHERE name = ?').get(name) as DestRow | undefined;
  if (row) return rowToEntry(row);
  // An explicit `agent_destinations` row named "current" (admin-configured)
  // always wins over the reserved fallback above.
  if (name === CURRENT_NAME) return currentDestinationEntry();
  return undefined;
}

/**
 * Reverse lookup: given routing fields from an inbound message, find
 * which destination they correspond to (what does this agent call the sender?).
 */
export function findByRouting(
  channelType: string | null | undefined,
  platformId: string | null | undefined,
): DestinationEntry | undefined {
  if (!channelType || !platformId) return undefined;
  const db = getInboundDb();
  const row =
    channelType === 'agent'
      ? (db
          .prepare("SELECT * FROM destinations WHERE type = 'agent' AND agent_group_id = ?")
          .get(platformId) as DestRow | undefined)
      : (db
          .prepare("SELECT * FROM destinations WHERE type = 'channel' AND channel_type = ? AND platform_id = ?")
          .get(channelType, platformId) as DestRow | undefined);
  if (row) return rowToEntry(row);

  // No named destination matches — but if these routing fields are this
  // session's own origin chat, label it `current` rather than falling
  // through to the unresolvable `unknown:<channel>:<platform>` form.
  const routing = getSessionRouting();
  if (routing.channel_type === channelType && routing.platform_id === platformId) {
    return currentDestinationEntry();
  }
  return undefined;
}

/**
 * Generate the system-prompt addendum: agent identity + destination map.
 *
 * Identity is injected here (not in the shared CLAUDE.md) because it's
 * per-agent-group and changes when the operator renames an agent, while
 * the shared base is identical across all agents.
 */
export function buildSystemPromptAddendum(assistantName?: string): string {
  const sections: string[] = [];

  if (assistantName) {
    sections.push(['# You are ' + assistantName, '', `Your name is **${assistantName}**. Use it when the channel asks who you are, when introducing yourself, and when signing any message that explicitly calls for a signature.`].join('\n'));
  }

  sections.push(buildDestinationsSection());

  return sections.join('\n\n');
}

function buildDestinationsSection(): string {
  const all = getAllDestinations();

  if (all.length === 0) {
    const current = currentDestinationEntry();
    if (!current) {
      return [
        '## Sending messages',
        '',
        'You currently have no configured destinations. You cannot send messages until an admin wires one up.',
      ].join('\n');
    }
    return [
      '## Sending messages',
      '',
      `Your destination is \`${CURRENT_NAME}\` (the conversation this session started from).`,
      '',
      '**Every response must be wrapped** in a `<message to="name">...</message>` block.',
      'Text outside of `<message>` blocks is scratchpad — logged but not sent anywhere.',
      'Use `<internal>...</internal>` to make scratchpad intent explicit.',
    ].join('\n');
  }

  const lines = ['## Sending messages', ''];
  if (all.length === 1) {
    const d = all[0];
    const label = d.displayName && d.displayName !== d.name ? ` (${d.displayName})` : '';
    lines.push(`Your destination is \`${d.name}\`${label}.`);
  } else {
    lines.push('You can send messages to the following destinations:', '');
    for (const d of all) {
      const label = d.displayName && d.displayName !== d.name ? ` (${d.displayName})` : '';
      lines.push(`- \`${d.name}\`${label}`);
    }
  }
  if (currentDestinationEntry() && !all.some((d) => d.name === CURRENT_NAME)) {
    lines.push(`- \`${CURRENT_NAME}\` (the conversation this session started from)`);
  }
  lines.push('');
  lines.push('**Every response must be wrapped** in a `<message to="name">...</message>` block.');
  lines.push('You can include multiple `<message>` blocks in one response to send to multiple destinations.');
  lines.push('Text outside of `<message>` blocks is scratchpad — logged but not sent anywhere.');
  lines.push('Use `<internal>...</internal>` to make scratchpad intent explicit.');
  lines.push('');
  lines.push(
    '**Default routing**: when replying to an incoming message, address the same destination the message came `from` — every inbound `<message>` tag carries a `from="name"` attribute that names the origin destination. Only address a different destination when the request itself asks you to (e.g., "tell Laura that…").',
  );
  lines.push('');
  lines.push(
    'To send a message mid-response (e.g., an acknowledgment before a long task), call the `send_message` MCP tool with the `to` parameter set to a destination name.',
  );
  return lines.join('\n');
}
