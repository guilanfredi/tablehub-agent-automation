#!/usr/bin/env node
/**
 * Instala (ou remove, com --remover) os hooks do monitor nas configurações do USUÁRIO
 * (~/.claude/settings.json), para que valham em todas as instâncias do Claude Code da máquina.
 *
 *   npm run monitor:instalar     instala/atualiza
 *   npm run monitor:remover      remove os hooks (mantém os dados)
 *
 * O hook é copiado para ~/.claude/monitor/hook.mjs: assim ele não depende de qual branch está
 * aberta no repositório. Rode de novo sempre que o hook.mjs mudar.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'];
const WITH_MATCHER = new Set(['PreToolUse', 'PostToolUse']);
const MARKER = '.claude/monitor/hook.mjs';

const remove = process.argv.includes('--remover');
const claudeDir = join(homedir(), '.claude');
const monitorDir = join(claudeDir, 'monitor');
const settingsFile = join(claudeDir, 'settings.json');
const hookDest = join(monitorDir, 'hook.mjs');

const toPosix = (p) => p.replaceAll('\\', '/');

let settings = {};
if (existsSync(settingsFile)) {
  const text = readFileSync(settingsFile, 'utf8');
  try { settings = JSON.parse(text); } catch {
    console.error(`Não consegui ler ${settingsFile} (JSON inválido). Corrija o arquivo e rode de novo.`);
    process.exit(1);
  }
  writeFileSync(`${settingsFile}.bak`, text);
}

// remove entradas antigas do monitor sem tocar em outros hooks do usuário
const hooks = settings.hooks ?? {};
for (const event of Object.keys(hooks)) {
  hooks[event] = (hooks[event] ?? [])
    .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((h) => !String(h.command ?? '').includes(MARKER)) }))
    .filter((group) => group.hooks.length > 0);
  if (hooks[event].length === 0) delete hooks[event];
}

if (!remove) {
  mkdirSync(join(monitorDir, 'sessions'), { recursive: true });
  copyFileSync(join(dirname(fileURLToPath(import.meta.url)), 'hook.mjs'), hookDest);
  // caminho absoluto do node: o app desktop nem sempre herda o PATH do terminal
  const command = `"${toPosix(process.execPath)}" "${toPosix(hookDest)}"`;
  for (const event of EVENTS) {
    const entry = { type: 'command', command, timeout: event === 'SessionStart' ? 10 : 5 };
    const group = WITH_MATCHER.has(event) ? { matcher: '*', hooks: [entry] } : { hooks: [entry] };
    hooks[event] = [...(hooks[event] ?? []), group];
  }
}

if (Object.keys(hooks).length) settings.hooks = hooks; else delete settings.hooks;
mkdirSync(claudeDir, { recursive: true });
writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');

if (remove) {
  console.log(`Hooks do monitor removidos de ${settingsFile}.`);
} else {
  console.log(`Hooks do monitor instalados em ${settingsFile} (cópia anterior: settings.json.bak).`);
  console.log(`Hook: ${hookDest}`);
  console.log('Sessões já abertas costumam aparecer no próximo evento; se alguma não aparecer, reinicie-a.');
  console.log('Veja o painel com: npm run agentes');
}
