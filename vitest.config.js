import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.js'],
    // vitest's default include glob doesn't respect .gitignore, so without this a git
    // worktree nested under this repo (e.g. .worktrees/<branch>/) gets its own copy of
    // every test file picked up and run a second time alongside the real one.
    exclude: ['**/node_modules/**', '**/.worktrees/**'],
  },
});
