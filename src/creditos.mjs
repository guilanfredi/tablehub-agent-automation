#!/usr/bin/env node
/**
 * Liga/desliga o uso de créditos (uso extra) pelos agentes depois do limite da assinatura.
 * Vale em segundos: o despachante relê a política a cada consulta, sem reiniciar.
 *
 *   npm run creditos                     mostra a política e a situação da cota
 *   npm run creditos -- on               agentes seguem rodando depois do limite (cobra créditos)
 *   npm run creditos -- off              agentes param perto do limite e voltam sozinhos no reset
 *   npm run creditos -- off --parar-em 95   muda a margem (% da sessão de 5 h)
 *
 * Só afeta os agentes do despachante. O uso extra da conta (claude.ai) continua como está,
 * para as suas sessões interativas.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { budgetGate, normalizeExtraUsage } from './dispatcher/budget.mjs';
import { LOCAL_CONFIG } from './dispatcher/config.mjs';
import { fetchUsage, formatMoney, formatReset, staleNote } from './usage.mjs';

const argv = process.argv.slice(2);
const command = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--parar-em');
const stopIdx = argv.indexOf('--parar-em');

let config;
try { config = JSON.parse(readFileSync(LOCAL_CONFIG, 'utf8')); } catch (e) {
  console.error(`Não consegui ler ${LOCAL_CONFIG}: ${e.message}`);
  process.exit(2);
}

let policy;
try { policy = normalizeExtraUsage(config.extraUsage); } catch (e) { console.error(e.message); process.exit(2); }

if (command || stopIdx >= 0) {
  if (command && !['on', 'off'].includes(command)) { console.error('Use: npm run creditos -- on|off [--parar-em <1-100>]'); process.exit(2); }
  const next = { ...policy };
  if (command) next.allowed = command === 'on';
  if (stopIdx >= 0) next.stopAtPercent = Number(argv[stopIdx + 1]);
  try { policy = normalizeExtraUsage(next); } catch (e) { console.error(e.message); process.exit(2); }
  config.extraUsage = policy;
  writeFileSync(LOCAL_CONFIG, `${JSON.stringify(config, null, 2)}\n`);
  console.log('Política salva; o despachante aplica na próxima consulta (até ~15 s).');
}

console.log(policy.allowed
  ? 'Créditos LIGADOS para os agentes: depois do limite, eles seguem rodando e cobram uso extra.'
  : `Créditos desligados para os agentes: param de abrir novos com a sessão em ${policy.stopAtPercent}% (ou o semanal em 100%) e voltam sozinhos no reset.`);

const usage = await fetchUsage();
if (usage.usage) {
  for (const l of usage.usage.limits) console.log(`  ${l.label}: ${Math.round(l.percent)}% · renova ${formatReset(l.resetsAt)}`);
  const x = usage.usage.extra;
  if (x) console.log(`  Uso extra no mês: ${formatMoney(x.used, x.currency)}${x.limit != null ? ` de ${formatMoney(x.limit, x.currency)}` : ''}`);
  if (usage.stale) console.log(`  (${staleNote(usage).slice(3)})`);
} else {
  console.log(`  ${usage.error}`);
}
const gate = budgetGate({ usage: usage.usage, policy });
console.log(gate.allowed
  ? `Agora: pode abrir agentes (${gate.reason}).`
  : `Agora: sem novos agentes (${gate.reason}); volta ${gate.until ? formatReset(gate.until) : 'quando a cota renovar'}.`);
