#!/usr/bin/env node
/**
 * Relatório das execuções dos agentes num dia, com os limites atuais da assinatura.
 *
 *   npm run relatorio                      hoje, no terminal
 *   npm run relatorio -- --ontem           ontem
 *   npm run relatorio -- --data 2026-10-12 um dia específico
 *   npm run relatorio -- --markdown        em Markdown (para colar ou publicar)
 *   npm run relatorio -- --json            dados brutos (para scripts e tarefas agendadas)
 */
import { execFileSync } from 'node:child_process';
import { LOG_DIR, STATE_DIR, loadMachineConfig } from '../dispatcher/config.mjs';
import { fetchUsage } from '../usage.mjs';
import { loadRuns, localDay, summarize } from './collect.mjs';
import { toMarkdown, toText } from './render.mjs';

const argv = process.argv.slice(2);
const argValue = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

let day = localDay(new Date().toISOString());
if (argv.includes('--ontem')) day = localDay(new Date(Date.now() - 86_400_000).toISOString());
if (argValue('--data')) {
  day = argValue('--data');
  const [y, m, d] = day.split('-').map(Number);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || localDay(new Date(y, m - 1, d).toISOString()) !== day) {
    console.error('Use --data AAAA-MM-DD com uma data válida.');
    process.exit(2);
  }
}

let projects = [];
try { projects = loadMachineConfig().projects; } catch (e) { console.error(`AVISO: ${e.message.split('\n')[0]}`); }

/** id → "dono/repositório", lido do .agents/config.json de cada projeto (para os links do Markdown). */
function projectRepos() {
  const repos = {};
  for (const p of projects) {
    try {
      const cfg = JSON.parse(execFileSync('git', ['-C', p.path, 'show', `origin/${p.branch}:.agents/config.json`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }));
      if (cfg.id && cfg.repo) repos[cfg.id] = cfg.repo;
    } catch { /* sem link para esse projeto */ }
  }
  return repos;
}

const runs = loadRuns({ day, stateDir: STATE_DIR, logDir: LOG_DIR, projectPaths: projects.map((p) => p.path) });
const summary = summarize(runs);
const usage = await fetchUsage();

if (argv.includes('--json')) {
  console.log(JSON.stringify({ day, generatedAt: new Date().toISOString(), limits: usage.usage ?? null, limitsError: usage.error ?? null, summary: { ...summary, failures: undefined }, runs }, null, 2));
} else if (argv.includes('--markdown')) {
  process.stdout.write(toMarkdown({ day, runs, summary, usage, repos: projectRepos() }));
} else {
  console.log(toText({ day, runs, summary, usage, color: process.stdout.isTTY }));
}
