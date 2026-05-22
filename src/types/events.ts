// Discriminated union of webhook event payloads delivered to the merchant
// webhook endpoint. Mirrors the OpenAPI WebhookEnvelope schema.

export interface WebhookEnvelope<TPayload = unknown> {
  id: string;
  type: WebhookEventType;
  createdAt: string;
  apiVersion: string;
  data: TPayload;
}

export type WebhookEventType =
  | 'merchant.order.created'
  | 'merchant.order.cancelled'
  | 'merchant.order.updated'
  | 'merchant.trade.matched'
  | 'merchant.trade.payment_sent'
  | 'merchant.trade.completed'
  | 'merchant.trade.cancelled'
  | 'merchant.trade.disputed'
  | 'merchant.trade.dispute_resolved'
  | 'merchant.trade.message_received'
  | 'merchant.payment.received'
  | 'merchant.subscription.renewed'
  | 'merchant.subscription.expired'
  | 'merchant.profit_sharing.commission.earned'
  | 'merchant.profit_sharing.commission.clawed_back'
  | 'merchant.profit_sharing.payout.completed'
  | 'merchant.profit_sharing.payout.failed'
  | 'merchant.profit_sharing.distribution.change_approved'
  | 'merchant.profit_sharing.distribution.change_rejected'
  | 'merchant.profit_sharing.reconciliation.discrepancy'
  // SaaS application + subscription lifecycle. Emitted from the
  // SaaS-Onboarding control plane; surfaced here so SDK webhook consumers
  // can branch on the discriminator.
  | 'merchant.saas.application.submitted'
  | 'merchant.saas.application.kyb_in_progress'
  | 'merchant.saas.application.kyb_completed'
  | 'merchant.saas.application.review_stalled'
  | 'merchant.saas.application.approved'
  | 'merchant.saas.application.rejected'
  | 'merchant.saas.subscription.activated'
  | 'merchant.saas.subscription.upgraded'
  | 'merchant.saas.subscription.downgraded'
  | 'merchant.saas.subscription.payment_failed'
  | 'merchant.saas.subscription.suspended'
  | 'merchant.saas.subscription.reinstated'
  | 'merchant.saas.subscription.cancelled'
  | 'merchant.saas.config.updated'
  | 'merchant.saas.config.change_approved'
  | 'merchant.saas.config.change_rejected'
  | 'merchant.saas.branding.updated'
  | 'merchant.saas.custom_domain.verification_started'
  | 'merchant.saas.custom_domain.verified'
  | 'merchant.saas.custom_domain.failed'
  | 'merchant.saas.custom_domain.reverification_failed'
  // Platform end-user lifecycle.
  | 'merchant.user.created'
  | 'merchant.user.kyc_updated'
  | 'merchant.user.suspended'
  | 'merchant.user.restored'
  // Platform-controlled marketplace publishing toggle. Fires on every
  // PATCH that changes publishEnabled. payload = PlatformMarketplaceToggledPayload.
  | 'merchant.platform.user.marketplace.toggled'
  // Platform owner -> end-user fund-user transfer succeeded. Carries the
  // immutable audit row id; full audit detail is admin-only.
  | 'merchant.platform.wallet.user_funded'
  // AML structuring detector tripped on a fund-user call. Fires regardless
  // of which fund-user error code was returned (the rate-limit codes are
  // surfaced in payload.recentCallCount/windowSeconds for triage).
  | 'merchant.platform.wallet.fund_user.aml_flagged'
  // Revshare. Mirrors the adapted payload set with parentMerchantId.
  | 'merchant.revshare.payout.completed'
  | 'merchant.revshare.payout.failed'
  | 'merchant.revshare.commission.earned'
  | 'merchant.revshare.commission.clawed_back'
  | 'merchant.revshare.proposal.approved'
  | 'merchant.revshare.proposal.rejected'
  | 'merchant.revshare.proposal.expired'
  | 'merchant.revshare.reconciliation.discrepancy';

// Common payload shape attached to every envelope. Resource-specific fields
// are typed where stable enough to commit. Consumers can narrow via the
// envelope `type` discriminator.
export interface OrderEventPayload {
  orderId: string;
  merchantId: string;
  type: 'buy' | 'sell';
  cryptocurrency: string;
  fiatCurrency: string;
  amount: string;
  price: string;
}

