import type { UpdateOrderInput } from '../types/common.js';

const EDITABLE_ORDER_FIELDS = new Set([
  'price',
  'amount',
  'minTradeAmount',
  'maxTradeAmount',
  'paymentMethods',
  'timeLimit',
  'terms',
  'autoReply',
]);

export function buildOrderUpdateRequest(basePath: string, patch: UpdateOrderInput): {
  method: 'POST' | 'PATCH';
  path: string;
  body: Record<string, unknown>;
} {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('orders.update: patch must be an object');
  }

  const runtimePatch = patch as Record<string, unknown>;
  const keys = Object.keys(runtimePatch);
  if (keys.length === 0) {
    throw new Error('orders.update: at least one field is required');
  }

  if (Object.prototype.hasOwnProperty.call(runtimePatch, 'status')) {
    if (keys.length !== 1) {
      throw new Error('orders.update: status transitions cannot be combined with field edits');
    }
    const status = runtimePatch.status;
    if (status !== 'active' && status !== 'paused') {
      throw new Error('orders.update: status must be active or paused');
    }
    return {
      method: 'POST',
      path: `${basePath}/${status === 'paused' ? 'pause' : 'reactivate'}`,
      body: {},
    };
  }

  const unknownField = keys.find((key) => !EDITABLE_ORDER_FIELDS.has(key));
  if (unknownField) {
    throw new Error(`orders.update: unsupported field ${unknownField}`);
  }

  return { method: 'PATCH', path: basePath, body: runtimePatch };
}
