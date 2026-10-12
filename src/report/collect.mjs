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

/** Métricas do JSON de saída do `claude -p --output-format json` (função pura; testada). */
export function metricsFrom(result) {
  const u = result?.usage ?? {};
  return {
    durationMs: result?.duration_ms ?? null,
    apiMs: result?.duration_api_ms ?? null,
    turns: result?.num_turns ?? null,
    costUsd: result?.total_cost_usd ?? null,
    tokens: {
      input: u.input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      thinking: u.output_tokens_details?.thinking_tokens ?? 0,
    },
    models: Object.keys(result?.modelUsage ?? {}),
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
      .filter((j) => j.logFile).map((j) => keyOf(j.logFile)),
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
      const stillRunning = runningLogs.has(key) || legacyRunning.some((l) => l.project === project && l.role === meta.role && l.number === meta.number);
      if (read.json) outcome = read.json.is_error ? 'erro' : 'ok';
      else outcome = stillRunning ? 'em-andamento' : 'saída-inesperada';
    }
    runs.push({
      project: entry?.project ?? project,
      role: meta.role,
      number: meta.number,
      title: entry?.title ?? null,
      isPr: entry?.isPr ?? null,
      startedAt: entry?.startedAt ?? meta.startedAt,
      endedAt: entry?.endedAt ?? null,
      outcome,
      source,
      logFile: file,
      ...metricsFrom(read.json),
    });
  }
  // execuções que falharam antes de criar o log
  for (const e of noLog) {
    if (localDay(e.startedAt) !== day) continue;
    runs.push({ ...e, source: 'despachante', ...metricsFrom(null) });
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

/** Totais do dia, por função e por projeto, e a lista de falhas (função pura; testada). */
export function summarize(runs) {
  const totals = emptyTotals();
  const byRole = {};
  const byProject = {};
  for (const r of runs) {
    addTotals(totals, r);
    addTotals(byRole[r.role] ??= emptyTotals(), r);
    addTotals(byProject[r.project] ??= emptyTotals(), r);
  }
  const finished = runs.filter((r) => r.durationMs != null).length;
  totals.avgDurationMs = finished ? Math.round(totals.durationMs / finished) : 0;
  totals.tokens.total = totals.tokens.input + totals.tokens.cacheWrite + totals.tokens.cacheRead + totals.tokens.output;
  totals.failures = runs.filter((r) => FAILURES.has(r.outcome)).length;
  return { totals, byRole, byProject, failures: runs.filter((r) => FAILURES.has(r.outcome)) };
}
