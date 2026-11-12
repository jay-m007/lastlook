#!/usr/bin/env node
// lastlook — see what a command would do before it does it.

import { openSync, readSync, closeSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { readContext } from "./context.ts";
import { review } from "./review.ts";
import { explain } from "./explain.ts";
import type { Explanation } from "./explain.ts";
import { render } from "./render.ts";
import { RANK } from "./findings.ts";
import { hookScript } from "./hook.ts";

const VERSION = "0.1.0";

const USAGE = `lastlook ${VERSION} — a last look at a command before it runs

  lastlook check <command>     review a command and print what it would do
  lastlook gate -- <command>   review, then ask; exit 0 to run it, 1 to cancel
  lastlook hook <bash|zsh>     print the shell integration to eval
  lastlook install             show how to turn the hook on
  lastlook rules               list every rule and what it looks for

  -v, --verbose      show every finding, rule ids and timings
      --json         machine-readable output
      --no-model     rules only, no Ollama call
      --model NAME   model to use (default: $LASTLOOK_MODEL or llama3.2:1b)
      --budget MS    how long the model may take (default: 300)
      --cwd DIR      pretend the shell is in DIR

Exit codes for gate and check: 0 nothing to flag, 10 worth a look, 20 would not undo.
`;

interface Options { verbose: boolean; json: boolean; model: boolean; modelName: string; host: string; budget: number; cwd: string; color: boolean }

function parseArgv(argv: string[]): { cmd: string; rest: string[]; o: Options } {
  const o: Options = {
    verbose: false, json: false,
    model: process.env.LASTLOOK_MODEL !== "off",
    modelName: process.env.LASTLOOK_MODEL || "llama3.2:1b",
    host: process.env.OLLAMA_HOST || "http://127.0.0.1:11434",
    budget: Number(process.env.LASTLOOK_BUDGET_MS || 300),
    cwd: process.env.LASTLOOK_CWD || process.cwd(),
    color: process.stdout.isTTY === true && !process.env.NO_COLOR,
  };
  const rest: string[] = [];
  let cmd = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { rest.push(...argv.slice(i + 1)); break; }
    if (a === "-v" || a === "--verbose") { o.verbose = true; continue; }
    if (a === "--json") { o.json = true; continue; }
    if (a === "--no-model") { o.model = false; continue; }
    if (a === "--color") { o.color = true; continue; }
    if (a === "--no-color") { o.color = false; continue; }
    if (a === "--model") { o.modelName = argv[++i] ?? o.modelName; continue; }
    if (a === "--host") { o.host = argv[++i] ?? o.host; continue; }
    if (a === "--budget") { o.budget = Number(argv[++i] ?? o.budget); continue; }
    if (a === "--cwd") { o.cwd = argv[++i] ?? o.cwd; continue; }
    if (!cmd) { cmd = a; continue; }
    rest.push(a);
  }
  if (!o.host.startsWith("http")) o.host = `http://${o.host}`;
  return { cmd, rest, o };
}

/** Sleeps without pulling in a dependency or going async, so the prompt can wait for a keypress. */
function sleepMs(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* fall through and spin once */ }
}

/** Puts the terminal into, or out of, character-at-a-time mode. stty's flag for naming a tty differs between Linux and BSD. */
function setRawMode(on: boolean): boolean {
  const settings = on ? ["-echo", "-icanon", "min", "1", "time", "0"] : ["echo", "icanon"];
  for (const flag of ["-F", "-f"]) {
    try { execFileSync("stty", [flag, "/dev/tty", ...settings], { stdio: "ignore" }); return true; } catch { /* try the other spelling */ }
  }
  return false;
}

/**
 * Asks a question on the terminal rather than on stdin, because inside a shell hook stdin belongs
 * to the shell. Returns null when there is no terminal to ask, which is different from an empty
 * answer: the caller lets the command through rather than refusing it on a technicality.
 */
function askTty(prompt: string, mode: "key" | "line"): string | null {
  let rfd: number, wfd: number;
  try { rfd = openSync("/dev/tty", "r"); } catch { return null; }
  try { wfd = openSync("/dev/tty", "w"); } catch { closeSync(rfd); return null; }
  let raw = false;
  try {
    writeFileSync(wfd, prompt);
    if (mode === "key") raw = setRawMode(true);
    // One byte in key mode: reading more would swallow whatever the person types next.
    const buf = Buffer.alloc(mode === "key" ? 1 : 512);
    const deadline = Date.now() + 10 * 60_000;
    let n = 0;
    for (;;) {
      try { n = readSync(rfd, buf, 0, buf.length, null); break; }
      catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        // A terminal opened this way is often non-blocking: EAGAIN means "nothing typed yet".
        if ((code === "EAGAIN" || code === "EWOULDBLOCK") && Date.now() < deadline) { sleepMs(20); continue; }
        if (code === "EOF") break;
        return null;
      }
    }
    writeFileSync(wfd, "\n");
    return buf.subarray(0, Math.max(0, n)).toString("utf8");
  } catch { return null; }
  finally {
    if (raw) setRawMode(false);
    try { closeSync(rfd); } catch { /* already gone */ }
    try { closeSync(wfd); } catch { /* already gone */ }
  }
}

