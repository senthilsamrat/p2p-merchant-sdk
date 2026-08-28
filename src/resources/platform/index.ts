// Platform namespace wires the SaaS-tier resources onto the MerchantClient.
// Exposed as `client.platform.users` and `client.platform.revshare`.
//
// `client.platform.users` is callable in two shapes:
//   client.platform.users.create({...})            // resource methods
//   client.platform.users('user_abc').wallet.get() // scoped sub-client
// The dual surface mirrors Stripe's `stripe.customers(id)` pattern. We
// implement it by attaching the resource methods onto a function value.
//
// SaaS-Onboarding endpoints (apply, branding, billing, custom domain) live
// under /api/merchants/saas/* and are JWT-authenticated. Those routes are
// invoked from the merchant web dashboard and are intentionally NOT bridged
// into the SDK because the SDK only carries HMAC credentials. SaaS platforms
// that need application-lifecycle visibility should subscribe to the
// merchant.saas.* webhook events; revshare data flows through the
// `client.platform.revshare` resource which IS HMAC-authenticated.

import type { HttpTransport } from '../../transport/httpTransport.js';
import { PlatformUsersResource, UserScopedClient } from './users.js';
import { RevshareResource } from './revshare.js';
import { PlatformWalletResource } from './wallet.js';
import { PlatformQuickTradeResource } from './quickTrade.js';

// Callable surface for client.platform.users. Acts as a function returning a
// UserScopedClient AND exposes all PlatformUsersResource methods directly.
export interface CallablePlatformUsers extends PlatformUsersResource {
  (userId: string): UserScopedClient;
}

export class PlatformNamespace {
  public readonly users: CallablePlatformUsers;
  public readonly revshare: RevshareResource;
  // Platform-owner wallet operations. Distinct from the per-end-user wallet
  // (UserScopedClient.wallet) and the top-level merchant wallet. Houses the
  // dedicated audit-tagged fund-user transfer.
  public readonly wallet: PlatformWalletResource;
  // SaaS quick-trade browsing endpoints. Merchant-scope reads (pairs,
  // featured merchants, recent activity, platform stats) so SaaS portals
  // can render market data via their HMAC key without an end-user JWT.
  public readonly quickTrade: PlatformQuickTradeResource;

  constructor(transport: HttpTransport) {
    const resource = new PlatformUsersResource(transport);
    this.users = makeCallableUsers(resource);
    this.revshare = new RevshareResource(transport);
    this.wallet = new PlatformWalletResource(transport);
    this.quickTrade = new PlatformQuickTradeResource(transport);
  }
}

// Build a function that delegates to PlatformUsersResource.user(uid) and
// inherits every prototype method/property from the resource. The returned
// callable behaves indistinguishably from the resource for `.create`,
// `.list`, `.listAll` and is callable as `users(uid)` for the scoped path.
function makeCallableUsers(resource: PlatformUsersResource): CallablePlatformUsers {
  const callable = ((userId: string): UserScopedClient => resource.user(userId)) as CallablePlatformUsers;
  // Bind prototype methods so the underlying resource's `this` resolves
  // correctly through the function. Includes both own and inherited keys.
  const proto = Object.getPrototypeOf(resource) as object;
  for (const key of Object.getOwnPropertyNames(proto)) {
    if (key === 'constructor') continue;
    const value = (resource as unknown as Record<string, unknown>)[key];
    if (typeof value === 'function') {
      (callable as unknown as Record<string, unknown>)[key] = (value as (...args: unknown[]) => unknown).bind(resource);
    }
  }
  // Forward own-property fields too (none today, but future-proof against
  // resources that hold per-instance state on `this`).
  for (const key of Object.getOwnPropertyNames(resource)) {
    if (!(key in callable)) {
      (callable as unknown as Record<string, unknown>)[key] = (resource as unknown as Record<string, unknown>)[key];
    }
  }
  return callable;
}

export { PlatformUsersResource, UserScopedClient } from './users.js';
export {
  ScopedOrdersResource,
  ScopedTradesResource,
  ScopedWalletResource,
  ScopedPaymentMethodsResource,
  ScopedKycResource,
  ScopedMarketplaceResource,
  ScopedMarketResource
} from './users.js';
export { RevshareResource } from './revshare.js';
export { PlatformWalletResource } from './wallet.js';
export {
  PlatformQuickTradeResource,
  ScopedQuickTradeResource
} from './quickTrade.js';
export type * from './types.js';
