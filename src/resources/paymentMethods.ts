// Payment methods resource. /api/v1/merchant/payment-methods.
// Returns the merchant's verified payment methods with account numbers
// already masked server-side.

import type { HttpTransport } from '../transport/httpTransport.js';
import type { PaymentMethod, RequestOptions } from '../types/common.js';
import { expectObject, normalizePaymentMethod } from '../utils/response.js';

const BASE = '/api/v1/merchant';

export class PaymentMethodsResource {
  constructor(private readonly http: HttpTransport) {}

  /**
   * Lists the merchant's verified payment methods.
   *
   * Account numbers are masked server-side; the SDK returns whatever the
   * server emits and never reconstructs the unmasked value.
   *
   * @param opts - Per-request transport overrides.
   * @returns Array of payment methods (empty when none are verified).
   * @throws PermissionDeniedError when the API key lacks `account:read`.
   * @example
   * const methods = await client.paymentMethods.list();
   * methods.forEach(m => console.log(m.id, m.methodType, m.maskedAccount));
   */
  async list(opts: RequestOptions = {}): Promise<PaymentMethod[]> {
    const response = await this.http.request<unknown>(
      { method: 'GET', path: `${BASE}/payment-methods` },
      opts
    );
    const envelope = expectObject(response, 'list payment methods response');
    if (!Array.isArray(envelope.methods)) {
      throw new Error('Invalid list payment methods response: expected methods array');
    }
    return envelope.methods.map((method, index) =>
      normalizePaymentMethod(method, `list payment methods response.methods[${index}]`)
    );
  }
}
