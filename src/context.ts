// What the shell is pointed at right now: which repository and branch, which cluster, which
// database, what is uncommitted. A warning is only useful if it knows this much.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface GitContext {
  root: string;
  branch: string;
  /** The remote's default branch when we can see it, else main or master if one exists. */
  defaultBranch: string | null;
  onDefaultBranch: boolean;
  /** Commits on this branch that the upstream does not have. Null when there is no upstream. */
  ahead: number | null;
  behind: number | null;
  /** Files with changes not committed, relative to the root. Capped. */
  dirty: string[];
  /** Files not known to git at all. Capped. */
  untracked: string[];
  stashes: number;
  /** HEAD is not attached to a branch. */
  detached: boolean;
}

export interface Context {
  cwd: string;
  git: GitContext | null;
  /** kubectl's current context, read from the kubeconfig file. */
  kubeContext: string | null;
  /** Looks like a production cluster by name. */
  kubeLooksProd: boolean;
  awsProfile: string | null;
  terraformWorkspace: string | null;
  /** Host part of DATABASE_URL and friends, never the password. */
  databaseHosts: string[];
  databaseLooksProd: boolean;
  nodeEnv: string | null;
  /** True when we are in a container, where "rm -rf /" is less catastrophic but still bad. */
  inContainer: boolean;
}

const CAP = 200;

/**
 * Runs git and returns stdout. Nothing is trimmed: git status --porcelain puts the status in the
 * first two columns, so " M path" loses its meaning the moment the string is trimmed.
 */
function gitRaw(root: string | null, args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd: root ?? cwd, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 8 << 20 });
  } catch { return null; }
}

function git(root: string | null, args: string[], cwd: string): string | null {
  return gitRaw(root, args, cwd)?.trim() ?? null;
}

export function gitContext(cwd: string): GitContext | null {
  const root = git(null, ["rev-parse", "--show-toplevel"], cwd);
  if (!root) return null;
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"], cwd) ?? "HEAD";
  const detached = branch === "HEAD";
  let defaultBranch = git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd)?.replace(/^origin\//, "") ?? null;
  if (!defaultBranch) {
    for (const b of ["main", "master"]) if (git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`], cwd) !== null) { defaultBranch = b; break; }
  }
  let ahead: number | null = null, behind: number | null = null;
  const counts = git(root, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], cwd);
  if (counts) { const [b, a] = counts.split(/\s+/).map(Number); behind = b; ahead = a; }
  const status = gitRaw(root, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"], cwd) ?? "";
  const dirty: string[] = [], untracked: string[] = [];
  for (const entry of status.split("\0")) {
    if (!entry) continue;
    const code = entry.slice(0, 2), path = entry.slice(3);
    if (!path) continue;
    if (code === "??") { if (untracked.length < CAP) untracked.push(path); }
    else if (dirty.length < CAP) dirty.push(path);
  }
  const stashes = Number(git(root, ["rev-list", "--walk-reflogs", "--count", "refs/stash"], cwd) ?? "0") || 0;
  return { root, branch, defaultBranch, onDefaultBranch: !detached && branch === defaultBranch, ahead, behind, dirty, untracked, stashes, detached };
}

/** Reads current-context out of a kubeconfig without needing kubectl or a YAML library. */
export function kubeCurrentContext(env: NodeJS.ProcessEnv = process.env): string | null {
  const paths = (env.KUBECONFIG ?? join(env.HOME || homedir(), ".kube", "config")).split(/[:;]/).filter(Boolean);
  for (const p of paths) {
    try {
      const text = readFileSync(p, "utf8");
      const m = /^current-context:\s*(.+?)\s*$/m.exec(text);
      if (m) return m[1].replace(/^["']|["']$/g, "");
    } catch { /* unreadable or absent */ }
  }
  return null;
}

const PROD_WORDS = /(^|[^a-z])(prod|production|live|master)([^a-z]|$)/i;

/** Hostnames out of DATABASE_URL-style variables, with credentials dropped. */
export function databaseHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!v || !/(^|_)(DATABASE|DB|POSTGRES|POSTGRESQL|MYSQL|MONGO|REDIS|CLICKHOUSE)(_|$)/i.test(k)) continue;
    const m = /^[a-z+]+:\/\/(?:[^@/]*@)?([^/?#:]+)/i.exec(v);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

export function readContext(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): Context {
  const kubeContext = kubeCurrentContext(env);
  const hosts = databaseHosts(env);
  let terraformWorkspace: string | null = null;
  try { terraformWorkspace = readFileSync(join(cwd, ".terraform", "environment"), "utf8").trim() || null; } catch { /* not a terraform dir */ }
  return {
    cwd,
    git: gitContext(cwd),
    kubeContext,
    kubeLooksProd: !!kubeContext && PROD_WORDS.test(kubeContext),
    awsProfile: env.AWS_PROFILE ?? env.AWS_DEFAULT_PROFILE ?? null,
    terraformWorkspace,
    databaseHosts: hosts,
    databaseLooksProd: hosts.some((h) => PROD_WORDS.test(h)) || (env.NODE_ENV ?? "") === "production",
    nodeEnv: env.NODE_ENV ?? null,
    inContainer: existsSync("/.dockerenv") || (() => { try { return /docker|kubepods|containerd/.test(readFileSync("/proc/1/cgroup", "utf8")); } catch { return false; } })(),
  };
}

/**
 * Splits the repository's unsaved work into the part git has a record of and the part it does not.
 * The distinction matters: a tracked file with changes can be diffed before it goes, an untracked
 * file cannot be recovered at all.
 */
export function unsavedAmong(g: GitContext, absolutePaths: string[]): { modified: string[]; untracked: string[] } {
  const covers = (rel: string) => {
    const abs = join(g.root, rel.replace(/\/$/, ""));
    return absolutePaths.some((p) => abs === p || abs.startsWith((p.endsWith("/") ? p : p + "/")) || p.startsWith(abs + "/"));
  };
  return { modified: g.dirty.filter(covers), untracked: g.untracked.filter(covers) };
}

/** Kept for callers that only care whether anything would be lost. */
export function uncommittedAmong(g: GitContext, absolutePaths: string[]): string[] {
  const u = unsavedAmong(g, absolutePaths);
  return [...u.modified, ...u.untracked];
}

/**
 * Files under these paths that .gitignore excludes.
 *
 * This is the blind spot that makes "it is all in git" wrong: an ignored file is not listed by
 * git status as untracked, so without asking git directly, deleting a gitignored .env or a
 * gitignored data folder looks exactly as safe as deleting node_modules.
 */
export function ignoredUnder(g: GitContext, absolutePaths: string[], cwd: string): string[] {
  if (!absolutePaths.length) return [];
  const out = gitRaw(g.root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...absolutePaths.slice(0, 200)], cwd);
  return out ? out.split("\0").filter(Boolean) : [];
}

/** Whether git knows about these paths at all. Asks git directly so .gitignore is respected. */
export function trackedCount(g: GitContext, absolutePaths: string[], cwd: string): number | null {
  if (!absolutePaths.length) return 0;
  const out = git(g.root, ["ls-files", "-z", "--", ...absolutePaths.slice(0, 500)], cwd);
  if (out === null) return null;
  return out.split("\0").filter(Boolean).length;
}
