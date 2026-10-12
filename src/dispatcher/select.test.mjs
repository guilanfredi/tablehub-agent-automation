import { describe, expect, it } from 'vitest';
import { classifyError, freeSlot, interleave, madeProgress, normalizeItem, pickJobs, recordRun } from './select.mjs';
import { descendants } from './proc.mjs';

const WORKING = 'agente:trabalhando';
const WAITING = 'aguardando-dono';
const ROLES = [
  { name: 'revisor', label: 'fase:review', timeoutMin: 30, prOnly: true },
  { name: 'qa', label: 'fase:qa', timeoutMin: 60, prOnly: true },
  { name: 'dev', label: 'fase:dev', timeoutMin: 120, prOnly: false },
  { name: 'analista', label: 'fase:spec', timeoutMin: 60, prOnly: false },
];
const cfg = { owner: 'dono', bot: 'bot', working: WORKING, waiting: WAITING };
let seq = 0;
const item = (number, labels, extra = {}) => ({
  number, title: `t${number}`, isPr: true, author: 'dono', labels, updatedAt: new Date(Date.UTC(2026, 9, 1, 0, seq++)).toISOString(), ...extra,
});
const pick = (items, extra = {}) => pickJobs({
  items, running: [], roles: ROLES, maxTotal: 3, waitingResolved: new Set(), history: {}, now: Date.parse('2026-10-12T12:00:00Z'), cfg, ...extra,
}).map((p) => `${p.role.name}#${p.item.number}`);

describe('despachante: escolha das tarefas', () => {
  it('respeita prioridade das funções e o limite total', () => {
    const items = [item(1, ['fase:spec'], { isPr: false }), item(2, ['fase:dev']), item(3, ['fase:review']), item(4, ['fase:qa']), item(5, ['fase:dev'])];
    expect(pick(items)).toEqual(['revisor#3', 'qa#4', 'dev#2']);
    expect(pick(items, { maxTotal: 10 })).toEqual(['revisor#3', 'qa#4', 'dev#2', 'dev#5', 'analista#1']);
  });

  it('paraleliza a mesma função e desconta as vagas em uso', () => {
    const items = [item(1, ['fase:dev']), item(2, ['fase:dev']), item(3, ['fase:dev']), item(4, ['fase:dev'])];
    expect(pick(items, { running: [{ number: 1, role: 'dev' }] })).toEqual(['dev#2', 'dev#3']);
    expect(pick(items, { running: [{ number: 9, role: 'qa' }, { number: 8, role: 'qa' }, { number: 7, role: 'dev' }] })).toEqual([]);
  });

  it('aplica limite por função', () => {
    const items = [item(1, ['fase:review']), item(2, ['fase:review']), item(3, ['fase:dev'])];
    expect(pick(items, { maxPerRole: { revisor: 1 } })).toEqual(['revisor#1', 'dev#3']);
  });

  it('ignora itens ocupados, de terceiros, só-PR em issue e aguardando o dono', () => {
    const items = [
      item(1, ['fase:dev', WORKING]),
      item(2, ['fase:dev'], { author: 'estranho' }),
      item(3, ['fase:qa'], { isPr: false }),
      item(4, ['fase:dev', WAITING]),
      item(5, ['fase:dev', WAITING]),
      item(6, ['fase:dev'], { author: 'bot' }),
    ];
    expect(pick(items, { waitingResolved: new Set([5]), blocked: new Set([6]) })).toEqual(['dev#5']);
  });

  it('nunca escolhe o mesmo item duas vezes, mesmo com duas etiquetas de fase', () => {
    expect(pick([item(1, ['fase:qa', 'fase:dev'])])).toEqual(['qa#1']);
  });

  it('respeita o intervalo depois de uma execução sem avanço', () => {
    const history = { '1:dev': { runs: 1, cooldownUntil: '2026-10-12T12:05:00Z' } };
    expect(pick([item(1, ['fase:dev'])], { history })).toEqual([]);
    expect(pick([item(1, ['fase:dev'])], { history, now: Date.parse('2026-10-12T12:06:00Z') })).toEqual(['dev#1']);
  });

  it('alterna entre projetos para dividir as vagas', () => {
    expect(interleave([['a1', 'a2', 'a3'], ['b1'], ['c1', 'c2']], 4)).toEqual(['a1', 'b1', 'c1', 'a2']);
    expect(interleave([['a1', 'a2'], []], 5)).toEqual(['a1', 'a2']);
    expect(interleave([['a1']], 0)).toEqual([]);
  });
});

describe('despachante: avanço e novas tentativas', () => {
  const dev = ROLES.find((r) => r.name === 'dev');
  it('detecta avanço pela troca de fase, fechamento ou pedido ao dono', () => {
    expect(madeProgress({ state: 'open', labels: [{ name: 'fase:qa' }] }, dev, WAITING)).toBe(true);
    expect(madeProgress({ state: 'closed', labels: [{ name: 'fase:dev' }] }, dev, WAITING)).toBe(true);
    expect(madeProgress({ state: 'open', labels: [{ name: 'fase:dev' }, { name: WAITING }] }, dev, WAITING)).toBe(true);
    expect(madeProgress({ state: 'open', labels: [{ name: 'fase:dev' }] }, dev, WAITING)).toBe(false);
  });

  it('chama o dono depois de N execuções seguidas sem avanço', () => {
    const opts = { cooldownMin: 10, maxRuns: 3 };
    const now = Date.parse('2026-10-12T12:00:00Z');
    let r = recordRun({}, 7, 'dev', false, now, opts);
    expect(r.history['7:dev']).toEqual({ runs: 1, cooldownUntil: '2026-10-12T12:10:00.000Z' });
    r = recordRun(r.history, 7, 'dev', false, now, opts);
    expect(r.escalate).toBe(false);
    r = recordRun(r.history, 7, 'dev', false, now, opts);
    expect(r).toEqual({ history: {}, escalate: true });
    expect(recordRun({ '7:dev': { runs: 2 } }, 7, 'dev', true, now, opts).history).toEqual({});
  });
});

describe('despachante: utilidades', () => {
  it('normaliza itens da API', () => {
    expect(normalizeItem({ number: 3, title: 'x', pull_request: {}, user: { login: 'dono' }, labels: [{ name: 'fase:qa' }], updated_at: 'u' }))
      .toEqual({ number: 3, title: 'x', isPr: true, author: 'dono', labels: ['fase:qa'], updatedAt: 'u' });
  });

  it('acha o menor número livre', () => {
    expect(freeSlot([])).toBe(1);
    expect(freeSlot([1, 3])).toBe(2);
  });

  it('classifica erros que pedem pausa', () => {
    expect(classifyError('OAuth token expired')?.pauseMin).toBe(60);
    expect(classifyError('Usage limit reached')?.pauseMin).toBe(30);
    expect(classifyError('algo deu errado')).toBeNull();
  });

  it('acha descendentes, inclusive órfãos, ignorando PID reaproveitado', () => {
    const table = [
      { pid: 20, ppid: 10, started: 100 },
      { pid: 21, ppid: 20, started: 110 },
      { pid: 22, ppid: 10, started: 50 }, // mais velho que a execução: outro processo
      { pid: 30, ppid: 99, started: 120 },
    ];
    expect(descendants(table, 10, 90).sort()).toEqual([20, 21]);
  });
});
