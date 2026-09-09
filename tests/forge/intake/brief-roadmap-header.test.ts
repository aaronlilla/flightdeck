import { describe, expect, it } from 'vitest';

import { roadmapFromBrief } from '../../../src/forge/intake/repoRoute.js';

// R-02 guard #1: a brief for the self repo names the roadmap item it is doing with a
// `roadmap: R-nn` line, the same first-twenty-lines header shape `repoFromBrief` uses.
describe('roadmapFromBrief', () => {
  it('reads a roadmap line anywhere in the first twenty lines, any case, any spacing', () => {
    expect(roadmapFromBrief(['# Goal: x', '', 'roadmap: R-02', ''].join('\n'))).toBe('R-02');
    expect(roadmapFromBrief(['Roadmap :  R-09  ', 'body'].join('\n'))).toBe('R-09');
  });

  it('returns null without a line, and for a value that is not R-nn', () => {
    expect(roadmapFromBrief(['# Goal: x', '', 'no header here'].join('\n'))).toBeNull();
    expect(roadmapFromBrief('roadmap: r-02')).toBeNull();
    expect(roadmapFromBrief('roadmap: R-2')).toBeNull();
    expect(roadmapFromBrief('roadmap: foo')).toBeNull();
  });

  it('ignores a roadmap line past the first twenty lines', () => {
    const late = `${'x\n'.repeat(25)}roadmap: R-02\n`;
    expect(roadmapFromBrief(late)).toBeNull();
  });
});
