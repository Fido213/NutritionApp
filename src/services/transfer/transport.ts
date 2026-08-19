/**
 * Transport abstraction for EverydayFuel P2P transfer (spec §23).
 *
 * The service layer (transfer.ts) talks to this interface only, so the
 * WebRTC adapter can be swapped or stubbed in tests. A TransferPeer wraps
 * one data channel; message delivery is ordered and reliable.
 *
 * The pairing flow has two roles:
 *   - receiver (host): createPairingCode() produces the offer code, then
 *     acceptConnection(answerCode) completes the pairing and yields the peer;
 *   - sender (peer): connect(pairingCode) consumes the offer, produces the
 *     answer code (shown back to the receiver) and yields the peer once the
 *     channel is available (it may still be opening — onOpen fires later).
 */

export interface TransferPeer {
  /** Queue/send a string over the channel. Returns false when closed. */
  send(data: string): boolean;
  /** Register a message handler (messages received earlier are delivered). */
  onMessage(cb: (data: string) => void): void;
  /** Register an open handler; fires immediately if already open. */
  onOpen(cb: () => void): void;
  /** Register a close handler; fires immediately if already closed. */
  onClose(cb: () => void): void;
  /** Close the channel. Safe to call more than once. */
  close(): void;
}

export interface TransferTransport {
  /** Receiver: build the offer pairing code. */
  createPairingCode(): Promise<string>;
  /** Receiver: apply the sender's answer code and resolve once connected. */
  acceptConnection(answerCode: string): Promise<TransferPeer>;
  /**
   * Sender: consume the receiver's offer. Resolves with the peer (the data
   * channel may still be opening) and the answer code to show back.
   */
  connect(pairingCode: string): Promise<{ peer: TransferPeer; answerCode: string }>;
  /** Abort any pending connection and release resources. */
  dispose(): void;
}