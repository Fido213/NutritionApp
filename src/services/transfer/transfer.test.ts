import { describe, it, expect, vi, afterEach } from 'vitest';
import { P2PTransferService, TransferProgress, ReceivedTransfer } from './transfer';
import { TransferPeer, TransferTransport } from './transport';
import {
  encodePairingCode,
  parsePairingCode,
  parseTransferMessage,
  chunkPayload,
  reassembleChunks,
  sha256Hex,
  TRANSFER_APP_TAG,
  TRANSFER_PROTOCOL_VERSION
} from './protocol';
import { createBackupArchive, parseBackupArchive, validateBackupArchive } from '../backup/backup';
import { encryptBackup, decryptBackup } from '../backup/encryption';

const FAST_ITERATIONS = 1_000;

// ---------------------------------------------------------------------------
// In-memory stub transport: two FakePeers wired together, queueing messages
// until a handler is attached (mirrors the WebRTC peer wrapper semantics).
// ---------------------------------------------------------------------------

class FakePeer implements TransferPeer {
  private messageCallbacks: ((data: string) => void)[] = [];
  private openCallbacks: (() => void)[] = [];
  private closeCallbacks: (() => void)[] = [];
  private buffer: string[] = [];
  private other: FakePeer | null = null;
  private opened = false;
  private closed = false;

  constructor(other: FakePeer | null = null) {
    this.other = other;
  }

  setOther(peer: FakePeer) {
    this.other = peer;
  }

  send(data: string): boolean {
    if (this.closed || !this.other) return false;
    queueMicrotask(() => this.other!.deliver(data));
    return true;
  }

  deliver(data: string) {
    if (this.closed) return;
    if (this.messageCallbacks.length > 0) {
      for (const cb of this.messageCallbacks) cb(data);
    } else {
      this.buffer.push(data);
    }
  }

  openNow() {
    if (this.opened || this.closed) return;
    this.opened = true;
    for (const cb of this.openCallbacks) cb();
  }

  onMessage(cb: (data: string) => void): void {
    this.messageCallbacks.push(cb);
    if (this.buffer.length) {
      const pending = this.buffer.splice(0);
      for (const data of pending) cb(data);
    }
  }

  onOpen(cb: () => void): void {
    if (this.opened) {
      queueMicrotask(cb);
      return;
    }
    this.openCallbacks.push(cb);
  }

  onClose(cb: () => void): void {
    if (this.closed) {
      queueMicrotask(cb);
      return;
    }
    this.closeCallbacks.push(cb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.closeCallbacks) cb();
    if (this.other) this.other.close();
  }
}

class FakeTransport implements TransferTransport {
  private pendingReceiver: FakePeer | null = null;

  async createPairingCode(): Promise<string> {
    this.pendingReceiver = new FakePeer();
    return encodePairingCode('v=0\r\no=offer 1 1 IN IP4 0.0.0.0\r\n');
  }

  async acceptConnection(answerCode: string): Promise<TransferPeer> {
    const code = parsePairingCode(answerCode);
    if (!code) throw new Error('Invalid answer code');
    const receiver = this.pendingReceiver;
    if (!receiver) throw new Error('No pending transfer — generate a pairing code first');
    this.pendingReceiver = null;
    queueMicrotask(() => receiver.openNow());
    return receiver;
  }

  async connect(pairingCode: string): Promise<{ peer: TransferPeer; answerCode: string }> {
    const code = parsePairingCode(pairingCode);
    if (!code) throw new Error('Invalid pairing code');
    const receiver = this.pendingReceiver;
    if (!receiver) throw new Error('No receiver waiting');
    const sender = new FakePeer(receiver);
    receiver.setOther(sender);
    queueMicrotask(() => sender.openNow());
    return { peer: sender, answerCode: encodePairingCode('v=0\r\no=answer 1 1 IN IP4 0.0.0.0\r\n') };
  }

  dispose(): void {
    this.pendingReceiver = null;
  }
}

function makeServices() {
  const transport = new FakeTransport();
  return {
    receiver: new P2PTransferService(transport),
    sender: new P2PTransferService(transport),
    transport
  };
}

