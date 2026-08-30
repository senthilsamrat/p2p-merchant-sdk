import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { MerchantClient } from '../src/index.js';

afterEach(() => vi.restoreAllMocks());

function clientWithResponse(response: unknown) {
  const requests: any[] = [];
  vi.spyOn(axios, 'create').mockReturnValue({
    request: vi.fn(async (config: any) => {
      requests.push(config);
      return { status: 200, headers: {}, data: JSON.stringify(response) };
    }),
    get: vi.fn()
  } as any);
  const client = new MerchantClient({
    apiKey: 'pk_test_contract',
    hmacSecret: 'contract_secret',
    baseUrl: 'https://api.example.test',
    skipInitialClockSample: true
  });
  return { client, requests };
}

describe('revshare merchant-service contracts', () => {
  it('preserves each service collection envelope', async () => {
    const historyResponse = {
      versions: [{
        version: 2,
        contentHash: 'sha256:new',
        previousContentHash: 'sha256:old',
        effectiveFrom: '2026-08-01T00:00:00.000Z',
        effectiveTo: null,
        supersededBy: null,
        changeReason: 'rebalance',
        createdAt: '2026-07-31T00:00:00.000Z'
      }],
      hasMore: false,
      nextCursor: null
    };
    const history = clientWithResponse(historyResponse);
    await expect(history.client.platform.revshare.getConfigHistory()).resolves.toEqual(historyResponse);

    const proposalsResponse = {
      proposals: [{
        proposalId: 'proposal_1', status: 'pending', autoApplied: false,
        proposedAt: '2026-08-01T00:00:00.000Z', decidedAt: null, decidedBy: null,
        changeReason: 'rebalance', cumulativeDeltaBps: 100
      }],
      hasMore: true,
      nextCursor: 'proposal_1'
    };
    const proposals = clientWithResponse(proposalsResponse);
    await expect(proposals.client.platform.revshare.listProposals()).resolves.toEqual(proposalsResponse);

    const rewardsResponse = {
      rewards: [{
        rewardId: 'reward_1', tradeId: 'trade_1', escrowId: null,
        commissionAmount: '1.25', currency: 'USDT', status: 'completed',
        referrerId: 'ref_1', createdAt: '2026-08-01T00:00:00.000Z',
        completedAt: '2026-08-01T00:01:00.000Z', clawedBackAt: null
      }],
      hasMore: false,
      nextCursor: null
    };
    const rewards = clientWithResponse(rewardsResponse);
    await expect(rewards.client.platform.revshare.listRewards()).resolves.toEqual(rewardsResponse);

    const payoutsResponse = {
      payouts: [{
        payoutId: 'payout_1', amountUsdt: '25.00', currency: 'USDT',
        payoutTxHash: '0xabc', payoutAddressMasked: '********beef', status: 'completed',
        paidAt: '2026-08-02T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z'
      }],
      hasMore: false,
      nextCursor: null
    };
    const payouts = clientWithResponse(payoutsResponse);
    await expect(payouts.client.platform.revshare.listPayouts()).resolves.toEqual(payoutsResponse);
  });

  it('uses the service proposal schema and DELETE withdrawal route', async () => {
    const created = clientWithResponse({
      proposalId: 'proposal/1', status: 'pending', autoApplied: false,
      effectiveFrom: null, version: null
    });
    await created.client.platform.revshare.createProposal({
      referrers: [{ referrerId: 'ref_1', shareBps: 5000 }],
      commissionType: 'percentage',
      customMakerFeeBps: 30,
      commissionRateBps: 5000,
      changeReason: 'adjust partner distribution'
    });
    expect(JSON.parse(created.requests[0].data)).toEqual({
      referrers: [{ referrerId: 'ref_1', shareBps: 5000 }],
      commissionType: 'percentage',
      customMakerFeeBps: 30,
      commissionRateBps: 5000,
      changeReason: 'adjust partner distribution'
    });

    const withdrawn = clientWithResponse({ proposalId: 'proposal/1', status: 'withdrawn' });
    await withdrawn.client.platform.revshare.withdrawProposal('proposal/1');
    expect(withdrawn.requests[0].method).toBe('DELETE');
    expect(withdrawn.requests[0].url).toBe(
      '/api/v1/merchant/revshare/config/proposals/proposal%2F1'
    );
  });

  it('returns current preview, earnings, payout detail, and reconciliation shapes', async () => {
    const previewResponse = {
      tradeAmount: '1000', tradeFee: '3', makerFee: '3', commissionPool: '1.5',
      distribution: [{ referrerId: 'ref_1', amount: '1.5', shareBps: 5000, percentage: 50 }]
    };
    const preview = clientWithResponse(previewResponse);
    await expect(preview.client.platform.revshare.previewConfig({
      tradeAmount: '1000', tradeFee: '3'
    })).resolves.toEqual(previewResponse);

    const earningsResponse = {
      windowFrom: '2026-08-01T00:00:00.000Z', windowTo: '2026-08-30T00:00:00.000Z',
      totalEarnedUsdt: '50', totalPaidUsdt: '40', totalPendingUsdt: '10',
      breakdown: [{ currency: 'USDT', totalUsdt: '50' }]
    };
    const earnings = clientWithResponse(earningsResponse);
    await expect(earnings.client.platform.revshare.getEarnings()).resolves.toEqual(earningsResponse);

    const payoutResponse = {
      payoutId: 'payout_1', amountUsdt: '25', currency: 'USDT', payoutTxHash: null,
      payoutAddressMasked: '********beef', status: 'pending', paidAt: null,
      createdAt: '2026-08-01T00:00:00.000Z', includedRewardIds: ['reward_1'], failureReason: null
    };
    const payout = clientWithResponse(payoutResponse);
    await expect(payout.client.platform.revshare.getPayout('payout_1')).resolves.toEqual(payoutResponse);

    const reconciliationResponse = {
      findings: [{ findingId: 'finding_1', type: 'mismatch', severity: 'high',
        description: 'ledger mismatch', affectedTradeIds: ['trade_1'],
        detectedAt: '2026-08-01T00:00:00.000Z', status: 'open' }]
    };
    const reconciliation = clientWithResponse(reconciliationResponse);
    await expect(reconciliation.client.platform.revshare.getReconciliation())
      .resolves.toEqual(reconciliationResponse);
  });

  it('only sends filters implemented by merchant-service', async () => {
    const rewards = clientWithResponse({ rewards: [], hasMore: false, nextCursor: null });
    await rewards.client.platform.revshare.listRewards({
      from: '2026-08-01', to: '2026-08-30', limit: 25, cursor: 'reward_0'
    });
    expect(rewards.requests[0].url).toBe(
      '/api/v1/merchant/revshare/earnings/rewards?from=2026-08-01&to=2026-08-30&limit=25&cursor=reward_0'
    );

    const payouts = clientWithResponse({ payouts: [], hasMore: false, nextCursor: null });
    await payouts.client.platform.revshare.listPayouts({ limit: 25, cursor: 'payout_0' });
    expect(payouts.requests[0].url).toBe(
      '/api/v1/merchant/revshare/payouts?limit=25&cursor=payout_0'
    );
  });
});
