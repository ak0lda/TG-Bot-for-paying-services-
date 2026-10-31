import { describe, expect, it } from 'vitest';
import { adminActions, clientActions } from '../src/http/api/dto.js';

const o = (status: string, payMethodId: number | null = null, extra: object = {}) =>
  ({ status, payMode: 'PREPAY', payMethodId, isSubscription: false, ...extra }) as never;

describe('admin actions are derived from the state machine', () => {
  it('confirm_payment appears while awaiting payment only after requisites were sent', () => {
    expect(adminActions(o('AWAITING_PAYMENT', null))).toEqual(expect.arrayContaining(['send_requisites', 'reject']));
    expect(adminActions(o('AWAITING_PAYMENT', null))).not.toContain('confirm_payment');
    expect(adminActions(o('AWAITING_PAYMENT', 1))).toContain('confirm_payment');
    expect(adminActions(o('PAYMENT_CHECK', 1))).toEqual(
      expect.arrayContaining(['confirm_payment', 'payment_not_found']),
    );
  });

  it('client actions: pay needs requisites; reorder only for closed non-subscription orders', () => {
    expect(clientActions(o('AWAITING_PAYMENT', null))).toEqual(['cancel']);
    expect(clientActions(o('AWAITING_PAYMENT', 1))).toEqual(['pay', 'cancel']);
    expect(clientActions(o('DONE'))).toEqual(['reorder']);
    expect(clientActions(o('DONE', null, { isSubscription: true }))).toEqual(['renew']);
    expect(clientActions(o('REJECTED'))).toEqual(['reorder']);
    expect(clientActions(o('IN_PROGRESS'))).toEqual([]);
  });
});
