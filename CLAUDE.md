# lastlook

A shell safety net: reads a command before it runs, works out what it would really touch, and asks
or stops when it cannot be undone. Explanations come from a local Ollama model; decisions never do.

## Commands
- `npm test`: offline test suite (node:test; real git repos in temp folders, a real pty for the hook)
- `npm run typecheck`: `tsc --noEmit`
- `node src/cli.ts check -- '<command>'`: review one command (Node 22.18+ runs .ts directly)
- `npm run eval`: measure the real model's latency, invented figures and unknown-program judgement

## Code rules
- TypeScript run by Node's type stripping: no enums, namespaces or constructor parameter properties; use `import type` for types; relative imports end in `.ts`.
- Zero runtime dependencies. Use node: built-ins only. The shell hooks in `hooks/` are plain shell.
- A rule may only report what it can establish from the filesystem, git or the environment. If a path or value cannot be known before the command runs, say so and raise the severity; never guess.
- The model can only ever add a note. It can never raise a severity, clear a finding, or decide anything. Every argument it quotes must be checked against the command line before it is shown.
- The model gets a fact sheet only: never file contents, never the environment.
- Never let lastlook block the shell on its own failure: a crash or a slow model lets the command through, with a line saying so.
- Add a test for every new rule, and add it to the table in the README.
- Never print or log a password, token or connection string: database rules show the host only.

## Git
- Commits are authored as Jay Maurya <maurya67jay@gmail.com>. Do not add co-author or "generated with" lines to commits or pull requests.
