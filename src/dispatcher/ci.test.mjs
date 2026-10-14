import { describe, expect, it } from 'vitest';
import { ciGate, ciState, describeCi, gatedRole, matchesCheck, normalizeContexts } from './ci.mjs';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const MIN = 60_000;
const run = (name, status, conclusion = null, startedAt = '2026-10-14T11:50:00Z') => ({ __typename: 'CheckRun', name, status, conclusion, startedAt });
const state = (nodes, checks = ['test', 'e2e'], firstSeenAt = NOW) => ciState(normalizeContexts(nodes), checks, { firstSeenAt, now: NOW, missingAfterMin: 20 });

const cfg = {
  owner: 'dono', bot: { login: 'bot' },
  labels: { working: 'agente:trabalhando', waiting: 'aguardando-dono' },
  roles: [
    { name: 'revisor', label: 'fase:review' },
    { name: 'qa', label: 'fase:qa' },
    { name: 'dev', label: 'fase:dev' },
  ],
  ci: { checks: ['test', 'e2e'], roles: ['qa', 'revisor'], failLabel: 'fase:dev', missingAfterMin: 20 },
};
const item = (number, labels, extra = {}) => ({ number, isPr: true, author: 'bot', labels, ...extra });
const pr = (sha, nodes) => ({ sha, contexts: normalizeContexts(nodes) });
const GREEN = [run('test', 'COMPLETED', 'SUCCESS'), run('e2e (1, 2)', 'COMPLETED', 'SUCCESS'), run('e2e (2, 2)', 'COMPLETED', 'SUCCESS')];

