/**
 * P2P transfer service for EverydayFuel (spec §23).
 *
 * Orchestrates the encrypted device-to-device backup transfer over a
 * TransferTransport. The actual backup payload is the output of
 * encryptBackup() (or a plain archive JSON) — this service only moves it
 * reliably between devices:
 *
 *   sender:   hello -> meta -> data chunks -> done -> await ok/error
 *   receiver: verify hello -> meta -> chunks -> checksum -> ok/error
 *
 * The receiver hands back { name, payload }; the caller then runs the
 * standard decrypt -> parse -> validate -> restore flow, so P2P reuses the
 * exact same import/export/restore logic as file backup.
 */

import {
  TransferPeer,
  TransferTransport
} from './transport';
import {
  TRANSFER_APP_TAG,
  TRANSFER_PROTOCOL_VERSION,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_OPEN_TIMEOUT_MS,
  DEFAULT_ACK_TIMEOUT_MS,
  MAX_PAYLOAD_CHARS,
  chunkPayload,
  reassembleChunks,
  sha256Hex,
  parseTransferMessage
} from './protocol';

export interface TransferProgress {
  receivedBytes: number;
  totalBytes: number;
}

export interface TransferServiceOptions {
  chunkSize?: number;
  openTimeoutMs?: number;
  ackTimeoutMs?: number;
  maxPayloadChars?: number;
}

export interface ReceivedTransfer {
  name: string;
  payload: string;
}

export class P2PTransferService {
  private readonly chunkSize: number;
  private readonly openTimeoutMs: number;
  private readonly ackTimeoutMs: number;
  private readonly maxPayloadChars: number;

  constructor(
    private readonly transport: TransferTransport,
    options: TransferServiceOptions = {}
  ) {
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    this.ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    this.maxPayloadChars = options.maxPayloadChars ?? MAX_PAYLOAD_CHARS;
  }

  /** Receiver: build the offer pairing code to share with the sender. */
  createPairingCode(): Promise<string> {
    return this.transport.createPairingCode();
  }

  /** Receiver: apply the sender's answer code and wait for the connection. */
  acceptConnection(answerCode: string): Promise<TransferPeer> {
    return this.transport.acceptConnection(answerCode);
  }

  /**
   * Sender: consume the receiver's offer. Resolves with the peer (channel may
   * still be opening) and the answer code to send back to the receiver.
   */
  connect(pairingCode: string): Promise<{ peer: TransferPeer; answerCode: string }> {
    return this.transport.connect(pairingCode);
  }

  /**
   * Sender: push an (already encrypted) backup payload to the receiver.
   * Waits for the channel to open, then streams hello/meta/chunks/done and
   * resolves when the receiver acknowledges with 'ok'.
   */
  async sendBackup(
    peer: TransferPeer,
    payload: string,
    name: string,
    onProgress?: (progress: TransferProgress) => void
  ): Promise<void> {
    if (!payload) throw new Error('Nothing to send');
    if (payload.length > this.maxPayloadChars) throw new Error('Transfer payload too large');

    await waitForOpen(peer, this.openTimeoutMs);

    const chunks = chunkPayload(payload, this.chunkSize);
    const sha256 = await sha256Hex(payload);

    peer.send(JSON.stringify({ type: 'hello', app: TRANSFER_APP_TAG, protocol: TRANSFER_PROTOCOL_VERSION }));
    peer.send(JSON.stringify({ type: 'meta', name, size: payload.length, sha256, chunks: chunks.length }));

    let sentBytes = 0;
    for (let seq = 0; seq < chunks.length; seq++) {
      peer.send(JSON.stringify({ type: 'data', seq, data: chunks[seq] }));
      sentBytes += chunks[seq].length;
      onProgress?.({ receivedBytes: sentBytes, totalBytes: payload.length });
    }

    peer.send(JSON.stringify({ type: 'done' }));
    await waitForAck(peer, this.ackTimeoutMs);
  }