export interface TradeEventPayload {
  tradeId: string;
  orderId: string;
  merchantId: string;
  buyerId: string;
  sellerId: string;
  cryptocurrency: string;
  fiatCurrency: string;
  amount: string;
  price: string;
  status: string;
}

export interface MessageEventPayload {
  tradeId: string;
  messageId: string;
  senderId: string;
  content: string;
}

export interface PaymentEventPayload {
  paymentId: string;
  amount: string;
  currency: string;
  status: string;
}

export interface ProfitSharingPayload {
  commissionId?: string;
  payoutId?: string;
  proposalId?: string;
  amount?: string;
  currency?: string;
  reason?: string;
}

// Platform end-user webhook payload. Carried under merchant.user.* events.
export interface PlatformUserEventPayload {
  userId: string;
  parentMerchantId: string;
  externalUserId?: string;
  status?: 'active' | 'suspended' | 'inactive';
  kycLevel?: number;
  kycStatus?: string;
  reason?: string;
}

// SaaS application + subscription webhook payload.
export interface SaasApplicationEventPayload {
  merchantId: string;
  applicationId?: string;
  status?: string;
  reason?: string;
  rejectionReason?: string;
}

export interface SaasSubscriptionEventPayload {
  merchantId: string;
  subscriptionId?: string;
  plan?: string;
  previousPlan?: string;
  reason?: string;
  scheduledFor?: string;
}

export interface SaasConfigEventPayload {
  merchantId: string;
  configId?: string;
  proposalId?: string;
  version?: number;
  changedBy?: string;
}

export interface SaasCustomDomainEventPayload {
  merchantId: string;
  domain: string;
  status?: string;
  reason?: string;
  verifiedAt?: string;
}

// Revshare webhook payload. Carries parentMerchantId so SaaS platforms can
// route deliveries through their own user-facing dashboards.
export interface RevshareEventPayload {
  merchantId: string;
  parentMerchantId?: string;
  payoutId?: string;
  rewardId?: string;
  proposalId?: string;
  amount?: string;
  currency?: string;
  reason?: string;
}

// Per-user marketplace publishing toggle event. Fires on every PATCH that
// changes publishEnabled, including disable() (publishEnabled=false). The
// reason field is populated only on disable() when the platform supplied a
// rationale (UI feedback, automated guardrail, etc).
export interface PlatformMarketplaceToggledPayload {
  userId: string;
  parentMerchantId: string;
  publishEnabled: boolean;
  // ISO timestamp of the enable() that took effect, or the most recent
  // historical enable when the new state is publishEnabled=false. null when
  // the user has never been published.
  publishedAt: string | null;
  reason?: string;
}

// Platform owner -> end-user fund transfer succeeded. The event carries
// only summary fields safe for the tenant; full audit detail (who, IP,
// 2FA proof, AML bucket counts) is admin-only and reachable via the
// /admin/saas/wallet/fund-user/audit-trail endpoint with the auditId.
export interface PlatformWalletUserFundedPayload {
  toUserId: string;
  parentMerchantId: string;
  amount: string;
  currency: string;
  source: 'bonus' | 'refund' | 'affiliate' | 'other';
  transferId: string;
  auditId: string;
  linkedTradeId?: string;
  occurredAt: string;
}

// AML structuring detector tripped. The event fires whether or not the
// underlying call was rate-limited; recentCallCount + windowSeconds let
// integrators correlate with their own monitoring.
export interface PlatformWalletFundUserAmlFlaggedPayload {
  toUserId: string;
  parentMerchantId: string;
  source: 'bonus' | 'refund' | 'affiliate' | 'other';
  attemptedAmount: string;
  currency: string;
  // Number of fund-user calls to this recipient within windowSeconds.
  recentCallCount: number;
  // The Redis bucket window in seconds (4 buckets: 1m, 1h, 24h, 30d).
  windowSeconds: number;
  // Hash-chained immutable audit row id of the AML trip itself (not the
  // attempted transfer).
  auditId: string;
  occurredAt: string;
}
