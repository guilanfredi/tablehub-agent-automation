import { describe, expect, it } from 'vitest';
import { applyEvent, summarizeTool } from './hook.mjs';

const base = { session_id: 'abc-123', cwd: 'D:\\dev\\TableHub', transcript_path: 'x.jsonl' };
const ev = (hook_event_name, extra = {}) => ({ ...base, hook_event_name, ...extra });

describe('monitor: hook', () => {
  it('resume ferramentas', () => {
    expect(summarizeTool('Bash', { command: 'npm test', description: 'Roda os testes' })).toBe('Bash: Roda os testes');
    expect(summarizeTool('Edit', { file_path: 'D:\\x\\Board.tsx' })).toBe('Edit: Board.tsx');
    expect(summarizeTool('Skill', { skill: 'dev' })).toBe('Skill: dev');
    expect(summarizeTool('TodoWrite', {})).toBe('TodoWrite');
    expect(summarizeTool('Bash', { command: 'x'.repeat(200) })).toHaveLength(86);
  });

  it('acompanha o ciclo de vida da sessão', () => {
    let s = applyEvent(null, ev('SessionStart', { source: 'startup' }), 't0', { CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_AGENT_TASK: 'dev 10', CLAUDE_AGENT_PROJECT: 'tablehub' });
    expect(s).toMatchObject({ sessionId: 'abc-123', state: 'iniciando', startedAt: 't0', entrypoint: 'cli', agent: 'dev 10', project: 'tablehub' });

    s = applyEvent(s, ev('UserPromptSubmit', { prompt: '/dev 10' }), 't1');
    expect(s).toMatchObject({ state: 'pensando', lastPrompt: '/dev 10' });

    s = applyEvent(s, ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } }), 't2');
    expect(s).toMatchObject({ state: 'executando', currentTool: 'Bash: npm test', toolStartedAt: 't2' });

    s = applyEvent(s, ev('PostToolUse', { tool_name: 'Bash' }), 't3');
    expect(s.state).toBe('pensando');
    expect(s.currentTool).toBeUndefined();

    s = applyEvent(s, ev('Notification', { message: 'Claude needs your permission to use Bash' }), 't4');
    expect(s).toMatchObject({ state: 'aguardando', message: 'Claude needs your permission to use Bash' });

    s = applyEvent(s, ev('Stop'), 't5');
    expect(s.state).toBe('ocioso');
    expect(s.message).toBeUndefined();

    s = applyEvent(s, ev('SessionEnd', { reason: 'prompt_input_exit' }), 't6');
    expect(s).toMatchObject({ state: 'encerrada', endReason: 'prompt_input_exit', endedAt: 't6', startedAt: 't0' });
    expect(s.recentTools).toEqual(['Bash: npm test']);
  });

  it('guarda só as últimas 5 ferramentas', () => {
    let s = null;
    for (let i = 0; i < 8; i++) s = applyEvent(s, ev('PreToolUse', { tool_name: 'Read', tool_input: { file_path: `f${i}.ts` } }), `t${i}`);
    expect(s.recentTools).toEqual(['Read: f7.ts', 'Read: f6.ts', 'Read: f5.ts', 'Read: f4.ts', 'Read: f3.ts']);
    expect(s.toolCount).toBe(8);
  });
});
