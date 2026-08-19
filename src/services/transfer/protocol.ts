/**
 * P2P transfer protocol for EverydayFuel (spec §23).
 *
 * Device-to-device transfer over a shared local network / hotspot. The two
 * devices pair by exchanging compact JSON "pairing codes" (the WebRTC offer
 * and answer SDPs — copy/paste or QR). Once the data channel is open the
 * sender pushes the already-encrypted backup envelope (encryptBackup) as
 * chunked JSON messages with a SHA-256 integrity check; the receiver verifies
 * and then runs the standard decrypt -> parse -> validate -> restore flow.
 *
 * All functions here are pure protocol logic (no WebRTC, no DOM), so the
 * whole message layer is unit-testable in Node. The transport adapter
 * (webrtc-transport.ts) is the only WebRTC-dependent part.
 */

export const TRANSFER_APP_TAG = 'EverydayFuel';
export const TRANSFER_PROTOCOL_VERSION = 1;

/** Chunk size for payload strings sent over the data channel (16 KiB). */
export const DEFAULT_CHUNK_SIZE = 16 * 1024;

/** How long the sender waits for the channel to open / the peer to ack. */
export const DEFAULT_OPEN_TIMEOUT_MS = 300_000;
export const DEFAULT_ACK_TIMEOUT_MS = 300_000;

/** Defensive upper bound for a transferred payload (256 MB of text). */
export const MAX_PAYLOAD_CHARS = 256 * 1024 * 1024;

export interface PairingCode {
  app: string;
  version: number;
  sdp: string;
}

/**
 * Serialize a local SDP description into a compact, portable pairing code.
 * The code is self-describing (app tag + protocol version) so mismatched
 * apps fail fast at parse time.
 */
export function encodePairingCode(sdp: string): string {
  return JSON.stringify({
    app: TRANSFER_APP_TAG,
    v: TRANSFER_PROTOCOL_VERSION,
    sdp
  });
}

/**
 * Parse and validate a pairing code. Returns null for garbage, foreign
 * formats, or an empty SDP — never throws.
 */
export function parsePairingCode(text: string): PairingCode | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.app !== TRANSFER_APP_TAG) return null;
    if (parsed.v !== TRANSFER_PROTOCOL_VERSION) return null;
    if (typeof parsed.sdp !== 'string' || parsed.sdp.length === 0) return null;
    return { app: TRANSFER_APP_TAG, version: TRANSFER_PROTOCOL_VERSION, sdp: parsed.sdp };
  } catch {
    return null;
  }
}

export type TransferMessage =
  | { type: 'hello'; app: string; protocol: number }
  | { type: 'meta'; name: string; size: number; sha256: string; chunks: number }
  | { type: 'data'; seq: number; data: string }
  | { type: 'done' }
  | { type: 'ok' }
  | { type: 'error'; message: string };

/**
 * Parse a JSON transfer message. Every AI/peer input is untrusted: garbage,
 * unknown types and malformed fields return null (the receiver ignores them).
 */
export function parseTransferMessage(text: string): TransferMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const msg = raw as Record<string, unknown>;

  switch (msg.type) {
    case 'hello':
      if (typeof msg.app !== 'string' || typeof msg.protocol !== 'number' || !Number.isInteger(msg.protocol)) return null;
      return { type: 'hello', app: msg.app, protocol: msg.protocol };
    case 'meta':
      if (typeof msg.name !== 'string' || msg.name.length === 0) return null;
      if (typeof msg.size !== 'number' || !Number.isFinite(msg.size) || msg.size <= 0) return null;
      if (typeof msg.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(msg.sha256)) return null;
      if (typeof msg.chunks !== 'number' || !Number.isInteger(msg.chunks) || msg.chunks <= 0) return null;
      return { type: 'meta', name: msg.name, size: msg.size, sha256: msg.sha256, chunks: msg.chunks };
    case 'data':
      if (typeof msg.seq !== 'number' || !Number.isInteger(msg.seq) || msg.seq < 0) return null;
      if (typeof msg.data !== 'string') return null;
      return { type: 'data', seq: msg.seq, data: msg.data };
    case 'done':
      return { type: 'done' };
    case 'ok':
      return { type: 'ok' };
    case 'error':
      if (typeof msg.message !== 'string') return null;
      return { type: 'error', message: msg.message };
    default:
      return null;
  }
}

/**
 * Split a payload string into fixed-size chunks (JS string code units).
 */
export function chunkPayload(payload: string, chunkSize: number = DEFAULT_CHUNK_SIZE): string[] {
  if (chunkSize <= 0) throw new Error('Chunk size must be positive');
  const chunks: string[] = [];
  for (let i = 0; i < payload.length; i += chunkSize) {
    chunks.push(payload.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Reassemble the chunks received over the wire back into the payload string.
 */
export function reassembleChunks(chunks: string[]): string {
  return chunks.join('');
}

/**
 * Hex SHA-256 of a string via the Web Crypto API (browser / WebView / Node).
 */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}