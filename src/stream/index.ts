// Public exports for the @plantmewallet/merchant-sdk/stream subpath.
// Callers who only want the WebSocket layer can import directly from here
// instead of pulling in the full MerchantClient (and its REST dependencies).

export {
  MerchantStream,
  ResumeUnavailableError,
  SequenceGapError,
} from './MerchantStream.js';
export { ResumeBuffer } from './resumeBuffer.js';
export { buildHandshakeHeaders } from './handshake.js';
export type { HandshakeHeaders, BuildHandshakeOptions } from './handshake.js';
export {
  STREAM_DEFAULTS,
  WS_PATH,
  type CloseReason,
  type DisconnectedInfo,
  type MerchantEvent,
  type MerchantEventType,
  type MerchantStreamConstructorOpts,
  type ReconnectingInfo,
  type ResumeUnavailable,
  type ServerDraining,
  type SessionInvalid,
  type SessionStart,
  type StreamOptions,
  type SystemFrame,
} from './types.js';
