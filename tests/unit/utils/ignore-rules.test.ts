// ignore-rules tests: the four-layer classification gate (sensitive denylist,
// user excludes, .gitignore, optional include allowlist).

import { describe, expect, it } from 'vitest';
import { createIgnoreMatcher } from '../../../src/utils/ignore-rules.js';

const ROOT = '/project';

describe('createIgnoreMatcher', () => {
  it('flags .env as a sensitive_file', () => {
    const m = createIgnoreMatcher({ projectRoot: ROOT, include: [], exclude: [] });
    const c = m.classify('.env');
    expect(c.included).toBe(false);
    expect(c.skipReason).toBe('sensitive_file');
  });

  it('flags a *.pem file as sensitive_file', () => {
    const m = createIgnoreMatcher({ projectRoot: ROOT, include: [], exclude: [] });
    const c = m.classify('server.pem');
    expect(c.included).toBe(false);
    expect(c.skipReason).toBe('sensitive_file');
  });

  it('excludes a path under an excluded directory', () => {
    const m = createIgnoreMatcher({
      projectRoot: ROOT,
      include: [],
      exclude: ['node_modules'],
    });
    const c = m.classify('node_modules/x');
    expect(c.included).toBe(false);
    expect(c.skipReason).toBe('excluded');
  });

  it('includes a normal source path when nothing matches', () => {
    const m = createIgnoreMatcher({
      projectRoot: ROOT,
      include: [],
      exclude: ['node_modules'],
    });
    const c = m.classify('src/index.ts');
    expect(c.included).toBe(true);
    expect(c.skipReason).toBeUndefined();
  });

  it('respects a .gitignore line', () => {
    const m = createIgnoreMatcher({
      projectRoot: ROOT,
      include: [],
      exclude: [],
      gitignoreContent: 'dist/\n*.log\n',
    });
    expect(m.classify('dist/bundle.js').skipReason).toBe('gitignored');
    expect(m.classify('debug.log').skipReason).toBe('gitignored');
    // A path not covered by .gitignore still passes.
    expect(m.classify('src/index.ts').included).toBe(true);
  });

  it('marks paths outside the include allowlist as not_included', () => {
    const m = createIgnoreMatcher({
      projectRoot: ROOT,
      include: ['src'],
      exclude: [],
    });
    expect(m.classify('src/index.ts').included).toBe(true);
    const c = m.classify('docs/readme.md');
    expect(c.included).toBe(false);
    expect(c.skipReason).toBe('not_included');
  });

  it('applies precedence: sensitive denylist wins over excludes', () => {
    const m = createIgnoreMatcher({
      projectRoot: ROOT,
      include: [],
      exclude: ['.env'],
    });
    // Even though .env is also user-excluded, the sensitive reason takes priority.
    expect(m.classify('.env').skipReason).toBe('sensitive_file');
  });

  it('isExcludedDir prunes excluded and sensitive directories only', () => {
    const m = createIgnoreMatcher({
      projectRoot: ROOT,
      include: [],
      exclude: ['node_modules'],
      gitignoreContent: 'dist/\n',
    });
    expect(m.isExcludedDir('node_modules')).toBe(true);
    expect(m.isExcludedDir('node_modules/sub')).toBe(true);
    expect(m.isExcludedDir('src')).toBe(false);
    // gitignore is NOT used for directory pruning (negation safety).
    expect(m.isExcludedDir('dist')).toBe(false);
    expect(m.isExcludedDir('')).toBe(false);
  });
});