function sampleArchiveJson(): string {
  return createBackupArchive({
    foods: [{
      id: 'f1', canonical_name: 'Chicken Breast', normalized_name: 'chickenbreast',
      calories_per_100g: 165, protein_per_100g: 31, carbs_per_100g: 0, fat_per_100g: 3.6,
      water_per_100g: 65, nutrition_basis: 'per_100g', source_type: 'user_entered',
      source_reference: null, confidence: 1, created_at: '2026-08-19T00:00:00.000Z', updated_at: '2026-08-19T00:00:00.000Z'
    }],
    food_logs: [{
      id: 'l1', date: '2026-08-19', food_id: 'f1', observation_id: null,
      amount_g: 250, amount_ml: null, calories: 412.5, protein_g: 77.5, carbs_g: 0, fat_g: 9,
      water_ml: 162.5, note: null, created_at: '2026-08-19T00:00:00.000Z'
    }]
  });
}

async function wirePair(services: ReturnType<typeof makeServices>): Promise<{ senderPeer: TransferPeer; receiverPeer: TransferPeer }> {
  const pairingCode = await services.receiver.createPairingCode();
  const { peer: senderPeer, answerCode } = await services.sender.connect(pairingCode);
  const receiverPeer = await services.receiver.acceptConnection(answerCode);
  return { senderPeer, receiverPeer };
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('pairing codes', () => {
  it('round-trips an SDP through encode/parse', () => {
    const sdp = 'v=0\r\no=- 123 2 IN IP4 10.0.0.5\r\ns=everydayfuel\r\n';
    const parsed = parsePairingCode(encodePairingCode(sdp));
    expect(parsed).not.toBeNull();
    expect(parsed!.app).toBe(TRANSFER_APP_TAG);
    expect(parsed!.version).toBe(TRANSFER_PROTOCOL_VERSION);
    expect(parsed!.sdp).toBe(sdp);
  });

  it('rejects garbage, foreign apps, wrong versions and empty SDP', () => {
    expect(parsePairingCode('not json {{{')).toBeNull();
    expect(parsePairingCode('')).toBeNull();
    expect(parsePairingCode(JSON.stringify({ app: 'OtherApp', v: 1, sdp: 'x' }))).toBeNull();
    expect(parsePairingCode(JSON.stringify({ app: TRANSFER_APP_TAG, v: 99, sdp: 'x' }))).toBeNull();
    expect(parsePairingCode(JSON.stringify({ app: TRANSFER_APP_TAG, v: 1, sdp: '' }))).toBeNull();
    expect(parsePairingCode(JSON.stringify({ app: TRANSFER_APP_TAG, v: 1 }))).toBeNull();
  });
});

describe('transfer messages', () => {
  it('parses every documented message shape', () => {
    expect(parseTransferMessage(JSON.stringify({ type: 'hello', app: TRANSFER_APP_TAG, protocol: 1 }))).toEqual({
      type: 'hello', app: TRANSFER_APP_TAG, protocol: 1
    });
    expect(parseTransferMessage(JSON.stringify({ type: 'meta', name: 'a.json', size: 10, sha256: 'a'.repeat(64), chunks: 2 }))).toEqual({
      type: 'meta', name: 'a.json', size: 10, sha256: 'a'.repeat(64), chunks: 2
    });
    expect(parseTransferMessage(JSON.stringify({ type: 'data', seq: 0, data: 'abc' }))).toEqual({ type: 'data', seq: 0, data: 'abc' });
    expect(parseTransferMessage(JSON.stringify({ type: 'done' }))).toEqual({ type: 'done' });
    expect(parseTransferMessage(JSON.stringify({ type: 'ok' }))).toEqual({ type: 'ok' });
    expect(parseTransferMessage(JSON.stringify({ type: 'error', message: 'boom' }))).toEqual({ type: 'error', message: 'boom' });
  });

  it('rejects garbage, unknown types and malformed fields', () => {
    expect(parseTransferMessage('not json {{{')).toBeNull();
    expect(parseTransferMessage('')).toBeNull();
    expect(parseTransferMessage(JSON.stringify({ type: 'nope' }))).toBeNull();
    expect(parseTransferMessage(JSON.stringify({ type: 'hello', app: 123, protocol: 1 }))).toBeNull();
    expect(parseTransferMessage(JSON.stringify({ type: 'meta', name: 'a', size: -1, sha256: 'x', chunks: 1 }))).toBeNull();
    expect(parseTransferMessage(JSON.stringify({ type: 'meta', name: 'a', size: 1, sha256: 'short', chunks: 1 }))).toBeNull();
    expect(parseTransferMessage(JSON.stringify({ type: 'data', seq: 0, data: 5 }))).toBeNull();
    expect(parseTransferMessage(JSON.stringify({ type: 'error' }))).toBeNull();
  });
});

describe('chunking', () => {
  it('splits and reassembles a payload exactly', () => {
    const payload = 'x'.repeat(50_000) + 'end';
    const chunks = chunkPayload(payload, 8192);
    expect(chunks.length).toBe(Math.ceil(payload.length / 8192));
    expect(reassembleChunks(chunks)).toBe(payload);
  });

  it('handles a payload smaller than one chunk', () => {
    const chunks = chunkPayload('tiny', 8192);
    expect(chunks).toEqual(['tiny']);
    expect(reassembleChunks(chunks)).toBe('tiny');
  });

  it('rejects a non-positive chunk size', () => {
    expect(() => chunkPayload('x', 0)).toThrow();
  });
});

describe('sha256Hex', () => {
  it('matches the known SHA-256 of "abc"', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('P2P encrypted backup transfer (end to end)', () => {
  it('moves an encrypted archive between two services byte-for-byte', async () => {
    const services = makeServices();
    const { senderPeer, receiverPeer } = await wirePair(services);

    const archiveJson = sampleArchiveJson();
    const encrypted = await encryptBackup(archiveJson, 'peer-pass', FAST_ITERATIONS);

    const progress: TransferProgress[] = [];
    const receivePromise = services.receiver.receiveBackup(receiverPeer, p => progress.push(p));
    const sendPromise = services.sender.sendBackup(senderPeer, encrypted, 'EverydayFuel_Backup.json', p => progress.push(p));

    const received = await receivePromise;
    await sendPromise;

    expect(received.name).toBe('EverydayFuel_Backup.json');
    expect(received.payload).toBe(encrypted);

    // Both sides reported the full payload length as progress
    expect(progress.some(p => p.receivedBytes === encrypted.length && p.totalBytes === encrypted.length)).toBe(true);

    // The receiver can decrypt with the shared password and validate the archive
    const decrypted = await decryptBackup(received.payload, 'peer-pass');
    expect(decrypted).toBe(archiveJson);
    const archive = parseBackupArchive(decrypted!);
    expect(archive).not.toBeNull();
    expect(validateBackupArchive(archive)).toEqual([]);
  });

  it('streams a payload larger than one chunk across the wire', async () => {
    const services = makeServices();
    const { senderPeer, receiverPeer } = await wirePair(services);

    const bigArchive = createBackupArchive({
      foods: Array.from({ length: 300 }, (_, i) => ({
        id: `f${i}`, canonical_name: `Food number ${i} with a long name to inflate the payload`, normalized_name: `foodnumber${i}`,
        calories_per_100g: i, protein_per_100g: i, carbs_per_100g: i, fat_per_100g: i,
        water_per_100g: i, nutrition_basis: 'per_100g', source_type: 'user_entered',
        source_reference: null, confidence: 1, created_at: '2026-08-19T00:00:00.000Z', updated_at: '2026-08-19T00:00:00.000Z'
      }))
    });

    const receivePromise = services.receiver.receiveBackup(receiverPeer);
    const sendPromise = services.sender.sendBackup(senderPeer, bigArchive, 'big.json');
    const [received] = await Promise.all([receivePromise, sendPromise]);

    expect(received.payload).toBe(bigArchive);
  });

  it('rejects when the channel never opens (sender timeout)', async () => {
    vi.useFakeTimers();
    const services = makeServices();
    const neverOpenedPeer = new FakePeer();

    const sendPromise = services.sender.sendBackup(neverOpenedPeer, 'payload', 'x.json');
    const assertion = expect(sendPromise).rejects.toThrow('Connection did not open in time');
    await vi.advanceTimersByTimeAsync(300_000);
    await assertion;
  });

  it('rejects when the receiver gets a payload whose checksum does not match', async () => {
    const services = makeServices();
    const { senderPeer, receiverPeer } = await wirePair(services);

    // A broken/malicious sender advertises one checksum but sends other data.
    const payload = 'data-to-be-sent';
    const chunks = chunkPayload(payload);
    const wrongDigest = await sha256Hex('different-data');

    senderPeer.send(JSON.stringify({ type: 'hello', app: TRANSFER_APP_TAG, protocol: TRANSFER_PROTOCOL_VERSION }));
    senderPeer.send(JSON.stringify({ type: 'meta', name: 'evil.json', size: payload.length, sha256: wrongDigest, chunks: chunks.length }));
    chunks.forEach((data, seq) => senderPeer.send(JSON.stringify({ type: 'data', seq, data })));
    senderPeer.send(JSON.stringify({ type: 'done' }));

    await expect(services.receiver.receiveBackup(receiverPeer)).rejects.toThrow('Payload checksum mismatch');
  });

  it('rejects a peer from a different app/protocol at hello', async () => {
    const services = makeServices();
    const { senderPeer, receiverPeer } = await wirePair(services);

    senderPeer.send(JSON.stringify({ type: 'hello', app: 'SomeOtherApp', protocol: 1 }));

    await expect(services.receiver.receiveBackup(receiverPeer)).rejects.toThrow('Incompatible EverydayFuel peer');
  });

  it('rejects when the sender closes before finishing', async () => {
    const services = makeServices();
    const { senderPeer, receiverPeer } = await wirePair(services);

    senderPeer.send(JSON.stringify({ type: 'hello', app: TRANSFER_APP_TAG, protocol: TRANSFER_PROTOCOL_VERSION }));
    const receivePromise = services.receiver.receiveBackup(receiverPeer);
    queueMicrotask(() => senderPeer.close());

    await expect(receivePromise).rejects.toThrow('Connection closed before the transfer completed');
  });

  it('surfaces the receiver error back to the sender', async () => {
    const services = makeServices();
    const { senderPeer, receiverPeer } = await wirePair(services);

    const sendPromise = services.sender.sendBackup(senderPeer, 'payload', 'x.json');
    queueMicrotask(() => receiverPeer.send(JSON.stringify({ type: 'error', message: 'rejected by peer' })));

    await expect(sendPromise).rejects.toThrow('rejected by peer');
  });

  it('rejects an empty payload before touching the wire', async () => {
    const services = makeServices();
    const { senderPeer } = await wirePair(services);
    await expect(services.sender.sendBackup(senderPeer, '', 'x.json')).rejects.toThrow('Nothing to send');
  });

  it('rejects a payload over the configured size guard', async () => {
    const transport = new FakeTransport();
    const guarded = new P2PTransferService(transport, { maxPayloadChars: 10 });
    const { senderPeer } = await wirePair({ receiver: new P2PTransferService(transport), sender: guarded, transport });
    await expect(guarded.sendBackup(senderPeer, 'x'.repeat(11), 'x.json')).rejects.toThrow('Transfer payload too large');
  });

  it('rejects an oversized meta from the wire (receiver side)', async () => {
    const transport = new FakeTransport();
    const guarded = new P2PTransferService(transport, { maxPayloadChars: 10 });
    const { senderPeer, receiverPeer } = await wirePair({ receiver: guarded, sender: new P2PTransferService(transport), transport });

    senderPeer.send(JSON.stringify({ type: 'hello', app: TRANSFER_APP_TAG, protocol: TRANSFER_PROTOCOL_VERSION }));
    senderPeer.send(JSON.stringify({ type: 'meta', name: 'big.json', size: 999, sha256: 'a'.repeat(64), chunks: 1 }));

    await expect(guarded.receiveBackup(receiverPeer)).rejects.toThrow('Transfer payload too large');
  });
});

describe('ReceivedTransfer', () => {
  it('carries the name and byte-identical payload', async () => {
    const services = makeServices();
    const { senderPeer, receiverPeer } = await wirePair(services);

    const transfer: Promise<ReceivedTransfer> = services.receiver.receiveBackup(receiverPeer);
    const sendPromise = services.sender.sendBackup(senderPeer, 'abc', 'n.json');
    const result = await transfer;
    await sendPromise;

    expect(result.name).toBe('n.json');
    expect(result.payload).toBe('abc');
  });
});