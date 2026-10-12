import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeMachineConfig } from './config.mjs';
import { autoPrompt, lanePorts, normalizeProjectConfig } from './project.mjs';

const base = {
  id: 'tablehub',
  repo: 'guilanfredi/tablehub',
  owner: 'guilanfredi',
  bot: { login: 'gui-dev-bot', email: 'bot@users.noreply.github.com' },
  labels: { working: 'agente:trabalhando', waiting: 'aguardando-dono' },
  roles: [{ name: 'dev', label: 'fase:dev', timeoutMin: 120 }],
  ports: { TABLEHUB_WEB_PORT: 5200, TABLEHUB_WORKER_PORT: 8800 },
  addDirs: ['manuals'],
};
const where = { path: resolve('/dev/TableHub'), branch: 'main' };

describe('configuração do projeto (.agents/config.json)', () => {
  it('completa os valores padrão e resolve caminhos a partir do projeto', () => {
    const p = normalizeProjectConfig(base, where);
    expect(p.roles).toEqual([{ name: 'dev', label: 'fase:dev', timeoutMin: 120, prOnly: false }]);
    expect(p.worktreesDir).toBe(resolve('/dev/tablehub-agents'));
    expect(p.addDirs).toEqual([resolve('/dev/TableHub/manuals')]);
    expect(p.maxPerRole).toEqual({});
    expect(normalizeProjectConfig({ ...base, worktreesDir: '../TableHub-agents' }, where).worktreesDir).toBe(resolve('/dev/TableHub-agents'));
  });

  it('rejeita configuração incompleta explicando o que falta', () => {
    expect(() => normalizeProjectConfig({ ...base, id: 'Table Hub' }, where)).toThrow(/"id"/);
    expect(() => normalizeProjectConfig({ ...base, roles: [] }, where)).toThrow(/"roles"/);
    expect(() => normalizeProjectConfig({ ...base, roles: [{ name: 'dev', label: 'x' }] }, where)).toThrow(/timeoutMin/);
    expect(() => normalizeProjectConfig({ ...base, ports: { web: 5200 } }, where)).toThrow(/porta web/);
    expect(() => normalizeProjectConfig({ ...base, bot: { login: 'x' } }, where)).toThrow(/"bot"/);
  });

  it('calcula as portas da faixa somando o número da faixa à base', () => {
    const p = normalizeProjectConfig(base, where);
    expect(lanePorts(p, 2)).toEqual({ TABLEHUB_WEB_PORT: 5202, TABLEHUB_WORKER_PORT: 8802 });
  });

  it('monta as instruções do modo automático com portas, pastas e o texto do projeto', () => {
    const p = normalizeProjectConfig(base, where);
    const text = autoPrompt(p, { TABLEHUB_WEB_PORT: 5201 }, 'Use Playwright.\n');
    expect(text).toContain('@guilanfredi');
    expect(text).toContain("'aguardando-dono'");
    expect(text).toContain('TABLEHUB_WEB_PORT=5201');
    expect(text).toContain(resolve('/dev/TableHub/manuals'));
    expect(text.trimEnd().endsWith('Use Playwright.')).toBe(true);
  });
});

describe('configuração da máquina (config.local.json)', () => {
  it('aceita caminhos simples ou objetos e aplica padrões', () => {
    const c = normalizeMachineConfig({ projects: ['/dev/TableHub', { path: '/dev/outro', branch: 'trunk' }] });
    expect(c).toEqual({
      maxTotal: 3, pollSeconds: 15,
      projects: [{ path: resolve('/dev/TableHub'), branch: 'main' }, { path: resolve('/dev/outro'), branch: 'trunk' }],
    });
  });

  it('rejeita valores inválidos', () => {
    expect(() => normalizeMachineConfig({ projects: [] })).toThrow(/projects/);
    expect(() => normalizeMachineConfig({ projects: ['/x'], maxTotal: 0 })).toThrow(/maxTotal/);
    expect(() => normalizeMachineConfig({ projects: ['/x'], pollSeconds: 1 })).toThrow(/pollSeconds/);
  });
});
