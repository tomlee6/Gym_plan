import { afterEach, describe, expect, it } from 'vitest';

import { defineLocale, locale, setLocale, t } from './i18n.js';
import { base64url, codeChallenge, randomString } from './pkce.js';

afterEach(() => setLocale('en'));

describe('t()', () => {
  it('looks up dotted keys and fills in {vars}', () => {
    expect(t('owner.status.generating')).toBe('Building walkthrough');
    expect(t('owner.plans.quota', { used: 6, quota: 10 })).toBe('6 of 10 this month');
  });

  it('picks plural forms by count', () => {
    expect(t('owner.plans.levels', { count: 1 })).toBe('1 level');
    expect(t('owner.plans.levels', { count: 3 })).toBe('3 levels');
    expect(t('queue.flags.weakWalls', { count: 2 })).toBe('2 weak walls');
  });

  it('shows the key for a missing string, and leaves an unknown {var} visible', () => {
    expect(t('owner.nope')).toBe('owner.nope');
    expect(t('owner.plans.quota', { used: 1 })).toBe('1 of {quota} this month');
  });

  it('takes another locale, falling back to English for what it lacks', () => {
    defineLocale('test', { owner: { status: { ready: 'Prêt' } } });
    expect(setLocale('test')).toBe('test');
    expect(locale()).toBe('test');
    expect(t('owner.status.ready')).toBe('Prêt');
    expect(t('owner.status.in_review')).toBe('In review');
    expect(setLocale('xx')).toBe('test');
  });

  it('tells the owner a failed build is still in review', () => {
    expect(t('owner.status.generation_failed')).toBe(t('owner.status.in_review'));
  });
});

describe('PKCE', () => {
  it('makes verifiers of unreserved characters only', () => {
    const v = randomString(128);
    expect(v).toMatch(/^[A-Za-z0-9\-._~]{128}$/);
    expect(randomString(64)).not.toBe(randomString(64));
  });

  it('derives the RFC 7636 S256 challenge', async () => {
    // The example in RFC 7636 appendix B.
    expect(await codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
    expect(base64url(new Uint8Array([251, 255]))).toBe('-_8');
  });
});
