import type { OrderStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { allowedTransitions, canTransition, isFinal, TRANSITIONS } from '../src/domain/order-fsm.js';

const o = (status: OrderStatus, payMode: 'PREPAY' | 'BALANCE' | 'PAY_LATER' = 'PREPAY') => ({ status, payMode });

describe('order FSM', () => {
  it('happy path for PREPAY', () => {
    expect(canTransition(o('NEW'), 'QUOTED', 'ADMIN')).toBe(true);
    expect(canTransition(o('QUOTED'), 'AWAITING_PAYMENT', 'CLIENT')).toBe(true);
    expect(canTransition(o('AWAITING_PAYMENT'), 'PAYMENT_CHECK', 'CLIENT')).toBe(true);
    expect(canTransition(o('PAYMENT_CHECK'), 'IN_PROGRESS', 'ADMIN')).toBe(true);
    expect(canTransition(o('IN_PROGRESS'), 'DONE', 'ADMIN')).toBe(true);
  });

  it('BALANCE / PAY_LATER skip payment, PREPAY cannot', () => {
    expect(canTransition(o('QUOTED', 'BALANCE'), 'IN_PROGRESS', 'CLIENT')).toBe(true);
    expect(canTransition(o('QUOTED', 'PAY_LATER'), 'IN_PROGRESS', 'CLIENT')).toBe(true);
    expect(canTransition(o('QUOTED', 'PREPAY'), 'IN_PROGRESS', 'CLIENT')).toBe(false);
    // BALANCE при нехватке средств идёт через доплату переводом
    expect(canTransition(o('QUOTED', 'BALANCE'), 'AWAITING_PAYMENT', 'CLIENT')).toBe(true);
    expect(canTransition(o('QUOTED', 'PAY_LATER'), 'AWAITING_PAYMENT', 'CLIENT')).toBe(false);
  });

  it('enforces actor rights', () => {
    expect(canTransition(o('NEW'), 'QUOTED', 'CLIENT')).toBe(false);
    expect(canTransition(o('PAYMENT_CHECK'), 'IN_PROGRESS', 'CLIENT')).toBe(false);
    expect(canTransition(o('IN_PROGRESS'), 'DONE', 'CLIENT')).toBe(false);
    expect(canTransition(o('QUOTED'), 'EXPIRED', 'ADMIN')).toBe(false);
    expect(canTransition(o('QUOTED'), 'EXPIRED', 'SYSTEM')).toBe(true);
  });

  it('client may cancel only before payment is confirmed', () => {
    for (const s of ['NEW', 'QUOTED', 'AWAITING_PAYMENT', 'PAYMENT_CHECK', 'EXPIRED'] as const) {
      expect(canTransition(o(s), 'CANCELED', 'CLIENT')).toBe(true);
    }
    for (const s of ['IN_PROGRESS', 'LINK_INVALID', 'DONE', 'REJECTED'] as const) {
      expect(canTransition(o(s), 'CANCELED', 'CLIENT')).toBe(false);
    }
  });

  it('admin may reject any non-final order; final states are terminal', () => {
    for (const s of [
      'NEW',
      'QUOTED',
      'AWAITING_PAYMENT',
      'PAYMENT_CHECK',
      'IN_PROGRESS',
      'LINK_INVALID',
      'EXPIRED',
    ] as const) {
      expect(canTransition(o(s), 'REJECTED', 'ADMIN')).toBe(true);
    }
    for (const s of ['DONE', 'CANCELED', 'REJECTED'] as const) {
      expect(isFinal(s)).toBe(true);
      expect(TRANSITIONS.some((t) => t.from === s)).toBe(false);
    }
  });

  it('link-invalid loop and expiry recovery', () => {
    expect(canTransition(o('IN_PROGRESS'), 'LINK_INVALID', 'ADMIN')).toBe(true);
    expect(canTransition(o('LINK_INVALID'), 'IN_PROGRESS', 'CLIENT')).toBe(true);
    expect(canTransition(o('EXPIRED'), 'QUOTED', 'CLIENT')).toBe(true);
    expect(canTransition(o('PAYMENT_CHECK'), 'AWAITING_PAYMENT', 'ADMIN')).toBe(true);
  });

  it('rejects skipping states', () => {
    expect(canTransition(o('NEW'), 'DONE', 'ADMIN')).toBe(false);
    expect(canTransition(o('QUOTED'), 'DONE', 'ADMIN')).toBe(false);
    // админ может подтвердить поступление, не дожидаясь «Я оплатил» клиента; клиент — нет
    expect(canTransition(o('AWAITING_PAYMENT'), 'IN_PROGRESS', 'ADMIN')).toBe(true);
    expect(canTransition(o('AWAITING_PAYMENT'), 'IN_PROGRESS', 'CLIENT')).toBe(false);
  });

  it('lists allowed transitions', () => {
    expect(allowedTransitions(o('IN_PROGRESS'), 'ADMIN').sort()).toEqual(['DONE', 'LINK_INVALID', 'REJECTED']);
    expect(allowedTransitions(o('DONE'), 'ADMIN')).toEqual([]);
  });
});
