/**
 * WebRTC DataChannel transport for EverydayFuel P2P transfer (spec §23).
 *
 * Thin adapter over the platform RTCPeerConnection API (available in the
 * Capacitor Android WebView and modern browsers; no server, no cloud —
 * host candidates connect directly on a shared local network/hotspot).
 *
 * Pairing is manual two-step signaling:
 *   1. receiver: createPairingCode()  -> offer code (shown as text/QR)
 *   2. sender:   connect(offerCode)   -> answer code (shown back)
 *   3. receiver: acceptConnection(answerCode) -> channel opens
 *
 * NOTE: this file cannot be exercised in the Node test environment (no
 * RTCPeerConnection). The message protocol it carries is fully covered by
 * transfer.test.ts via a stub transport; this adapter itself requires a
 * browser/device manual pass.
 */

import { TransferPeer, TransferTransport } from './transport';
import { encodePairingCode, parsePairingCode } from './protocol';

const CHANNEL_NAME = 'everydayfuel-p2p';
const OPEN_TIMEOUT_MS = 60_000;

/**
 * Public STUN servers let the peer resolve its public IP/mapping and the
 * mDNS (.local) candidates used by host candidates on some networks, which
 * fixes "ICE failed" pairing failures between devices on shared Wi-Fi.
 * No TURN is configured — payloads are never relayed through third parties;
 * host candidates still connect directly on a plain LAN/hotspot.
 */
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' }
];

function waitForIceGatheringComplete(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out gathering connection candidates'));
    }, timeoutMs);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

function waitForChannelOpen(channel: RTCDataChannel, timeoutMs: number): Promise<void> {
  if (channel.readyState === 'open') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out opening the transfer channel'));
    }, timeoutMs);
    channel.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    channel.addEventListener('close', () => {
      clearTimeout(timer);
      reject(new Error('Transfer channel closed'));
    });
    channel.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('Transfer channel error'));
    });
  });
}

/**
 * Wraps a data channel (which may still be opening) behind the TransferPeer
 * contract: sends are queued until the channel opens, and onOpen/onClose
 * fire immediately when the state is already known.
 */
class WebRTCPeer implements TransferPeer {
  private channel: RTCDataChannel | null = null;
  private open = false;
  private closed = false;
  private messageCallbacks: ((data: string) => void)[] = [];
  private openCallbacks: (() => void)[] = [];
  private closeCallbacks: (() => void)[] = [];
  private pendingSends: string[] = [];

  constructor(channelPromise: Promise<RTCDataChannel>) {
    channelPromise
      .then((channel) => {
        this.channel = channel;
        channel.addEventListener('message', (event) => {
          const data = typeof event.data === 'string' ? event.data : String(event.data);
          for (const cb of this.messageCallbacks) cb(data);
        });
        channel.addEventListener('close', () => this.handleClose());
        channel.addEventListener('error', () => this.handleClose());
        if (channel.readyState === 'open') {
          this.handleOpen();
        } else {
          channel.addEventListener('open', () => this.handleOpen());
        }
      })
      .catch(() => this.handleClose());
  }

  private handleOpen() {
    if (this.open || this.closed) return;
    this.open = true;
    if (this.pendingSends.length) {
      const queued = this.pendingSends.splice(0);
      for (const text of queued) this.send(text);
    }
    for (const cb of this.openCallbacks) cb();
  }

  private handleClose() {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.closeCallbacks) cb();
  }

  send(data: string): boolean {
    if (this.closed) return false;
    if (this.open && this.channel) {
      try {
        this.channel.send(data);
        return true;
      } catch {
        return false;
      }
    }
    this.pendingSends.push(data);
    return true;
  }

  onMessage(cb: (data: string) => void): void {
    this.messageCallbacks.push(cb);
  }

  onOpen(cb: () => void): void {
    if (this.open) {
      cb();
      return;
    }
    this.openCallbacks.push(cb);
  }

  onClose(cb: () => void): void {
    if (this.closed) {
      cb();
      return;
    }
    this.closeCallbacks.push(cb);
  }

  close(): void {
    if (this.channel) {
      try {
        this.channel.close();
      } catch {
        /* already closing */
      }
    } else {
      this.handleClose();
    }
  }
}

export class WebRTCTransport implements TransferTransport {
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private readonly iceServers: RTCIceServer[];

  constructor(iceServers: RTCIceServer[] = DEFAULT_ICE_SERVERS) {
    this.iceServers = iceServers;
  }

  async createPairingCode(): Promise<string> {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const channel = pc.createDataChannel(CHANNEL_NAME);
    this.pc = pc;
    this.channel = channel;

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(pc, OPEN_TIMEOUT_MS);

    const sdp = pc.localDescription?.sdp;
    if (!sdp) throw new Error('Could not build a pairing code');
    return encodePairingCode(sdp);
  }

  async acceptConnection(answerCode: string): Promise<TransferPeer> {
    const code = parsePairingCode(answerCode);
    if (!code) throw new Error('Invalid answer code');

    const pc = this.pc;
    const channel = this.channel;
    if (!pc || !channel) throw new Error('No pending transfer — generate a pairing code first');

    await pc.setRemoteDescription({ type: 'answer', sdp: code.sdp });
    await waitForChannelOpen(channel, OPEN_TIMEOUT_MS);
    return new WebRTCPeer(Promise.resolve(channel));
  }

  async connect(pairingCode: string): Promise<{ peer: TransferPeer; answerCode: string }> {
    const code = parsePairingCode(pairingCode);
    if (!code) throw new Error('Invalid pairing code');

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc = pc;

    await pc.setRemoteDescription({ type: 'offer', sdp: code.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGatheringComplete(pc, OPEN_TIMEOUT_MS);

    const sdp = pc.localDescription?.sdp;
    if (!sdp) throw new Error('Could not build an answer code');
    const answerCode = encodePairingCode(sdp);

    const channelPromise = new Promise<RTCDataChannel>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timed out waiting for the peer to accept'));
      }, OPEN_TIMEOUT_MS);
      pc.addEventListener('datachannel', (event) => {
        clearTimeout(timer);
        resolve(event.channel);
      });
    });

    return { peer: new WebRTCPeer(channelPromise), answerCode };
  }

  dispose(): void {
    if (this.channel) {
      try {
        this.channel.close();
      } catch {
        /* ignore */
      }
    }
    if (this.pc) {
      try {
        this.pc.close();
      } catch {
        /* ignore */
      }
    }
    this.channel = null;
    this.pc = null;
  }
}