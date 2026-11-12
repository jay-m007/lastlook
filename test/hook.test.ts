import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, cleanup } from "./helpers.ts";

after(cleanup);

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

const hasScript = (() => { try { execFileSync("which", ["script"], { stdio: "ignore" }); return true; } catch { return false; } })();

/**
 * Runs an interactive bash with the hook loaded, inside a pseudo-terminal, and types the given
 * lines at it. A pty is needed because the hook reads the answer from /dev/tty, exactly as it
 * does for a real person.
 */
function inShell(root: string, lines: string[]): string {
  const shim = join(root, "lastlook");
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
  execFileSync("chmod", ["+x", shim]);
  const script = [
    `export PATH="${root}:$PATH"`,
    `export LASTLOOK_MODEL=off NO_COLOR=1 LASTLOOK_CWD="${root}"`,
    `cd "${root}"`,
    `eval "$(lastlook hook bash)"`,
    ...lines,
    "exit",
  ].join("\n") + "\n";
  return execFileSync("script", ["-qec", "bash --norc -i", "/dev/null"], { input: script, encoding: "utf8", timeout: 60_000, env: { ...process.env, TERM: "dumb" }, stdio: ["pipe", "pipe", "pipe"] });
}

/** A repo where deleting keep.ts is worth asking about: it has changes that are not committed. */
const blockable = () => makeRepo({ committed: { "keep.ts": "a" }, modified: { "keep.ts": "changed, not committed" } });

test("the bash hook stops a command when the answer is no, and the file survives", { skip: !hasScript && "no script(1) to allocate a pty" }, () => {
  const root = blockable();
  // Pressing enter at the prompt cancels, so an empty line follows the command.
  const out = inShell(root, ["rm keep.ts", "", "echo MARKER-DONE"]);
  assert.match(out, /\[enter\] cancel/, `the hook never asked. output was:\n${out}`);
  assert.match(out, /cancelled/, `the answer was not taken as a no. output was:\n${out}`);
  assert.ok(existsSync(join(root, "keep.ts")), `the file was deleted even though the answer was no. output was:\n${out}`);
  assert.match(out, /MARKER-DONE/, "the shell must carry on after a cancelled command");
});

test("the bash hook lets the command through when the answer is yes", { skip: !hasScript && "no script(1) to allocate a pty" }, () => {
  const root = blockable();
  const out = inShell(root, ["rm keep.ts", "y", "echo MARKER-DONE"]);
  assert.ok(!existsSync(join(root, "keep.ts")), `answering yes did not run the command. output was:\n${out}`);
});

test("a note is printed but never interrupts", { skip: !hasScript && "no script(1) to allocate a pty" }, () => {
  // One untracked file is worth a line, not a question.
  const root = makeRepo({ committed: { "keep.ts": "a" }, untracked: { "junk/a.txt": "1" } });
  const out = inShell(root, ["rm -rf junk", "echo MARKER-DONE"]);
  assert.match(out, /not in git/, `the note was not shown. output was:\n${out}`);
  assert.ok(!/\[enter\] cancel/.test(out), "a note must not ask a question");
  assert.ok(!existsSync(join(root, "junk", "a.txt")), "a note must not block the command");
});

test("a harmless command is never interrupted", { skip: !hasScript && "no script(1) to allocate a pty" }, () => {
  const root = makeRepo({ committed: { "keep.ts": "a" } });
  const out = inShell(root, ["echo HELLO-FROM-SHELL"]);
  assert.match(out, /HELLO-FROM-SHELL/);
  assert.ok(!/\[enter\] cancel/.test(out), "a harmless command should not ask anything");
});

test("a line starting with a space skips the check", { skip: !hasScript && "no script(1) to allocate a pty" }, () => {
  const root = blockable();
  const out = inShell(root, [" rm keep.ts", "echo MARKER-DONE"]);
  assert.ok(!/\[enter\] cancel/.test(out), `the leading-space escape hatch did not work. output was:\n${out}`);
  assert.ok(!existsSync(join(root, "keep.ts")), "the command should have run unchecked");
});

test("lastlook-off turns the check off for the shell", { skip: !hasScript && "no script(1) to allocate a pty" }, () => {
  const root = blockable();
  const out = inShell(root, ["lastlook-off", "rm keep.ts", "echo MARKER-DONE"]);
  assert.ok(!/\[enter\] cancel/.test(out), `lastlook-off did not disable the hook. output was:\n${out}`);
  assert.ok(!existsSync(join(root, "keep.ts")), "the command should have run unchecked");
});
