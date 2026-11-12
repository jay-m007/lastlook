import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { makeRepo, cleanup } from "./helpers.ts";

after(cleanup);
const CLI = join(import.meta.dirname, "..", "src", "cli.ts");
const run = promisify(execFile);

function cli(args: string[], cwd?: string): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd, env: { ...process.env, LASTLOOK_CWD: cwd ?? process.cwd(), NO_COLOR: "1" } });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: (err.stdout ?? "") + (err.stderr ?? ""), code: err.status ?? -1 };
  }
}

test("exit codes say how bad it is: 0 nothing, 10 worth a look, 20 would not undo", () => {
  const root = makeRepo({ committed: { "a.ts": "a" }, untracked: { "junk/x": "1" } });
  assert.equal(cli(["check", "--no-model", "--cwd", root, "--", "ls -la"], root).code, 0);
  assert.equal(cli(["check", "--no-model", "--cwd", root, "--", "git push --force origin side"], root).code, 10);
  assert.equal(cli(["check", "--no-model", "--cwd", root, "--", "rm -rf /"], root).code, 20);
});

test("json output carries the findings and the exit code", () => {
  const root = makeRepo({ committed: { "a.ts": "a" } });
  const r = cli(["check", "--no-model", "--json", "--cwd", root, "--", "rm -rf /"], root);
  const parsed = JSON.parse(r.out) as { severity: string; exitCode: number; findings: { rule: string }[] };
  assert.equal(parsed.severity, "stop");
  assert.equal(parsed.exitCode, 20);
  assert.ok(parsed.findings.some((f) => f.rule === "rm.special-place"));
});

test("a command with nothing to flag prints nothing at all", () => {
  const root = makeRepo({ committed: { "a.ts": "a" } });
  assert.equal(cli(["check", "--no-model", "--cwd", root, "--", "git status"], root).out, "");
});

test("the hook scripts are valid shell", () => {
  for (const shell of ["bash", "zsh"] as const) {
    const r = cli(["hook", shell]);
    assert.equal(r.code, 0);
    assert.match(r.out, /lastlook/);
    const dir = mkdtempSync(join(tmpdir(), "lastlook-hook-"));
    const f = join(dir, `h.${shell}`);
    writeFileSync(f, r.out);
    // bash can syntax-check both dialects well enough to catch a typo; zsh is checked by zsh when present.
    const checker = shell === "zsh" ? (() => { try { execFileSync("which", ["zsh"], { stdio: "ignore" }); return "zsh"; } catch { return null; } })() : "bash";
    if (checker) execFileSync(checker, ["-n", f], { stdio: "ignore" });
  }
});

test("install only prints instructions and changes nothing", () => {
  const r = cli(["install"]);
  assert.match(r.out, /eval "\$\(lastlook hook/);
  assert.match(r.out, /Nothing was changed/);
});

test("rules lists every rule", () => {
  const r = cli(["rules"]);
  for (const id of ["rm", "git", "db", "kubectl", "terraform", "docker", "redirect"]) assert.match(r.out, new RegExp(`^${id}\\s`, "m"));
});

test("an unknown subcommand explains itself instead of failing silently", () => {
  const r = cli(["frobnicate"]);
  assert.equal(r.code, 2);
  assert.match(r.out, /unknown command/);
});

test("gate with nothing to flag exits 0 without asking anything", () => {
  const root = makeRepo({ committed: { "a.ts": "a" } });
  assert.equal(cli(["gate", "--no-model", "--cwd", root, "--", "ls"], root).code, 0);
});

test("an empty line is allowed straight through", () => {
  assert.equal(cli(["gate", "--no-model", "--", ""]).code, 0);
});

test("a command that fails to parse still exits without blocking the shell", () => {
  const root = makeRepo({});
  const r = cli(["gate", "--no-model", "--cwd", root, "--", 'rm "unterminated'], root);
  assert.ok(r.code === 0 || r.code === 10, `unexpected exit ${r.code}`);
});

test("help is printed when asked for and when given nothing", () => {
  assert.match(cli([]).out, /lastlook/);
  assert.match(cli(["--help"]).out, /lastlook check/);
});

test("the review is fast enough for a shell prompt", async () => {
  const root = makeRepo({ committed: Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`src/f${i}.ts`, "x"])) });
  const started = Date.now();
  await run(process.execPath, [CLI, "check", "--no-model", "--cwd", root, "--", "rm -rf src"], { env: { ...process.env, NO_COLOR: "1" } });
  const took = Date.now() - started;
  assert.ok(took < 3000, `took ${took} ms including node start-up`);
});