describe('despachante: espera do CI', () => {
  it('lê check runs e status de commit no mesmo formato', () => {
    expect(normalizeContexts([
      run('test', 'COMPLETED', 'SUCCESS'),
      run('e2e', 'IN_PROGRESS'),
      { __typename: 'StatusContext', context: 'deploy', state: 'FAILURE', createdAt: '2026-10-14T11:00:00Z' },
      null,
    ])).toEqual([
      { name: 'test', done: true, ok: true, at: '2026-10-14T11:50:00Z' },
      { name: 'e2e', done: false, ok: false, at: '2026-10-14T11:50:00Z' },
      { name: 'deploy', done: true, ok: false, at: '2026-10-14T11:00:00Z' },
    ]);
  });

  it('aceita os nomes de matriz do Actions, mas não outros checks com o mesmo começo', () => {
    expect(matchesCheck('e2e', 'e2e')).toBe(true);
    expect(matchesCheck('e2e (1, 2)', 'e2e')).toBe(true);
    expect(matchesCheck('e2e-mobile', 'e2e')).toBe(false);
    expect(matchesCheck('test', 'e2e')).toBe(false);
  });

  it('fica verde só com todos os checks exigidos (todas as partes da matriz) terminados com sucesso', () => {
    expect(state(GREEN).state).toBe('success');
    expect(state([...GREEN.slice(0, 2), run('e2e (2, 2)', 'QUEUED')])).toMatchObject({ state: 'pending', pending: ['e2e (2, 2)'] });
    // checks que não foram exigidos (ex.: sincronização do quadro) não importam
    expect(state([...GREEN, run('sync', 'COMPLETED', 'FAILURE')]).state).toBe('success');
    expect(state([...GREEN.slice(0, 2), run('e2e (2, 2)', 'COMPLETED', 'SKIPPED')]).state).toBe('success');
  });

  it('falha assim que um check exigido falha, sem esperar os outros', () => {
    expect(state([run('test', 'COMPLETED', 'FAILURE'), run('e2e', 'IN_PROGRESS')])).toMatchObject({ state: 'failure', failed: ['test'] });
    expect(state([run('test', 'COMPLETED', 'SUCCESS'), run('e2e', 'COMPLETED', 'CANCELLED')]).state).toBe('failure');
  });

  it('numa reexecução vale a mais recente', () => {
    const rerun = [run('test', 'COMPLETED', 'SUCCESS'), run('e2e', 'COMPLETED', 'FAILURE', '2026-10-14T11:00:00Z'), run('e2e', 'IN_PROGRESS', null, '2026-10-14T11:55:00Z')];
    expect(state(rerun).state).toBe('pending');
    expect(state([rerun[0], rerun[1], run('e2e', 'COMPLETED', 'SUCCESS', '2026-10-14T11:55:00Z')]).state).toBe('success');
  });

  it('check que ainda não apareceu espera; depois de missingAfterMin, segue sem ele', () => {
    expect(state([run('test', 'COMPLETED', 'SUCCESS')])).toMatchObject({ state: 'pending', missing: ['e2e'] });
    expect(state([run('test', 'COMPLETED', 'SUCCESS')], ['test', 'e2e'], NOW - 25 * MIN).state).toBe('missing');
    expect(state([], ['test'], NOW - 19 * MIN).state).toBe('pending');
  });

  it('só as funções de ci.roles esperam, e só em PRs', () => {
    expect(gatedRole(item(1, ['fase:qa']), cfg)?.name).toBe('qa');
    expect(gatedRole(item(1, ['fase:review']), cfg)?.name).toBe('revisor');
    expect(gatedRole(item(1, ['fase:dev']), cfg)).toBeNull();
    expect(gatedRole(item(1, ['fase:qa'], { isPr: false }), cfg)).toBeNull();
    expect(gatedRole(item(1, ['fase:qa']), { ...cfg, ci: null })).toBeNull();
  });

  it('bloqueia PRs com o CI rodando e devolve para a correção os com CI vermelho', () => {
    const items = [
      item(1, ['fase:qa']), item(2, ['fase:review']), item(3, ['fase:qa']), item(4, ['fase:dev']), item(5, ['fase:qa', 'agente:trabalhando']),
    ];
    const prs = new Map([
      [1, pr('a1', GREEN)],
      [2, pr('b2', [run('test', 'COMPLETED', 'SUCCESS'), run('e2e', 'IN_PROGRESS')])],
      [3, pr('c3', [run('test', 'COMPLETED', 'SUCCESS'), run('e2e', 'COMPLETED', 'FAILURE')])],
      [4, pr('d4', [run('test', 'COMPLETED', 'FAILURE')])],
      [5, pr('e5', [run('test', 'IN_PROGRESS')])],
    ]);
    const g = ciGate({ items, prs, cfg, firstSeen: new Map(), now: NOW });
    expect([...g.blocked]).toEqual([2, 3]);
    expect(g.failures.map((f) => [f.item.number, f.role.name, f.sha, f.failed])).toEqual([[3, 'qa', 'c3', ['e2e']]]);
    // dev não espera o CI; item em execução fica como está
    expect(g.states.map((s) => s.item.number)).toEqual([1, 2, 3]);
  });

  it('com a consulta do CI falhando, os PRs que esperam o CI ficam de fora', () => {
    const g = ciGate({ items: [item(1, ['fase:qa']), item(2, ['fase:dev'])], prs: null, cfg, firstSeen: new Map(), now: NOW });
    expect([...g.blocked]).toEqual([1]);
    expect(describeCi(g.states[0])).toMatch(/desconhecido/);
  });

  it('não mexe nas etiquetas de PRs de terceiros, aguardando o dono ou sem failLabel', () => {
    const red = new Map([[1, pr('a1', [run('test', 'COMPLETED', 'FAILURE')])]]);
    const gate = (it, c = cfg) => ciGate({ items: [it], prs: red, cfg: c, firstSeen: new Map(), now: NOW });
    expect(gate(item(1, ['fase:qa'], { author: 'estranho' })).failures).toEqual([]);
    expect(gate(item(1, ['fase:qa', 'aguardando-dono'])).failures).toEqual([]);
    const semRotulo = gate(item(1, ['fase:qa']), { ...cfg, ci: { ...cfg.ci, failLabel: null } });
    expect(semRotulo.failures).toEqual([]);
    expect([...semRotulo.blocked]).toEqual([1]);
    expect(gate(item(1, ['fase:qa'])).failures).toHaveLength(1);
  });

  it('usa a primeira vez que viu o commit para decidir que um check não vai aparecer', () => {
    const prs = new Map([[1, pr('a1', [run('test', 'COMPLETED', 'SUCCESS')])]]);
    const g = (firstSeen) => ciGate({ items: [item(1, ['fase:qa'])], prs, cfg, firstSeen, now: NOW });
    expect([...g(new Map()).blocked]).toEqual([1]);
    expect([...g(new Map([['a1', NOW - 30 * MIN]])).blocked]).toEqual([]);
  });
});
