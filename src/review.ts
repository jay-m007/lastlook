// Puts the pieces together: parse a command line, run every rule that applies, and follow
// commands hidden inside bash -c, xargs and eval.

import type { SimpleCommand } from "./shell.ts";
import { parse, programName, unwrap, innerScript } from "./shell.ts";
import type { Context } from "./context.ts";
import type { Finding, Severity } from "./findings.ts";
import { worst, RANK } from "./findings.ts";
import { RULES, ruleInput, lineRules } from "./rules.ts";

export interface Review {
  line: string;
  findings: Finding[];
  severity: Severity | null;
  /** Programs we saw and had no rule for. The model is asked about these. */
  unknownPrograms: string[];
  /** Parse problems, e.g. an unterminated quote. */
  incomplete: string[];
  /** How long the rules took, in milliseconds. */
  ms: number;
}

const BUILTIN_SAFE = new Set(["cd", "ls", "echo", "pwd", "cat", "grep", "rg", "head", "tail", "less", "more", "which", "type", "export", "source", ".", "printf", "test", "[", "true", "false", "jq", "sort", "uniq", "wc", "awk", "cut", "tr", "date", "env", "set", "unset", "alias", "man", "tree", "fzf", "bat", "eza", "diff", "tee", "touch", "mkdir", "cp", "mv", "ln", "open", "code", "vim", "nvim", "nano", "emacs", "tmux", "clear", "exit", "jobs", "fg", "bg", "wait", "sleep", "read", "return", "shift", "local", "declare", "typeset", "readonly", "trap", "eval", "exec", "if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "function", "npm", "node", "python", "python3", "pip", "pip3", "make", "cargo", "go", "java", "javac", "gradle", "mvn", "pytest", "jest", "vitest", "tsc", "eslint", "prettier", "ruff", "black", "gh", "git"]);

function reviewCommand(cmd: SimpleCommand, ctx: Context, env: NodeJS.ProcessEnv, via: string | null, depth: number, out: Finding[], unknown: Set<string>): void {
  const input = ruleInput(cmd, ctx, env, via);
  if (!input.program) return;
  let matched = false;
  for (const rule of RULES) {
    if (rule.appliesTo !== "any" && !rule.appliesTo.includes(input.program)) continue;
    if (rule.appliesTo !== "any") matched = true;
    try {
      for (const f of rule.check(input)) out.push(via ? { ...f, facts: [...f.facts, `reached through ${via}`] } : f);
    } catch (e) {
      // A broken rule must never stop the shell. Report it as a note and carry on.
      out.push({ rule: `${rule.id}.error`, severity: "note", program: input.program, headline: `The ${rule.id} check failed to run, so this command was not fully checked.`, facts: [String(e instanceof Error ? e.message : e)], recovery: null });
    }
  }
  if (!matched && !BUILTIN_SAFE.has(input.program)) unknown.add(input.program);

  const inner = innerScript(unwrap(cmd).cmd);
  if (inner && depth < 3) {
    const parsed = parse(inner.line);
    for (const c of parsed.commands) reviewCommand(c, ctx, env, inner.via, depth + 1, out, unknown);
  }
}

/** Runs every rule over a command line. Pure: it reads the filesystem and git, and changes nothing. */
export function review(line: string, ctx: Context, env: NodeJS.ProcessEnv = process.env): Review {
  const started = performance.now();
  const parsed = parse(line);
  const findings: Finding[] = [];
  const unknown = new Set<string>();
  for (const cmd of parsed.commands) reviewCommand(cmd, ctx, env, null, 0, findings, unknown);
  findings.push(...lineRules({ line, commands: parsed.commands, ctx, env }));

  if (parsed.incomplete.length) {
    findings.push({ rule: "parse.incomplete", severity: "note", program: "shell", headline: "Part of this line could not be read, so the check is incomplete.", facts: parsed.incomplete, recovery: null });
  }

  // Strongest first, and drop a weaker finding from the same rule family about the same program.
  findings.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  const seen = new Set<string>();
  const unique = findings.filter((f) => { const k = `${f.rule}|${f.headline}`; if (seen.has(k)) return false; seen.add(k); return true; });

  return { line, findings: unique, severity: worst(unique), unknownPrograms: [...unknown], incomplete: parsed.incomplete, ms: Math.round(performance.now() - started) };
}
