import { describe, expect, it } from 'vitest';

import { renderToolCall, toolTarget } from '../../src/forge/tool-target.js';

describe('toolTarget', () => {
  it('takes the first line of a shell command, capped', () => {
    expect(toolTarget('Bash', { command: 'npm test\ncd x' })).toBe('npm test');
    expect(toolTarget('Bash', { command: 'x'.repeat(200) })).toHaveLength(100);
  });
  it('takes the file for file tools and the pattern for searches', () => {
    expect(toolTarget('Edit', { file_path: 'src/a.ts', old_string: 'secret' })).toBe('src/a.ts');
    expect(toolTarget('Write', { file_path: 'src/b.ts', content: 'never shown' })).toBe('src/b.ts');
    expect(toolTarget('Grep', { pattern: 'foo' })).toBe('foo');
  });
  it('is undefined when the input names nothing', () => {
    expect(toolTarget('TodoWrite', { todos: [] })).toBeUndefined();
    expect(toolTarget('Read', undefined)).toBeUndefined();
  });
});

describe('renderToolCall', () => {
  it('renders name and target, or the bare name', () => {
    expect(renderToolCall('Bash', 'npm test')).toBe('Bash: npm test');
    expect(renderToolCall('Edit', 'src/a.ts')).toBe('Edit src/a.ts');
    expect(renderToolCall('TodoWrite', undefined)).toBe('TodoWrite');
  });
});
