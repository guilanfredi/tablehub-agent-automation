#!/usr/bin/env node
/**
 * Hook do monitor de instâncias do Claude Code.
 *
 * Registrado nas configurações do usuário (~/.claude/settings.json) pelo `install.mjs`, roda em TODA
 * instância da máquina — app desktop, terminal e as sessões `claude -p` do despachante. Recebe o evento
 * em JSON pela entrada padrão e grava o estado da sessão em ~/.claude/monitor/sessions/<session_id>.json.
 *
 * Nunca bloqueia nem atrapalha a sessão: não escreve nada na saída e sempre sai com código 0.
 * Este arquivo é copiado para ~/.claude/monitor/ na instalação, então não pode importar nada do repositório.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MONITOR_DIR = process.env.CLAUDE_MONITOR_DIR || join(homedir(), '.claude', 'monitor');
export const SESSIONS_DIR = join(MONITOR_DIR, 'sessions');

const MAX_RECENT_TOOLS = 5;
const PID_RETRY_MS = 60_000;

function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Resumo curto da chamada de ferramenta ("Bash: npm test", "Edit: Board.tsx"). */
export function summarizeTool(name, input = {}) {
  const i = input ?? {};
  let detail = '';
  if (name === 'Bash' || name === 'PowerShell') detail = i.description || i.command;
  else if (i.file_path) detail = win32.basename(String(i.file_path)); // win32 aceita "\" e "/" em qualquer SO
  else if (name === 'Skill') detail = i.skill;
  else if (name === 'Agent' || name === 'Task') detail = i.description;
  else if (name === 'Grep' || name === 'Glob') detail = i.pattern;
  else if (i.url) detail = i.url;
  return detail ? `${name}: ${clip(detail, 80)}` : name;
}

/** Aplica um evento de hook ao estado anterior da sessão (função pura; testada). */
export function applyEvent(prev, input, now, env = {}) {
  const s = prev ? { ...prev } : {
    sessionId: input.session_id,
    startedAt: now,
    recentTools: [],
  };
  s.lastEventAt = now;
  s.lastEvent = input.hook_event_name;
  if (input.cwd) s.cwd = input.cwd;
  if (input.transcript_path) s.transcriptPath = input.transcript_path;
  if (input.permission_mode) s.permissionMode = input.permission_mode;
  // definidas pelo despachante; TABLEHUB_AGENT é o nome antigo (versão que ficava dentro do TableHub)
  const task = env.CLAUDE_AGENT_TASK || env.TABLEHUB_AGENT;
  if (task) s.agent = task;
  if (env.CLAUDE_AGENT_PROJECT) s.project = env.CLAUDE_AGENT_PROJECT;
  if (env.CLAUDE_CODE_ENTRYPOINT) s.entrypoint = env.CLAUDE_CODE_ENTRYPOINT;

  switch (input.hook_event_name) {
    case 'SessionStart':
      s.state = 'iniciando';
      s.source = input.source;
      if (input.source === 'clear' || input.source === 'compact') s.state = 'ocioso';
      delete s.endedAt;
      break;
    case 'UserPromptSubmit':
      s.state = 'pensando';
      s.lastPrompt = clip(input.prompt, 140);
      s.turnStartedAt = now;
      delete s.currentTool;
      delete s.message;
      break;
    case 'PreToolUse': {
      const tool = summarizeTool(input.tool_name, input.tool_input);
      s.state = 'executando';
      s.currentTool = tool;
      s.toolStartedAt = now;
      s.recentTools = [tool, ...(s.recentTools ?? [])].slice(0, MAX_RECENT_TOOLS);
      s.toolCount = (s.toolCount ?? 0) + 1;
      delete s.message;
      break;
    }
    case 'PostToolUse':
      s.state = 'pensando';
      delete s.currentTool;
      delete s.toolStartedAt;
      break;
    case 'Notification':
      // aviso de permissão pendente ou de sessão parada esperando resposta
      s.state = 'aguardando';
      s.message = clip(input.message, 140);
      break;
    case 'Stop':
      s.state = 'ocioso';
      delete s.currentTool;
      delete s.toolStartedAt;
      delete s.message;
      break;
    case 'SessionEnd':
      s.state = 'encerrada';
      s.endReason = input.reason;
      s.endedAt = now;
      delete s.currentTool;
      break;
  }
  return s;
}

/** PID do processo claude.exe que disparou o hook (o hook roda sob um shell intermediário). */
export function findClaudePid() {
  if (process.platform !== 'win32') {
    let pid = process.ppid;
    for (let i = 0; i < 6 && pid > 1; i++) {
      const out = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim();
      const [ppid, ...comm] = out.split(/\s+/);
      if (/claude/i.test(comm.join(' '))) return pid;
      pid = Number(ppid);
    }
    return null;
  }
  const out = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$($_.Name)" }',
  ], { encoding: 'utf8', timeout: 6000, windowsHide: true });
  const procs = new Map();
  for (const line of out.split(/\r?\n/)) {
    const [pid, ppid, name] = line.split(',');
    if (pid) procs.set(Number(pid), { ppid: Number(ppid), name: (name || '').toLowerCase() });
  }
  let pid = process.ppid;
  for (let i = 0; i < 8 && procs.has(pid); i++) {
    const p = procs.get(pid);
    if (p.name === 'claude.exe' || p.name === 'claude') return pid;
    pid = p.ppid;
  }
  return null;
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  // no Windows o rename falha se o painel estiver lendo o arquivo naquele instante
  for (let i = 0; i < 5; i++) {
    try { renameSync(tmp, file); return; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30); }
  }
  writeFileSync(file, JSON.stringify(data, null, 2));
}

function main() {
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { return; }
  const input = JSON.parse(raw);
  if (!input.session_id || !/^[\w-]+$/.test(input.session_id)) return;

  mkdirSync(SESSIONS_DIR, { recursive: true });
  const file = join(SESSIONS_DIR, `${input.session_id}.json`);
  const now = new Date().toISOString();
  const s = applyEvent(readJson(file), input, now, process.env);

  if (!s.claudePid && Date.now() - Date.parse(s.pidLookupAt ?? 0) > PID_RETRY_MS) {
    s.pidLookupAt = now;
    try { s.claudePid = findClaudePid() ?? undefined; } catch { /* tenta de novo depois */ }
  }
  writeAtomic(file, s);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (e) {
    // o monitor nunca derruba a sessão; CLAUDE_MONITOR_DEBUG=1 mostra o erro para diagnóstico
    if (process.env.CLAUDE_MONITOR_DEBUG) console.error(e);
  }
  process.exit(0);
}