const readKey = (prompt: string): string | null => askTty(prompt, "key");
const readLineFromTty = (prompt: string): string | null => askTty(prompt, "line")?.trim() ?? null;

function writeTty(s: string): void {
  try { const fd = openSync("/dev/tty", "a"); writeFileSync(fd, s); closeSync(fd); }
  catch { process.stderr.write(s); }
}

async function main(): Promise<number> {
  const { cmd, rest, o } = parseArgv(process.argv.slice(2));
  const line = rest.join(" ").trim();

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") { process.stdout.write(USAGE); return 0; }
  if (cmd === "version" || cmd === "--version") { process.stdout.write(VERSION + "\n"); return 0; }

  if (cmd === "hook") {
    const shell = rest[0] ?? "";
    if (shell !== "bash" && shell !== "zsh") { process.stderr.write("lastlook hook needs bash or zsh\n"); return 2; }
    process.stdout.write(hookScript(shell));
    return 0;
  }

  if (cmd === "install") {
    const shell = process.env.SHELL?.includes("zsh") ? "zsh" : "bash";
    const rc = shell === "zsh" ? "~/.zshrc" : "~/.bashrc";
    process.stdout.write([
      `Add this one line to ${rc}:`,
      ``,
      `    eval "$(lastlook hook ${shell})"`,
      ``,
      `Then open a new shell. lastlook only looks at commands you type at the prompt.`,
      `To turn it off for one command, put a space in front of it, or run: lastlook off`,
      ``,
      `Nothing was changed. This command only prints these instructions.`,
      ``,
    ].join("\n"));
    return 0;
  }

  if (cmd === "rules") {
    const { RULES } = await import("./rules.ts");
    for (const r of RULES) process.stdout.write(`${r.id.padEnd(12)} ${r.appliesTo === "any" ? "every command" : r.appliesTo.join(", ")}\n`);
    return 0;
  }

  if (cmd !== "check" && cmd !== "gate") { process.stderr.write(`lastlook: unknown command "${cmd}"\n\n${USAGE}`); return 2; }
  if (!line) { if (cmd === "gate") return 0; process.stderr.write("lastlook check needs a command to look at\n"); return 2; }

  const ctx = readContext(o.cwd, process.env);
  const r = review(line, ctx, process.env);
  const code = r.severity === "stop" ? 20 : r.severity === "confirm" ? 10 : 0;

  // The model is only worth waiting for when there is something to say.
  let x: Explanation | null = null;
  if (o.model && (r.findings.length || r.unknownPrograms.length)) {
    x = await explain(r, { host: o.host, model: o.modelName, budgetMs: o.budget });
    if (x.notes.length && !r.findings.length) r.findings.push(...x.notes);
  }

  if (o.json) {
    process.stdout.write(JSON.stringify({ line, severity: r.severity, exitCode: code, findings: r.findings, unknownPrograms: r.unknownPrograms, model: x && { summary: x.summary, notes: x.notes, ms: x.ms, skipped: x.skipped }, rulesMs: r.ms }, null, 2) + "\n");
    return code;
  }

  const width = Math.min(process.stdout.columns || 100, 100);
  const text = render(r, x, { color: o.color, width, verbose: o.verbose });

  if (cmd === "check") { if (text) process.stdout.write(text); else if (o.verbose) process.stdout.write("  nothing to flag\n"); return code; }

  // gate: print to the terminal, then ask. A note is information, not a question.
  if (!r.findings.length) return 0;
  writeTty(text);
  if (r.severity === "note") return 0;

  // With no terminal there is nobody to ask, and refusing a command because of that would be
  // worse than letting it run. Say so rather than deciding quietly.
  const noTerminal = () => { writeTty("  lastlook could not reach a terminal to ask, so this command was allowed through.\n\n"); return 0; };

  if (r.severity === "stop") {
    const typed = readLineFromTty("  type run to go ahead, anything else to stop: ");
    if (typed === null) return noTerminal();
    if (typed === "run") { writeTty("\n"); return 0; }
    writeTty("  cancelled. the line is still there to edit.\n\n");
    return 1;
  }

  const key = readKey("  [enter] cancel   [y] run   [l] list the files   ");
  if (key === null) return noTerminal();
  if (key.toLowerCase().startsWith("l")) {
    const { listTargets } = await import("./list.ts");
    writeTty(listTargets(line, ctx, process.env));
    const again = readKey("  [enter] cancel   [y] run   ");
    if (again === null) return noTerminal();
    return again.toLowerCase().startsWith("y") ? 0 : 1;
  }
  if (key.toLowerCase().startsWith("y")) return 0;
  writeTty("  cancelled. the line is still there to edit.\n\n");
  return 1;
}

main().then((c) => process.exit(c), (e) => {
  // A crash must never stop the shell: say so and let the command through.
  process.stderr.write(`lastlook failed to run, so this command was not checked: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(0);
});
