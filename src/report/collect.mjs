/**
 * Coleta das execuções dos agentes para o relatório.
 *
 * Fontes, desduplicadas pelo arquivo de log:
 * - state/runs.jsonl: uma linha por execução terminada, com o resultado decidido pelo despachante;
 * - logs/<projeto>/<AAAAMMDD-HHMMSS>-<função>-<n>.json: saída JSON do `claude -p` (tokens, tempo, turnos, custo);
 * - <projeto>/automation/logs/*.json: logs do despachante antigo, que ficava dentro do TableHub.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const LOG_NAME = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-([a-z0-9-]+)-(\d+)\.json$/;

/** "20261012-112907-dev-14.json" → { startedAt (hora local), role, number } (função pura; testada). */
export function parseLogName(name) {
  const m = LOG_NAME.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, role, number] = m;
  return { startedAt: new Date(+y, +mo - 1, +d, +h, +mi, +s).toISOString(), role, number: Number(number) };
}

/** Dia local "AAAA-MM-DD" de um instante. */
export function localDay(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const keyOf = (path) => resolve(path).toLowerCase();

function readJsonFile(path) {
  try {
    const raw = readFileSync(path, 'utf8').replace(/^﻿/, '');
    return raw.trim() ? { json: JSON.parse(raw) } : { empty: true };
  } catch { return { invalid: true }; }
}

/**
 * Métricas do JSON de saída do `claude -p --output-format json` (função pura; testada).
 *
 * Quando o agente usa tarefas em segundo plano, a sessão produz vários resultados e `usage`,
 * `duration_ms` e `num_turns` descrevem só o último (`result_index` > 0). `modelUsage` e
 * `total_cost_usd` são da sessão inteira: os tokens vêm de lá; os turnos ficam desconhecidos.
 */
export function metricsFrom(result) {
  const u = result?.usage ?? {};
  const perModel = Object.entries(result?.modelUsage ?? {});
  const partial = (result?.result_index ?? 0) > 0;
  const tokens = perModel.length
    ? perModel.reduce((t, [, m]) => ({
      input: t.input + (m.inputTokens ?? 0),
      cacheWrite: t.cacheWrite + (m.cacheCreationInputTokens ?? 0),
      cacheRead: t.cacheRead + (m.cacheReadInputTokens ?? 0),
      output: t.output + (m.outputTokens ?? 0),
      thinking: t.thinking + (m.thinkingTokens ?? 0),
    }), { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 })
    : {
      input: u.input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      thinking: u.output_tokens_details?.thinking_tokens ?? 0,
    };
  return {
    durationMs: partial ? null : result?.duration_ms ?? null,
    apiMs: partial ? null : result?.duration_api_ms ?? null,
    turns: partial ? null : result?.num_turns ?? null,
    costUsd: result?.total_cost_usd ?? null,
    tokens,
    models: perModel.map(([name]) => name),
    denials: result?.permission_denials?.length ?? 0,
    summary: typeof result?.result === 'string' ? result.result.replace(/\s+/g, ' ').trim() : '',
  };
}

function readLedger(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

function listLogs(dir) {
  try { return readdirSync(dir).filter((f) => LOG_NAME.test(f)).map((f) => join(dir, f)); } catch { return []; }
}

/**
 * Execuções iniciadas no dia local `day` ("AAAA-MM-DD").
 * @param {object} p
 * @param {string} p.stateDir    state/ da automação
 * @param {string} p.logDir      logs/ da automação
 * @param {string[]} p.projectPaths  cópias principais (para os logs do despachante antigo)
 */
export function loadRuns({ day, stateDir, logDir, projectPaths = [] }) {
  const ledger = new Map();
  const noLog = [];
  for (const entry of readLedger(join(stateDir, 'runs.jsonl'))) {
    if (entry.logFile) ledger.set(keyOf(entry.logFile), entry); else noLog.push(entry);
  }
  const runningLogs = new Set(
    [join(stateDir, 'jobs.json'), ...projectPaths.map((p) => join(p, 'automation', 'state', 'jobs.json'))]
      .flatMap((f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return []; } })
      // pelo nome do arquivo (carimbo-função-número): vale mesmo se a pasta da automação mudar de lugar
      .filter((j) => j.logFile).map((j) => basename(j.logFile.replaceAll('\\', '/')).toLowerCase()),
  );
  const legacyRunning = projectPaths
    .map((p) => { try { return { project: basename(p).toLowerCase(), ...JSON.parse(readFileSync(join(p, 'automation', 'state', 'running.json'), 'utf8')) }; } catch { return null; } })
    .filter(Boolean);

  const files = [];
  let projectDirs = [];
  try { projectDirs = readdirSync(logDir).filter((d) => statSync(join(logDir, d)).isDirectory()); } catch { /* sem logs ainda */ }
  for (const dir of projectDirs) for (const f of listLogs(join(logDir, dir))) files.push({ file: f, project: dir, source: 'despachante' });
  for (const p of projectPaths) {
    for (const f of listLogs(join(p, 'automation', 'logs'))) files.push({ file: f, project: basename(p).toLowerCase(), source: 'despachante antigo' });
  }

  const runs = [];
  const seen = new Set();
  for (const { file, project, source } of files) {
    const key = keyOf(file);
    if (seen.has(key)) continue;
    seen.add(key);
    const meta = parseLogName(basename(file));
    if (localDay(meta.startedAt) !== day) continue;
    const entry = ledger.get(key);
    const read = readJsonFile(file);
    let outcome = entry?.outcome;
    if (!outcome) {
      const stillRunning = runningLogs.has(basename(file).toLowerCase()) || legacyRunning.some((l) => l.project === project && l.role === meta.role && l.number === meta.number);
      if (read.json) outcome = read.json.is_error ? 'erro' : 'ok';
      else outcome = stillRunning ? 'em-andamento' : 'saída-inesperada';
    }
    const metrics = metricsFrom(read.json);
    const startedAt = entry?.startedAt ?? meta.startedAt;
    // tempo de relógio: do registro; sem ele, até a última gravação do log (feita ao fim da execução)
    let endedAt = entry?.endedAt ?? null;
    if (!endedAt && read.json) { try { endedAt = statSync(file).mtime.toISOString(); } catch { /* sem data */ } }
    runs.push({
      project: entry?.project ?? project,
      role: meta.role,
      number: meta.number,
      task: entry?.task ?? meta.number,
      title: entry?.title ?? null,
      isPr: entry?.isPr ?? null,
      requestedModel: entry?.model ?? null,
      effort: entry?.effort ?? null,
      startedAt,
      endedAt,
      outcome,
      source,
      logFile: file,
      ...metrics,
      durationMs: endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : metrics.durationMs,
    });
  }
  // execuções que falharam antes de criar o log
  for (const e of noLog) {
    if (localDay(e.startedAt) !== day) continue;
    runs.push({ ...e, task: e.task ?? e.number, requestedModel: e.model ?? null, source: 'despachante', ...metricsFrom(null) });
  }
  return runs.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

const FAILURES = new Set(['erro', 'timeout', 'saída-inesperada', 'falha-ao-iniciar']);

function addTotals(acc, r) {
  acc.runs++;
  acc.durationMs += r.durationMs ?? 0;
  acc.turns += r.turns ?? 0;
  acc.costUsd += r.costUsd ?? 0;
  for (const k of Object.keys(acc.tokens)) acc.tokens[k] += r.tokens?.[k] ?? 0;
  acc.outcomes[r.outcome] = (acc.outcomes[r.outcome] ?? 0) + 1;
  return acc;
}

const emptyTotals = () => ({ runs: 0, durationMs: 0, turns: 0, costUsd: 0, tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 }, outcomes: {} });

/**
 * Junta issue e PR na mesma tarefa: a execução num PR passa a contar para a issue que ele fecha
 * (`items`: "projeto#n" → { linked: [issues] }, vindo do GitHub) (função pura; testada).
 */
export function linkTasks(runs, items) {
  return runs.map((r) => {
    const linked = items.get(`${r.project}#${r.number}`)?.linked?.[0];
    return linked && (r.task == null || r.task === r.number) ? { ...r, task: linked } : r;
  });
}

/** "concluída" se algum item da tarefa fechou ou tem a etiqueta de pronto; null sem informação (testada). */
export function taskStatus(task, items, doneLabel) {
  const known = [task.task, ...task.items].map((n) => items.get(`${task.project}#${n}`)).filter(Boolean);
  if (!known.length) return null;
  return known.some((i) => i.state === 'closed' || (doneLabel && i.labels.includes(doneLabel))) ? 'concluída' : 'em andamento';
}

/** "claude-sonnet-5-5" → "sonnet"; execução com mais de um modelo vira "opus+haiku" (testada). */
export function modelLabel(run) {
  const short = (id) => /claude-([a-z]+)/.exec(id)?.[1] ?? id;
  const names = run.models?.length ? run.models : run.requestedModel ? [run.requestedModel] : [];
  return names.length ? [...new Set(names.map(short))].join('+') : '—';
}

/** Totais do dia, por função, projeto, modelo e tarefa (issue + PRs que a fecham), e as falhas (função pura; testada). */
export function summarize(runs) {
  const totals = emptyTotals();
  const byRole = {};
  const byProject = {};
  const byModel = {};
  const byTask = {};
  for (const r of runs) {
    addTotals(totals, r);
    addTotals(byRole[r.role] ??= emptyTotals(), r);
    addTotals(byProject[r.project] ??= emptyTotals(), r);
    addTotals(byModel[modelLabel(r)] ??= emptyTotals(), r);
    const t = byTask[`${r.project}#${r.task ?? r.number}`] ??= { ...emptyTotals(), project: r.project, task: r.task ?? r.number, title: null, items: [], roles: [], status: null };
    addTotals(t, r);
    t.title ??= r.title;
    if (!t.items.includes(r.number)) t.items.push(r.number);
    t.roles.push(r.role);
  }
  const finished = runs.filter((r) => r.durationMs != null).length;
  totals.avgDurationMs = finished ? Math.round(totals.durationMs / finished) : 0;
  totals.tokens.total = totals.tokens.input + totals.tokens.cacheWrite + totals.tokens.cacheRead + totals.tokens.output;
  totals.failures = runs.filter((r) => FAILURES.has(r.outcome)).length;
  return { totals, byRole, byProject, byModel, byTask, failures: runs.filter((r) => FAILURES.has(r.outcome)) };
}
