// Payment methods resource. /api/v1/merchant/payment-methods.
// Returns the merchant's verified payment methods with account numbers
// already masked server-side.

import type { HttpTransport } from '../transport/httpTransport.js';
import type { PaymentMethod, RequestOptions } from '../types/common.js';

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
   * @throws AuthenticationError when the API key lacks `payment_methods:read`.
   * @example
   * const methods = await client.paymentMethods.list();
   * methods.forEach(m => console.log(m.id, m.type, m.maskedAccount));
   */
  async list(opts: RequestOptions = {}): Promise<PaymentMethod[]> {
    const envelope = await this.http.request<{ methods: PaymentMethod[] }>(
      { method: 'GET', path: `${BASE}/payment-methods` },
      opts
    );
    return Array.isArray(envelope?.methods) ? envelope.methods : [];
  }
}