  /**
   * Receiver: await a complete transfer from the sender. Resolves with the
   * payload once its size and SHA-256 checksum have been verified, rejects
   * with a descriptive error on protocol violations or peer failure.
   */
  receiveBackup(
    peer: TransferPeer,
    onProgress?: (progress: TransferProgress) => void
  ): Promise<ReceivedTransfer> {
    return new Promise((resolve, reject) => {
      let phase: 'hello' | 'meta' | 'data' | 'done' = 'hello';
      let meta: { name: string; size: number; sha256: string; chunks: number } | null = null;
      const chunks: string[] = [];
      let receivedBytes = 0;
      let settled = false;

      const timer = setTimeout(() => {
        fail('Transfer timed out');
      }, this.ackTimeoutMs);

      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          peer.send(JSON.stringify({ type: 'error', message }));
        } catch {
          /* receiver may already be gone — nothing left to do */
        }
        reject(new Error(message));
      };

      peer.onMessage(async (text) => {
        if (settled) return;
        const msg = parseTransferMessage(text);
        if (!msg) return;
        if (msg.type === 'error') {
          fail(msg.message);
          return;
        }

        if (phase === 'hello') {
          if (msg.type !== 'hello') return fail('Expected a hello message from the sender');
          if (msg.app !== TRANSFER_APP_TAG || msg.protocol !== TRANSFER_PROTOCOL_VERSION) {
            return fail('Incompatible EverydayFuel peer');
          }
          phase = 'meta';
          return;
        }

        if (phase === 'meta') {
          if (msg.type !== 'meta') return fail('Expected transfer metadata');
          if (msg.size > this.maxPayloadChars) return fail('Transfer payload too large');
          meta = { name: msg.name, size: msg.size, sha256: msg.sha256, chunks: msg.chunks };
          phase = 'data';
          return;
        }

        if (phase === 'data') {
          if (msg.type !== 'data') return fail('Expected a data chunk');
          if (meta && msg.seq !== chunks.length) return fail('Data chunk out of order');
          chunks.push(msg.data);
          receivedBytes += msg.data.length;
          onProgress?.({ receivedBytes, totalBytes: meta?.size ?? 0 });
          if (meta && chunks.length === meta.chunks) phase = 'done';
          return;
        }

        if (msg.type !== 'done') return fail('Expected transfer completion');

        const payload = reassembleChunks(chunks);
        if (!meta) return fail('Transfer metadata missing');
        if (payload.length !== meta.size) return fail('Payload size mismatch');
        const digest = await sha256Hex(payload);
        if (digest !== meta.sha256) return fail('Payload checksum mismatch');

        settled = true;
        clearTimeout(timer);
        try {
          peer.send(JSON.stringify({ type: 'ok' }));
        } catch {
          /* ignore */
        }
        resolve({ name: meta.name, payload });
      });

      peer.onClose(() => {
        if (!settled) fail('Connection closed before the transfer completed');
      });
    });
  }
}

function waitForOpen(peer: TransferPeer, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Connection did not open in time'));
    }, timeoutMs);
    peer.onOpen(() => {
      clearTimeout(timer);
      resolve();
    });
    peer.onClose(() => {
      clearTimeout(timer);
      reject(new Error('Connection closed before opening'));
    });
  });
}

function waitForAck(peer: TransferPeer, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Transfer timed out waiting for the peer'));
    }, timeoutMs);
    peer.onMessage((text) => {
      const msg = parseTransferMessage(text);
      if (!msg) return;
      if (msg.type === 'ok') {
        clearTimeout(timer);
        resolve();
      } else if (msg.type === 'error') {
        clearTimeout(timer);
        reject(new Error(msg.message));
      }
    });
    peer.onClose(() => {
      clearTimeout(timer);
      reject(new Error('Connection closed before the peer acknowledged the transfer'));
    });
  });
}