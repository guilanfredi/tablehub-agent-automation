import { describe, expect, it } from 'vitest';
import { budgetGate, exhaustedReset, normalizeExtraUsage } from './budget.mjs';
import { normalizeMachineConfig } from './config.mjs';

const now = Date.parse('2026-10-12T20:00:00Z');
const at = (h) => new Date(now + h * 3600_000).toISOString();
const limit = (id, percent, resetsInH) => ({ id, label: id === 'session' ? 'Sessão (5 h)' : 'Semanal', percent, resetsAt: at(resetsInH), severity: null });
const off = { allowed: false, stopAtPercent: 90 };

describe('cota x créditos: política', () => {
  it('padrão é créditos desligados, parando em 90%', () => {
    expect(normalizeExtraUsage(undefined)).toEqual({ allowed: false, stopAtPercent: 90 });
    expect(normalizeExtraUsage({ allowed: true })).toEqual({ allowed: true, stopAtPercent: 90 });
    expect(normalizeMachineConfig({ projects: ['/x'] }).extraUsage).toEqual({ allowed: false, stopAtPercent: 90 });
  });

  it('rejeita valores inválidos', () => {
    expect(() => normalizeExtraUsage({ allowed: 'sim' })).toThrow(/allowed/);
    expect(() => normalizeExtraUsage({ stopAtPercent: 0 })).toThrow(/stopAtPercent/);
    expect(() => normalizeExtraUsage({ stopAtPercent: 120 })).toThrow(/stopAtPercent/);
    expect(() => normalizeMachineConfig({ projects: ['/x'], extraUsage: { stopAtPercent: 'muito' } })).toThrow(/stopAtPercent/);
  });
});

describe('cota x créditos: pode abrir agentes?', () => {
  it('créditos ligados: sempre abre', () => {
    expect(budgetGate({ usage: { limits: [limit('session', 100, 2)] }, policy: { allowed: true, stopAtPercent: 90 }, now }).allowed).toBe(true);
  });

  it('para a sessão na margem e volta no horário de reset', () => {
    expect(budgetGate({ usage: { limits: [limit('session', 89, 2)] }, policy: off, now })).toMatchObject({ allowed: true, reason: 'dentro da cota' });
    const g = budgetGate({ usage: { limits: [limit('session', 90, 2), limit('weekly_all', 40, 100)] }, policy: off, now });
    expect(g).toEqual({ allowed: false, until: at(2), reason: 'Sessão (5 h) em 90% e créditos desligados para os agentes' });
  });

  it('semanal só bloqueia em 100%, e aí a pausa vai até o reset semanal', () => {
    expect(budgetGate({ usage: { limits: [limit('weekly_all', 95, 50)] }, policy: off, now }).allowed).toBe(true);
    const g = budgetGate({ usage: { limits: [limit('session', 95, 2), limit('weekly_all', 100, 50)] }, policy: off, now });
    expect(g.allowed).toBe(false);
    expect(g.until).toBe(at(50));
  });

  it('ignora dado de uma janela que já renovou e não trava sem dados', () => {
    expect(budgetGate({ usage: { limits: [limit('session', 100, -0.1)] }, policy: off, now }).allowed).toBe(true);
    expect(budgetGate({ usage: null, policy: off, now })).toMatchObject({ allowed: true, reason: 'limites desconhecidos' });
  });
});

describe('cota x créditos: reset do limite esgotado', () => {
  it('usa o reset mais distante entre os limites em 100%, no futuro e em até 8 dias', () => {
    expect(exhaustedReset({ limits: [limit('session', 100, 2), limit('weekly_all', 100, 30)] }, now)).toBe(at(30));
    expect(exhaustedReset({ limits: [limit('session', 80, 2)] }, now)).toBeNull();
    expect(exhaustedReset({ limits: [limit('session', 100, -1)] }, now)).toBeNull();
    expect(exhaustedReset({ limits: [limit('weekly_all', 100, 24 * 9)] }, now)).toBeNull();
    expect(exhaustedReset(null, now)).toBeNull();
  });
});
