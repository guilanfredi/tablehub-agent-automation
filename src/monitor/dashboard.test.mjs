import { describe, expect, it } from 'vitest';
import { fit, sparkline, visibleWidth, wrap } from './dashboard.mjs';
import { parseTranscript, treeTotals } from './data.mjs';

describe('monitor: desenho do dashboard', () => {
  it('mede largura ignorando cores e contando emoji/CJK como 2', () => {
    expect(visibleWidth('\x1b[32mabc\x1b[0m')).toBe(3);
    expect(visibleWidth('a🎲b')).toBe(4);
    expect(visibleWidth('漢字')).toBe(4);
  });

  it('ajusta texto à largura exata, com reticências no corte', () => {
    expect(fit('abc', 5)).toBe('abc  ');
    expect(fit('abcdef', 4)).toBe('abc…');
    expect(visibleWidth(fit('\x1b[31mvermelho comprido\x1b[0m', 6))).toBe(6);
    expect(visibleWidth(fit('🎲🎲🎲', 5))).toBe(5);
  });

  it('quebra linhas sem passar da largura', () => {
    expect(wrap('um dois tres quatro', 8)).toEqual(['um dois', 'tres', 'quatro']);
    expect(wrap('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrap('', 10)).toEqual(['']);
  });

  it('desenha sparkline na escala dada', () => {
    expect(sparkline([0, 50, 100], 10, 100)).toBe('▁▅█');
    expect(sparkline([1, 2, 3, 4], 2)).toBe('▁█');
    expect(sparkline([500, 500], 10)).toBe('▄▄');
  });
});

describe('monitor: dados', () => {
  it('extrai eventos, título, modelo e contexto do transcript', () => {
    const lines = [
      { type: 'user', timestamp: 't1', message: { content: '/dev 10' } },
      { type: 'user', timestamp: 't1', message: { content: '<system-reminder>x</system-reminder>' } },
      { type: 'assistant', timestamp: 't2', message: { model: 'claude-opus-5-5', usage: { input_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, output_tokens: 50 },
        content: [{ type: 'thinking' }, { type: 'text', text: 'Vou rodar\nos testes' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'Roda os testes' } }] } },
      { type: 'user', timestamp: 't3', message: { content: [{ type: 'tool_result', is_error: true, content: 'falhou' }] } },
      { type: 'assistant', isSidechain: true, timestamp: 't4', message: { content: [{ type: 'text', text: 'subagente' }] } },
      { type: 'custom-title', customTitle: 'Minha sessão' },
      'linha quebrada {',
    ].map((l) => (typeof l === 'string' ? l : JSON.stringify(l)));
    const t = parseTranscript(lines);
    expect(t.events).toEqual([
      { ts: 't1', kind: 'prompt', text: '/dev 10' },
      { ts: 't2', kind: 'texto', text: 'Vou rodar os testes' },
      { ts: 't2', kind: 'ferramenta', text: 'Bash: Roda os testes' },
      { ts: 't3', kind: 'erro', text: 'falhou' },
    ]);
    expect(t).toMatchObject({ title: 'Minha sessão', model: 'claude-opus-5-5', contextTokens: 1062 });
  });

  it('soma a árvore de processos e ignora PID reaproveitado', () => {
    const p = (pid, ppid, mem, cpu, started) => [pid, { pid, ppid, mem, cpu, started }];
    const procs = new Map([
      p(10, 1, 100, 5, '2026-10-12T10:00:00Z'),
      p(11, 10, 50, 3, '2026-10-12T10:01:00Z'),
      p(12, 11, 25, 1, '2026-10-12T10:02:00Z'),
      p(13, 10, 999, 999, '2026-10-12T09:00:00Z'), // órfão antigo com o pai reaproveitado
      p(20, 1, 7, 7, '2026-10-12T10:00:00Z'),
    ]);
    expect(treeTotals(procs, 10)).toEqual({ mem: 175, cpu: 9, count: 3 });
  });
});

describe('monitor: faixa de limites', () => {
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  it('mostra percentual, reset e uso extra, ou o motivo da falta de dados', async () => {
    const { limitsLine } = await import('./dashboard.mjs');
    const now = new Date(2026, 9, 12, 15, 0).getTime();
    const usage = {
      limits: [{ id: 'session', label: 'Sessão (5 h)', percent: 100, resetsAt: new Date(2026, 9, 12, 20, 0).toISOString(), severity: 'critical' }],
      extra: { used: 5.59, limit: 2000, currency: 'BRL' },
    };
    const line = strip(limitsLine({ usage }, now));
    expect(line).toContain('Sessão (5 h) ████████ 100% renova hoje 20:00 (em 5h00)');
    expect(line.replace(/\s/g, ' ')).toContain('Extra R$ 5,59 / R$ 2.000,00');
    expect(strip(limitsLine({ error: 'login vencido' }, now))).toBe(' Limites da assinatura: login vencido');
    expect(strip(limitsLine(null, now))).toContain('consultando');
  });
});

describe('monitor: faixa de limites compacta', () => {
  it('tira as barras quando a linha não cabe', async () => {
    const { limitsLine } = await import('./dashboard.mjs');
    const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
    const now = new Date(2026, 9, 12, 15, 0).getTime();
    const usage = { limits: [{ id: 'session', label: 'Sessão (5 h)', percent: 18, resetsAt: new Date(2026, 9, 12, 20, 0).toISOString(), severity: 'normal' }], extra: null };
    expect(strip(limitsLine({ usage }, now, 40))).toBe(' Sessão (5 h) 18% → hoje 20:00 (em 5h00)');
    expect(strip(limitsLine({ usage }, now, 200))).toContain('█');
  });
});

describe('monitor: situação dos agentes na faixa de limites', () => {
  it('mostra créditos ligados, a margem ou a pausa até o reset', async () => {
    const { limitsLine } = await import('./dashboard.mjs');
    const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
    const now = new Date(2026, 9, 12, 15, 0).getTime();
    const usage = (p) => ({ limits: [{ id: 'session', label: 'Sessão (5 h)', percent: p, resetsAt: new Date(2026, 9, 12, 20, 0).toISOString(), severity: null }], extra: null });
    expect(strip(limitsLine({ usage: usage(50) }, now, Infinity, { allowed: true, stopAtPercent: 90 }))).toContain('Agentes: créditos ligados');
    expect(strip(limitsLine({ usage: usage(50) }, now, Infinity, { allowed: false, stopAtPercent: 90 }))).toContain('Agentes: param em 90%');
    expect(strip(limitsLine({ usage: usage(93) }, now, Infinity, { allowed: false, stopAtPercent: 90 }))).toContain('Agentes pausados até hoje 20:00 (em 5h00)');
    expect(strip(limitsLine({ usage: usage(93) }, now))).not.toContain('Agentes');
  });
});
