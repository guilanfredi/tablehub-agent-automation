import { describe, expect, it } from 'vitest';
import { formatMoney, formatReset, level, parseUsage } from './usage.mjs';

// resposta real do endpoint (2026-10-12), só com os campos usados
const real = {
  five_hour: { utilization: 100, resets_at: '2026-10-12T17:30:00.248571+00:00' },
  seven_day: { utilization: 10, resets_at: '2026-10-19T07:00:00.248592+00:00' },
  seven_day_opus: null,
  extra_usage: { is_enabled: true, monthly_limit: 200000, used_credits: 0, currency: 'BRL', decimal_places: 2 },
  limits: [
    { kind: 'session', group: 'session', percent: 100, severity: 'critical', resets_at: '2026-10-12T17:30:00.248571+00:00' },
    { kind: 'weekly_all', group: 'weekly', percent: 10, severity: 'normal', resets_at: '2026-10-19T07:00:00.248592+00:00' },
  ],
};

describe('limites da assinatura', () => {
  it('lê a lista de limites e o uso extra', () => {
    expect(parseUsage(real)).toEqual({
      limits: [
        { id: 'session', label: 'Sessão (5 h)', percent: 100, resetsAt: '2026-10-12T17:30:00.248571+00:00', severity: 'critical' },
        { id: 'weekly_all', label: 'Semanal', percent: 10, resetsAt: '2026-10-19T07:00:00.248592+00:00', severity: 'normal' },
      ],
      extra: { used: 0, limit: 2000, currency: 'BRL' },
    });
  });

  it('usa five_hour/seven_day quando a lista não vem, e mostra tipos desconhecidos pelo nome', () => {
    const { limits, extra } = parseUsage({ ...real, limits: undefined, extra_usage: { is_enabled: false } });
    expect(limits.map((l) => [l.id, l.percent])).toEqual([['session', 100], ['weekly_all', 10]]);
    expect(extra).toBeNull();
    expect(parseUsage({ limits: [{ kind: 'novo_limite', percent: 5 }] }).limits[0].label).toBe('novo_limite');
    expect(parseUsage(null)).toEqual({ limits: [], extra: null });
  });

  it('classifica o nível pela severidade ou pelo percentual', () => {
    expect(level({ percent: 10, severity: 'critical' })).toBe('alto');
    expect(level({ percent: 95, severity: null })).toBe('alto');
    expect(level({ percent: 75, severity: null })).toBe('medio');
    expect(level({ percent: 10, severity: 'normal' })).toBe('baixo');
  });

  it('formata o reset em hora local com contagem regressiva', () => {
    const now = new Date(2026, 9, 12, 12, 25).getTime(); // 12/10 12:25 local
    expect(formatReset(new Date(2026, 9, 12, 14, 30).toISOString(), now)).toBe('hoje 14:30 (em 2h05)');
    expect(formatReset(new Date(2026, 9, 12, 12, 50).toISOString(), now)).toBe('hoje 12:50 (em 25min)');
    expect(formatReset(new Date(2026, 9, 13, 4, 0).toISOString(), now)).toBe('amanhã 04:00 (em 15h35)');
    expect(formatReset(new Date(2026, 9, 19, 4, 0).toISOString(), now)).toBe('seg 19/10 04:00 (em 6 dias)');
    expect(formatReset(null, now)).toBe('sem data de reset');
  });

  it('formata valores em reais', () => {
    expect(formatMoney(2000, 'BRL').replace(/\s/g, ' ')).toBe('R$ 2.000,00');
  });
});

describe('limites: cache compartilhado', () => {
  it('reaproveita valor recente, renova o vencido e cai para o último valor se a consulta falhar', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { fetchUsage, staleNote } = await import('./usage.mjs');
    const cacheFile = join(mkdtempSync(join(tmpdir(), 'usage-')), 'cache.json');
    const usage = parseUsage(real);
    let calls = 0;
    const ok = async () => { calls++; return { usage }; };
    const fail = async () => { calls++; return { error: 'HTTP 429, consultas demais' }; };
    const t0 = new Date(2026, 9, 12, 14, 5).getTime();

    expect(await fetchUsage(t0, { cacheFile, request: fail })).toEqual({ error: 'limites indisponíveis (HTTP 429, consultas demais)' });
    expect(await fetchUsage(t0, { cacheFile, request: ok })).toEqual({ usage, fetchedAt: t0 });
    expect(await fetchUsage(t0 + 60_000, { cacheFile, request: fail })).toEqual({ usage, fetchedAt: t0 }); // cache fresco: nem consulta
    expect(calls).toBe(2);
    const stale = await fetchUsage(t0 + 10 * 60_000, { cacheFile, request: fail });
    expect(stale).toMatchObject({ usage, fetchedAt: t0, stale: true, warning: 'HTTP 429, consultas demais' });
    expect(staleNote(stale)).toBe(' · dados de 14:05 (HTTP 429, consultas demais)');
    expect(staleNote({ usage })).toBe('');
  });
});
