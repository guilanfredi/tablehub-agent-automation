import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRuns, localDay, metricsFrom, parseLogName, summarize } from './collect.mjs';
import { fmtDuration, fmtTokens, toMarkdown, toText } from './render.mjs';

const result = (over = {}) => ({
  type: 'result', subtype: 'success', is_error: false, duration_ms: 125_000, duration_api_ms: 50_000, num_turns: 9,
  total_cost_usd: 0.5, result: 'PR #14 revisado sem bloqueantes.',
  usage: { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 20_000, output_tokens: 500, output_tokens_details: { thinking_tokens: 200 } },
  modelUsage: { 'claude-opus-5-5': {} }, permission_denials: [{}],
  ...over,
});

describe('relatório: leitura', () => {
  it('lê o nome do log em hora local', () => {
    const m = parseLogName('20261012-112907-dev-14.json');
    expect(m).toMatchObject({ role: 'dev', number: 14 });
    expect(new Date(m.startedAt).getHours()).toBe(11);
    expect(localDay(m.startedAt)).toBe('2026-10-12');
    expect(parseLogName('20261012-112907-dev-14.json.err')).toBeNull();
    expect(parseLogName('dispatcher.log')).toBeNull();
  });

  it('extrai as métricas da saída do claude -p', () => {
    expect(metricsFrom(result())).toEqual({
      durationMs: 125_000, apiMs: 50_000, turns: 9, costUsd: 0.5,
      tokens: { input: 10, cacheWrite: 1000, cacheRead: 20_000, output: 500, thinking: 200 },
      models: ['claude-opus-5-5'], denials: 1, summary: 'PR #14 revisado sem bloqueantes.',
    });
    expect(metricsFrom(null)).toMatchObject({ durationMs: null, turns: null, tokens: { input: 0 } });
  });

  it('junta registro, logs novos e antigos; filtra o dia e deduz o resultado', () => {
    const root = mkdtempSync(join(tmpdir(), 'relatorio-'));
    const stateDir = join(root, 'state');
    const logDir = join(root, 'logs');
    const project = join(root, 'TableHub');
    mkdirSync(join(logDir, 'tablehub'), { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(join(project, 'automation', 'logs'), { recursive: true });
    mkdirSync(join(project, 'automation', 'state'), { recursive: true });

    const novo = join(logDir, 'tablehub', '20261012-100000-dev-10.json');
    writeFileSync(novo, JSON.stringify(result()));
    writeFileSync(join(logDir, 'tablehub', '20261012-110000-qa-11.json'), ''); // vazio e sem execução ativa
    writeFileSync(join(logDir, 'tablehub', '20261011-235900-dev-9.json'), JSON.stringify(result())); // outro dia
    writeFileSync(join(project, 'automation', 'logs', '20261012-090000-revisor-8.json'), `﻿${JSON.stringify(result({ is_error: true }))}`);
    writeFileSync(join(project, 'automation', 'logs', '20261012-120000-dev-12.json'), ''); // ainda rodando no antigo
    writeFileSync(join(project, 'automation', 'state', 'running.json'), JSON.stringify({ role: 'dev', number: 12, pid: 1 }));
    writeFileSync(join(stateDir, 'runs.jsonl'), [
      JSON.stringify({ project: 'tablehub', role: 'dev', number: 10, title: 'Bots', startedAt: new Date(2026, 9, 12, 10, 0).toISOString(), outcome: 'sem-avanço', logFile: novo }),
      JSON.stringify({ project: 'tablehub', role: 'qa', number: 13, startedAt: new Date(2026, 9, 12, 13, 0).toISOString(), outcome: 'falha-ao-iniciar', logFile: null }),
      'linha quebrada',
    ].join('\n'));

    const runs = loadRuns({ day: '2026-10-12', stateDir, logDir, projectPaths: [project] });
    expect(runs.map((r) => `${r.role}#${r.number}:${r.outcome}:${r.source}`)).toEqual([
      'revisor#8:erro:despachante antigo',
      'dev#10:sem-avanço:despachante',
      'qa#11:saída-inesperada:despachante',
      'dev#12:em-andamento:despachante antigo',
      'qa#13:falha-ao-iniciar:despachante',
    ]);
    expect(runs.find((r) => r.number === 10)).toMatchObject({ title: 'Bots', turns: 9, costUsd: 0.5 });
  });
});

describe('relatório: totais e saída', () => {
  const runs = [
    { project: 'tablehub', role: 'dev', number: 10, startedAt: '2026-10-12T13:00:00Z', outcome: 'ok', summary: 'ok', ...metricsFrom(result()) },
    { project: 'tablehub', role: 'dev', number: 11, startedAt: '2026-10-12T14:00:00Z', outcome: 'erro', summary: 'falhou', ...metricsFrom(result({ duration_ms: 5000, total_cost_usd: 0.1, num_turns: 1 })) },
    { project: 'outro', role: 'qa', number: 3, startedAt: '2026-10-12T15:00:00Z', outcome: 'falha-ao-iniciar', ...metricsFrom(null) },
  ];

  it('soma totais, agrupa por função e projeto e separa as falhas', () => {
    const s = summarize(runs);
    expect(s.totals).toMatchObject({ runs: 3, durationMs: 130_000, turns: 10, failures: 2, avgDurationMs: 65_000, outcomes: { ok: 1, erro: 1, 'falha-ao-iniciar': 1 } });
    expect(s.totals.costUsd).toBeCloseTo(0.6);
    expect(s.totals.tokens).toEqual({ input: 20, cacheWrite: 2000, cacheRead: 40_000, output: 1000, thinking: 400, total: 43_020 });
    expect(Object.keys(s.byRole)).toEqual(['dev', 'qa']);
    expect(s.byProject.outro.runs).toBe(1);
    expect(s.failures.map((r) => r.number)).toEqual([11, 3]);
  });

  it('formata duração e tokens em português', () => {
    expect(fmtDuration(45_000)).toBe('45s');
    expect(fmtDuration(125_000)).toBe('2min 05s');
    expect(fmtDuration(3_720_000)).toBe('1h 02min');
    expect(fmtDuration(null)).toBe('—');
    expect(fmtTokens(9_999)).toBe('9.999');
    expect(fmtTokens(568_600)).toBe('568,6 mil');
  });

  it('gera texto e Markdown com limites, falhas e links', () => {
    const usage = { usage: { limits: [{ id: 'session', label: 'Sessão (5 h)', percent: 15, resetsAt: '2026-10-12T23:00:00Z', severity: 'normal' }], extra: null } };
    const args = { day: '2026-10-12', runs, summary: summarize(runs), usage, now: Date.parse('2026-10-12T18:00:00Z') };
    const text = toText(args);
    expect(text).toContain('Relatório dos agentes — seg 12/10/2026');
    expect(text).toContain('Sessão (5 h)');
    expect(text).toContain('3 (1 ok · 1 erro · 1 falha-ao-iniciar)');
    expect(text).toContain('Por projeto');
    const md = toMarkdown({ ...args, repos: { tablehub: 'guilanfredi/tablehub' } });
    expect(md).toContain('[#10](https://github.com/guilanfredi/tablehub/issues/10)');
    expect(md).toContain('## Falhas');
    expect(toText({ ...args, runs: [], summary: summarize([]), usage: { error: 'login vencido' } })).toContain('login vencido');
  });
});
