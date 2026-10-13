/**
 * Configuração da máquina (config.local.json): projetos atendidos, paralelismo e intervalo de consulta.
 * O que é de cada projeto (repositório, funções, portas…) fica no próprio projeto, em .agents/config.json.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_EXTRA_USAGE, normalizeExtraUsage } from './budget.mjs';

export const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const STATE_DIR = join(APP_DIR, 'state');
export const LOG_DIR = join(APP_DIR, 'logs');
export const LOCAL_CONFIG = join(APP_DIR, 'config.local.json');

/** Execução que termina sem avançar a fase: espera antes de tentar de novo; depois de N vezes, chama o dono. */
export const RETRY_COOLDOWN_MIN = 10;
export const MAX_RUNS_WITHOUT_PROGRESS = 3;

/** Configurações dos projetos são relidas (com git fetch) a cada intervalo. */
export const PROJECT_REFRESH_MIN = 10;

/** Valida e completa a configuração da máquina (função pura; testada). */
export function normalizeMachineConfig(raw) {
  const errors = [];
  const projects = (raw?.projects ?? []).map((p) => (typeof p === 'string' ? { path: p } : p));
  if (!projects.length) errors.push('"projects" precisa listar ao menos um projeto (caminho da cópia principal).');
  for (const p of projects) if (!p?.path) errors.push('cada projeto precisa de "path".');
  const maxTotal = raw?.maxTotal ?? 3;
  const pollSeconds = raw?.pollSeconds ?? 15;
  if (!(Number.isInteger(maxTotal) && maxTotal >= 1)) errors.push('"maxTotal" precisa ser um inteiro ≥ 1.');
  if (!(pollSeconds >= 5)) errors.push('"pollSeconds" precisa ser ≥ 5.');
  let extraUsage = DEFAULT_EXTRA_USAGE;
  try { extraUsage = normalizeExtraUsage(raw?.extraUsage); } catch (e) { errors.push(e.message); }
  if (errors.length) throw new Error(`config.local.json inválido:\n- ${errors.join('\n- ')}`);
  return { maxTotal, pollSeconds, extraUsage, projects: projects.map((p) => ({ path: resolve(p.path), branch: p.branch ?? 'main' })) };
}

export function loadMachineConfig() {
  if (!existsSync(LOCAL_CONFIG)) {
    throw new Error(`Falta ${LOCAL_CONFIG}. Copie config.example.json para config.local.json e ajuste os caminhos dos projetos.`);
  }
  return normalizeMachineConfig(JSON.parse(readFileSync(LOCAL_CONFIG, 'utf8')));
}

/**
 * Política de créditos atual, relida do arquivo a cada chamada (vale na hora, sem reiniciar o despachante).
 * Arquivo ausente ou inválido → { policy: padrão (créditos desligados), error }.
 */
export function readExtraUsagePolicy() {
  try {
    return { policy: normalizeExtraUsage(JSON.parse(readFileSync(LOCAL_CONFIG, 'utf8')).extraUsage) };
  } catch (e) {
    return { policy: DEFAULT_EXTRA_USAGE, error: e.code === 'ENOENT' ? 'config.local.json ausente' : e.message };
  }
}
