import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'cli/index': 'src/cli/index.ts',
  },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  shims: false,
  external: ['better-sqlite3'],
  banner: {
    js: '#!/usr/bin/env node',
  },
});
