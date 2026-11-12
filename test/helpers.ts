// Test scaffolding: throwaway git repositories on disk, because every rule here reads real files.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { readContext } from "../src/context.ts";
import type { Context } from "../src/context.ts";
import { review } from "../src/review.ts";
import type { Review } from "../src/review.ts";
import type { Finding } from "../src/findings.ts";

export interface RepoSpec {
  /** Files to create and commit. */
  committed?: Record<string, string>;
  /** Files to create and leave untracked. */
  untracked?: Record<string, string>;
  /** Committed files to then modify without committing. */
  modified?: Record<string, string>;
  /** Files outside the repository, relative to its parent. */
  outside?: Record<string, string>;
  /** .gitignore contents. */
  ignore?: string;
  branch?: string;
  /** Set up an upstream so ahead/behind counts exist. */
  withUpstream?: boolean;
}

const made: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function put(root: string, rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}

/** Builds a repository in a temp folder and returns its path. Cleaned up by cleanup(). */
export function makeRepo(spec: RepoSpec = {}): string {
  const base = mkdtempSync(join(tmpdir(), "lastlook-test-"));
  made.push(base);
  const root = join(base, "repo");
  mkdirSync(root, { recursive: true });
  for (const [rel, body] of Object.entries(spec.outside ?? {})) put(base, rel, body);
  git(root, ["init", "-q", "-b", spec.branch ?? "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  if (spec.ignore) put(root, ".gitignore", spec.ignore);
  for (const [rel, body] of Object.entries(spec.committed ?? {})) put(root, rel, body);
  if (Object.keys(spec.committed ?? {}).length || spec.ignore) {
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "initial"]);
  }
  if (spec.withUpstream) {
    const remote = join(base, "remote.git");
    git(root, ["init", "-q", "--bare", remote]);
    git(root, ["remote", "add", "origin", remote]);
    git(root, ["push", "-q", "-u", "origin", spec.branch ?? "main"]);
  }
  for (const [rel, body] of Object.entries(spec.modified ?? {})) put(root, rel, body);
  for (const [rel, body] of Object.entries(spec.untracked ?? {})) put(root, rel, body);
  return root;
}

export function cleanup(): void {
  for (const d of made.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ } }
}

/** A context for a repo path, with a predictable environment. */
export function ctxFor(root: string, env: Record<string, string> = {}): Context {
  return readContext(root, { HOME: join(root, "..", "home"), PATH: process.env.PATH, ...env } as NodeJS.ProcessEnv);
}

/** Reviews a line in a repo. The model is never involved in these tests. */
export function look(line: string, root: string, env: Record<string, string> = {}): Review {
  const ctx = ctxFor(root, env);
  return review(line, ctx, { HOME: join(root, "..", "home"), PATH: process.env.PATH, ...env } as NodeJS.ProcessEnv);
}

export const ruleIds = (r: Review): string[] => r.findings.map((f) => f.rule);
export const find = (r: Review, rule: string): Finding | undefined => r.findings.find((f) => f.rule === rule);
/** Every word of every fact, for checking that a claim was actually made. */
export const allText = (r: Review): string => r.findings.map((f) => [f.headline, ...f.facts, f.recovery ?? "", f.alternative ?? ""].join(" ")).join(" ");
