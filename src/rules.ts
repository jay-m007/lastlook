// The rules. Each one looks at a single command and the context it would run in, and returns
// findings it can back up. A rule never guesses: when it cannot tell what a word means, it says so
// and raises the severity, because an unknown path is more dangerous than a known one.

import { join, basename, dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, lstatSync } from "node:fs";
import type { SimpleCommand, Word } from "./shell.ts";
import { programName, unwrap } from "./shell.ts";
import { expand, survey, isInside, describePlace, shorten } from "./paths.ts";
import type { Context } from "./context.ts";
import { unsavedAmong, uncommittedAmong, trackedCount, ignoredUnder } from "./context.ts";
import type { GitContext } from "./context.ts";
import type { Finding } from "./findings.ts";
import { plural, bytes } from "./findings.ts";

export interface RuleInput {
  cmd: SimpleCommand;
  /** sudo/env/timeout stripped off. */
  program: string;
  sudo: boolean;
  /** Arguments that are not options, in order. */
  operands: Word[];
  /** Short options as single letters plus long options with their leading dashes. */
  flags: Set<string>;
  ctx: Context;
  env: NodeJS.ProcessEnv;
  /** Set when this command came out of bash -c, xargs or a pipe into a shell. */
  via: string | null;
}

export interface Rule { id: string; appliesTo: string[] | "any"; check: (i: RuleInput) => Finding[] }

/** Splits argv into flags and operands, handling -rf, --force and -- . */
export function splitArgs(argv: Word[], optsWithValues: Set<string> = new Set()): { flags: Set<string>; operands: Word[] } {
  const flags = new Set<string>();
  const operands: Word[] = [];
  let noMore = false;
  for (let i = 1; i < argv.length; i++) {
    const w = argv[i];
    const t = w.text;
    if (noMore) { operands.push(w); continue; }
    if (t === "--") { noMore = true; continue; }
    if (t.startsWith("--")) {
      const [name, inline] = t.split("=", 2);
      flags.add(name);
      if (inline === undefined && optsWithValues.has(name)) { const v = argv[i + 1]; if (v) { flags.add(`${name}=${v.text}`); i++; } }
      else if (inline !== undefined) flags.add(`${name}=${inline}`);
      continue;
    }
    if (t.startsWith("-") && t.length > 1) {
      // Some tools use single-dash long options (terraform -auto-approve), so keep the whole
      // token as well as the individual letters of a short cluster like -rf.
      flags.add(t);
      for (const c of t.slice(1)) flags.add("-" + c);
      if (optsWithValues.has("-" + t.slice(-1))) { const v = argv[i + 1]; if (v) { flags.add(`-${t.slice(-1)}=${v.text}`); i++; } }
      continue;
    }
    operands.push(w);
  }
  return { flags, operands };
}

/** kubectl takes plural resource names, which read wrongly after "every": every pods. */
function singular(word: string): string {
  if (/(ses|xes|zes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (/ies$/.test(word)) return word.slice(0, -3) + "y";
  if (/ss$|us$|s$/.test(word) && !/ss$|us$/.test(word)) return word.slice(0, -1);
  return word;
}

const flagValue = (flags: Set<string>, name: string): string | null => {
  for (const f of flags) if (f.startsWith(name + "=")) return f.slice(name.length + 1);
  return null;
};

/** Substitutes the empty string for every variable reference, which is what the shell does when it is unset. */
function ifVarsEmpty(w: Word): string {
  return w.text.replace(/\$\{[^}]*\}/g, "");
}

function subject(i: RuleInput, w: Word) {
  const e = expand(w, i.ctx.cwd, i.env);
  return { word: w, ...e, shown: shorten(e.paths[0] ?? w.text, i.ctx.cwd, i.env) };
}

const home = (env: NodeJS.ProcessEnv) => env.HOME || homedir();

/** git status lists an untracked folder as one entry, so count what is really inside. */
function countUnder(g: GitContext, rels: string[]): number {
  if (!rels.length) return 0;
  const s = survey(rels.map((r) => join(g.root, r.replace(/\/$/, ""))), null);
  return s.files;
}

/**
 * Ignored files fall into two groups and the difference is the whole point: one group is a command
 * away from coming back, the other is gone. Anything not recognisably reinstallable is treated as
 * the second kind, because guessing wrong in that direction is the cheap mistake.
 */
const REINSTALLABLE = /(^|\/)(node_modules|bower_components|vendor|\.venv|venv|__pycache__|\.pytest_cache|\.mypy_cache|target|build|dist|out|\.next|\.nuxt|\.svelte-kit|\.turbo|\.parcel-cache|coverage|\.nyc_output|\.cache|\.gradle|\.m2|Pods|DerivedData|\.terraform|tmp|temp)(\/|$)|\.(pyc|pyo|class|o|obj|log|map|tsbuildinfo)$/i;

const PRECIOUS = /(^|\/)(\.env[^/]*|\.envrc|secrets?[^/]*|credentials?[^/]*|data|uploads?|storage|media|backups?|dumps?|db|database)(\/|$)|\.(sqlite3?|db|sql|dump|pem|key|p12|pfx|keystore|jks)$/i;

/** Splits ignored files into the ones that can be rebuilt and the ones that cannot. */
function partitionIgnored(paths: string[]): { rebuildable: string[]; precious: string[]; unknown: string[] } {
  const rebuildable: string[] = [], precious: string[] = [], unknown: string[] = [];
  for (const p of paths) {
    if (PRECIOUS.test(p)) precious.push(p);
    else if (REINSTALLABLE.test(p)) rebuildable.push(p);
    else unknown.push(p);
  }
  return { rebuildable, precious, unknown };
}

/** The option words as the person typed them, for quoting a command back at them. */
function flagWords(cmd: SimpleCommand): string {
  return cmd.argv.slice(1).filter((w) => w.text.startsWith("-")).map((w) => w.text).join(" ");
}

// ---------------------------------------------------------------- rm

const rm: Rule = {
  id: "rm",
  appliesTo: ["rm", "unlink", "rmdir"],
  check(i) {
    const out: Finding[] = [];
    const recursive = i.flags.has("-r") || i.flags.has("-R") || i.flags.has("--recursive") || i.program === "rmdir";
    const forced = i.flags.has("-f") || i.flags.has("--force");
    if (!i.operands.length) return out;

    // The classic: an unset variable turning a targeted delete into a disaster.
    for (const w of i.operands) {
      if (!w.vars.length) continue;
      const unset = w.vars.filter((v) => i.env[v] === undefined || i.env[v] === "");
      if (!unset.length) continue;
      const collapsed = ifVarsEmpty(w);
      const asPath = collapsed === "" ? i.ctx.cwd : resolve(i.ctx.cwd, collapsed);
      const danger = collapsed === "/" || asPath === "/" || asPath === home(i.env) || (collapsed === "" && recursive);
      if (danger) {
        out.push({
          rule: "rm.unset-variable", severity: "stop", program: i.program,
          headline: `If ${unset.map((v) => "$" + v).join(" or ")} is empty, this deletes ${collapsed === "/" || asPath === "/" ? "the whole filesystem" : asPath === home(i.env) ? "your home folder" : "everything in " + shorten(i.ctx.cwd, i.ctx.cwd, i.env)}.`,
          facts: [`the argument is written ${w.raw}`, `${unset.map((v) => "$" + v).join(", ")} ${unset.length > 1 ? "are" : "is"} ${unset.every((v) => i.env[v] === undefined) ? "not set" : "empty"} in this shell`, `with it empty the command becomes: ${i.program} ${flagWords(i.cmd)} ${collapsed || "."}`.replace(/\s+/g, " ")],
          recovery: null,
          alternative: `use \${${unset[0]}:?set this first} so the shell refuses when it is empty`,
        });
      }
    }

    const expansions = i.operands.map((w) => subject(i, w));
    const unknown = expansions.filter((e) => e.unknown);
    const known = expansions.filter((e) => !e.unknown).flatMap((e) => e.paths);

    for (const u of unknown) {
      if (out.some((f) => f.rule === "rm.unset-variable")) continue;
      out.push({ rule: "rm.unknown-target", severity: recursive ? "confirm" : "note", program: i.program, headline: `${i.program} is being given a path this check cannot work out.`, facts: [`the argument is ${u.word.raw}`, u.why ?? "its value is not visible here"], recovery: null });
    }

    for (const p of known) {
      const place = describePlace(p, i.env);
      if (place) out.push({ rule: "rm.special-place", severity: "stop", program: i.program, headline: `This deletes ${place}.`, facts: [`the path is ${p}`, ...(i.ctx.inContainer && p === "/" ? ["you appear to be inside a container, so this would wreck the container rather than the host"] : [])], recovery: p === "/" || p === home(i.env) ? null : "restore from a backup, if you have one" });
    }

    if (!known.length) return out;

    const boundary = i.ctx.git?.root ?? null;
    const s = survey(known, boundary);
    const facts: string[] = [];
    const total = s.files + s.dirs;
    if (total === 0 && expansions.every((e) => e.missing)) {
      out.push({ rule: "rm.nothing-there", severity: "note", program: i.program, headline: `Nothing at ${expansions.map((e) => e.shown).join(", ")} to delete.`, facts: forced ? ["-f means the command will succeed quietly anyway"] : [], recovery: null });
      return out;
    }
    facts.push(`${plural(s.files, "file")}${s.dirs ? ` in ${plural(s.dirs, "folder")}` : ""}, ${bytes(s.bytes)}`);
    if (s.truncated) facts[0] = `more than ${facts[0]} (stopped counting)`;
    if (s.symlinks) facts.push(`${plural(s.symlinks, "symlink")} would be removed without touching what they point at`);

    if (s.outside.length && boundary) {
      out.push({
        rule: "rm.outside-repo", severity: "confirm", program: i.program,
        headline: `${plural(s.outside.length, "path")} ${s.outside.length === 1 ? "is" : "are"} outside this repository.`,
        facts: [`the repository is ${shorten(boundary, i.ctx.cwd, i.env)}`, ...s.outside.slice(0, 4).map((p) => `outside: ${p}`), ...facts],
        recovery: "git cannot help with anything outside the repository",
      });
    }

    const g = i.ctx.git;
    if (g) {
      const unsaved = unsavedAmong(g, known);
      const tracked = trackedCount(g, known, i.ctx.cwd);
      if (unsaved.modified.length) {
        out.push({
          rule: "rm.uncommitted", severity: "confirm", program: i.program,
          headline: `${plural(unsaved.modified.length, "file")} ${unsaved.modified.length === 1 ? "has" : "have"} changes that are not committed.`,
          facts: [...unsaved.modified.slice(0, 5).map((p) => `changed, not committed: ${p}`), ...(unsaved.modified.length > 5 ? [`and ${unsaved.modified.length - 5} more`] : []), "git has no copy of these changes, only of the last committed version", ...facts],
          recovery: null,
          alternative: `git stash push -- ${unsaved.modified.slice(0, 3).join(" ")} keeps them first`,
        });
      }
      if (unsaved.untracked.length) {
        const n = countUnder(g, unsaved.untracked);
        out.push({
          rule: "rm.untracked-in-repo", severity: n > 50 ? "confirm" : "note", program: i.program,
          headline: `${plural(n, "file")} ${n === 1 ? "is" : "are"} not in git at all, so git cannot bring ${n === 1 ? "it" : "them"} back.`,
          facts: [...unsaved.untracked.slice(0, 5).map((p) => `not in git: ${p}${p.endsWith("/") ? " (whole folder)" : ""}`), ...(unsaved.untracked.length > 5 ? [`and ${unsaved.untracked.length - 5} more`] : [])],
          recovery: null,
        });
      }
      // Ignored files: git status never mentioned them, so nothing above has accounted for them.
      const ignored = ignoredUnder(g, known, i.ctx.cwd);
      const reportedAsIgnored = ignored.length > 0;
      if (ignored.length) {
        const { rebuildable, precious, unknown } = partitionIgnored(ignored);
        const atRisk = [...precious, ...unknown];
        if (atRisk.length) {
          out.push({
            rule: "rm.ignored-precious", severity: precious.length ? "confirm" : atRisk.length > 20 ? "confirm" : "note", program: i.program,
            headline: `${plural(atRisk.length, "file")} ${atRisk.length === 1 ? "is" : "are"} ignored by git, so git has never had a copy of ${atRisk.length === 1 ? "it" : "them"}.`,
            facts: [
              ...atRisk.slice(0, 5).map((p) => `ignored by .gitignore: ${p}`),
              ...(atRisk.length > 5 ? [`and ${atRisk.length - 5} more`] : []),
              ...(precious.length ? ["an ignored file is usually local configuration or data, which is exactly the kind that cannot be fetched again"] : []),
              ...(rebuildable.length ? [`${plural(rebuildable.length, "other ignored file")} look installable (${[...new Set(rebuildable.map((p) => p.split("/")[0]))].slice(0, 3).join(", ")})`] : []),
            ],
            recovery: null,
            alternative: `git status --ignored -- ${expansions.map((e) => e.shown).slice(0, 2).join(" ")} lists them all first`,
          });
        } else if (rebuildable.length) {
          out.push({
            rule: "rm.ignored-rebuildable", severity: "note", program: i.program,
            headline: `${plural(rebuildable.length, "file")} ${rebuildable.length === 1 ? "is" : "are"} ignored by git but look installable.`,
            facts: [`under ${[...new Set(rebuildable.map((p) => p.split("/")[0]))].slice(0, 3).join(", ")}`, "git has no copy, but a build or install command brings these back"],
            recovery: "reinstall or rebuild",
          });
        }
      }

      if (tracked !== null && tracked > 0 && !unsaved.modified.length) {
        out.push({ rule: "rm.tracked", severity: "note", program: i.program, headline: `${plural(tracked, "file")} ${tracked === 1 ? "is" : "are"} committed, so ${tracked === 1 ? "it" : "they"} can be restored.`, facts, recovery: `git checkout -- ${expansions.map((e) => e.shown).slice(0, 3).join(" ")}` });
      }
      if (tracked === 0 && !unsaved.modified.length && !unsaved.untracked.length && s.files > 0 && !reportedAsIgnored) {
        out.push({ rule: "rm.not-in-git", severity: s.files > 50 ? "confirm" : "note", program: i.program, headline: `${plural(s.files, "file")} ${s.files === 1 ? "is" : "are"} not in git at all.`, facts, recovery: null });
      }
    } else if (s.files > 0 && !out.length) {
      out.push({ rule: "rm.no-repo", severity: s.files > 50 ? "confirm" : "note", program: i.program, headline: `This deletes ${plural(s.files, "file")} and there is no repository here to restore from.`, facts, recovery: null });
    }

    // A glob that matched far more than the person probably pictured.
    for (const e of expansions) {
      if (e.word.glob && e.paths.length > 20) out.push({ rule: "rm.wide-glob", severity: "confirm", program: i.program, headline: `${e.word.raw} matches ${plural(e.paths.length, "path")}.`, facts: [`for example ${e.paths.slice(0, 3).map((p) => shorten(p, i.ctx.cwd, i.env)).join(", ")}`], recovery: null, alternative: `run echo ${e.word.raw} first to see the list` });
    }
    return out;
  },
};

// ---------------------------------------------------------------- git

const gitRule: Rule = {
  id: "git",
  appliesTo: ["git"],
  check(i) {
    const out: Finding[] = [];
    const g = i.ctx.git;
    const sub = i.operands[0]?.text;
    const rest = i.operands.slice(1);
    const F = i.flags;
    if (!sub) return out;

    if (sub === "push") {
      const force = F.has("--force") || F.has("-f");
      const lease = F.has("--force-with-lease") || F.has("--force-if-includes");
      const target = rest.map((w) => w.text);
      const branchArg = target[1] ?? "";
      const pushingDefault = !!g?.defaultBranch && (branchArg.includes(g.defaultBranch) || (!branchArg && g.onDefaultBranch));
      if (force && !lease) {
        out.push({
          rule: "git.force-push", severity: pushingDefault ? "stop" : "confirm", program: "git",
          headline: `A plain force push overwrites whatever is on the remote${pushingDefault ? `, and the target is the default branch` : ""}.`,
          facts: [
            `local branch: ${g?.branch ?? "unknown"}`,
            ...(g?.defaultBranch ? [`default branch: ${g.defaultBranch}`] : []),
            ...(g?.behind ? [`you are ${plural(g.behind, "commit")} behind the upstream, so those commits would be dropped`] : []),
            ...(g?.behind === 0 ? ["your branch is level with the upstream as of the last fetch"] : []),
            ...(g && g.behind === null ? ["this branch has no upstream set, so lastlook cannot tell what is on the remote or what would be overwritten"] : []),
            "anyone else's commits pushed since your last fetch are lost without a trace in your clone",
          ],
          recovery: "the remote keeps the old objects for a while; whoever has the commits locally can push them back",
          alternative: "git push --force-with-lease refuses if the remote moved since your last fetch",
        });
      } else if (lease && pushingDefault) {
        out.push({ rule: "git.force-push-default", severity: "confirm", program: "git", headline: `Force-pushing the default branch, even with a lease, rewrites history others have pulled.`, facts: [`branch: ${g?.branch}`, `default branch: ${g?.defaultBranch}`], recovery: "the lease means the remote is only overwritten if it has not moved" });
      }
      if (F.has("--delete") || F.has("-d")) out.push({ rule: "git.push-delete", severity: "confirm", program: "git", headline: `This deletes ${rest.slice(1).map((w) => w.text).join(", ") || "a branch"} on the remote.`, facts: ["the branch stays in your clone, so it can be pushed again"], recovery: `git push ${target[0] ?? "origin"} ${rest.slice(1).map((w) => w.text).join(" ")}` });
      if (F.has("--mirror")) out.push({ rule: "git.push-mirror", severity: "stop", program: "git", headline: "A mirror push makes the remote match your clone exactly, deleting every branch and tag you do not have.", facts: g ? [`your clone has ${g.branch} checked out`] : [], recovery: null });
      return out;
    }

    if (sub === "reset" && (F.has("--hard") || F.has("--keep"))) {
      const n = (g?.dirty.length ?? 0);
      out.push({
        rule: "git.reset-hard", severity: n ? "confirm" : "note", program: "git",
        headline: n ? `This throws away uncommitted changes in ${plural(n, "file")}.` : "This moves the branch and discards anything uncommitted.",
        facts: [...(g?.dirty.slice(0, 5) ?? []).map((p) => `uncommitted: ${p}`), ...(n > 5 ? [`and ${n - 5} more`] : []), ...(n === 0 ? ["the working tree is clean, so nothing uncommitted is at risk"] : []), ...(g?.untracked.length ? [`${plural(g.untracked.length, "untracked file")} would be left alone by --hard`] : [])],
        recovery: n ? "uncommitted changes are not in git's history, so there is nothing to recover them from" : "git reflog still lists the commit you are on now",
        alternative: n ? "git stash push keeps the changes and still moves you" : undefined,
      });
    }

    if (sub === "clean") {
      const d = F.has("-d"), x = F.has("-x"), f = F.has("-f"), dry = F.has("-n") || F.has("--dry-run");
      if (f && !dry) {
        const files = g?.untracked ?? [];
        const count = g ? countUnder(g, files) : files.length;
        out.push({
          rule: "git.clean", severity: x ? "confirm" : count > 20 ? "confirm" : "note", program: "git",
          headline: `This deletes ${plural(count, "untracked file")}${x ? ", and -x adds every ignored file on top, which git status never showed you" : ""}.`,
          facts: [...files.slice(0, 5).map((p) => `untracked: ${p}${p.endsWith("/") ? " (whole folder)" : ""}`), ...(files.length > 5 ? [`and ${files.length - 5} more`] : []), ...(x ? ["ignored files usually means .env, node_modules and local config; git clean -ndx lists them"] : ["ignored files are left alone without -x"]), ...(d ? [] : ["without -d, untracked folders are left alone"])],
          recovery: null,
          alternative: `git clean -n${d ? "d" : ""}${x ? "x" : ""} lists what would go, without deleting`,
        });
      }
    }

    if (sub === "checkout" || sub === "restore" || sub === "switch") {
      const discards = rest.some((w) => w.text === ".") || F.has("--") || (sub === "restore" && rest.length > 0);
      if (discards && (g?.dirty.length ?? 0) > 0) {
        out.push({ rule: "git.discard-changes", severity: "confirm", program: "git", headline: `This overwrites uncommitted changes in ${plural(g!.dirty.length, "file")}.`, facts: g!.dirty.slice(0, 5).map((p) => `uncommitted: ${p}`), recovery: null, alternative: "git stash push keeps them" });
      }
      if (F.has("-B") || F.has("-f") || F.has("--force")) out.push({ rule: "git.checkout-force", severity: "note", program: "git", headline: "Forced checkout discards local changes in the files it touches.", facts: [], recovery: null });
    }

    if (sub === "stash" && (rest[0]?.text === "drop" || rest[0]?.text === "clear")) {
      out.push({ rule: "git.stash-drop", severity: rest[0].text === "clear" ? "confirm" : "note", program: "git", headline: rest[0].text === "clear" ? `This deletes all ${plural(g?.stashes ?? 0, "stash", "stashes")}.` : "This deletes a stash.", facts: [`${plural(g?.stashes ?? 0, "stash", "stashes")} on record`], recovery: "a dropped stash is still in the object database for a while: git fsck --unreachable can find it" });
    }

    if (sub === "branch" && (F.has("-D") || (F.has("-d") && F.has("--force")))) {
      out.push({ rule: "git.branch-delete", severity: "note", program: "git", headline: `Force-deleting ${rest.map((w) => w.text).join(", ")} drops commits that are not merged anywhere else.`, facts: [], recovery: "git reflog still has the tip commit for now, so the branch can be recreated" });
    }

    if (sub === "filter-branch" || (sub === "filter-repo")) out.push({ rule: "git.filter", severity: "confirm", program: "git", headline: "This rewrites every commit it touches, so all commit ids change.", facts: ["anyone else with a clone has to reset to the new history", ...(g ? [`${g.branch} would be rewritten`] : [])], recovery: "the original refs are kept under refs/original for filter-branch" });

    if (sub === "gc" && (F.has("--prune=now") || flagValue(F, "--prune") === "now")) out.push({ rule: "git.gc-prune", severity: "note", program: "git", headline: "Pruning now deletes unreachable objects, which is what reflog recovery relies on.", facts: ["dropped stashes and reset commits become unrecoverable"], recovery: null });

    if (sub === "commit" && F.has("--amend")) {
      const pushed = (g?.ahead ?? 1) === 0;
      out.push({ rule: "git.amend", severity: pushed ? "confirm" : "note", program: "git", headline: pushed ? "The commit you are amending has already been pushed, so this will need a force push." : "Amending replaces the last commit.", facts: pushed ? [`${g!.branch} is level with its upstream, so the last commit is on the remote`] : ["the commit is not on the remote yet"], recovery: "git reflog lists the commit as it was" });
    }
    return out;
  },
};

// ---------------------------------------------------------------- databases

const SQL_DESTRUCTIVE = [
  { re: /\bdrop\s+(table|database|schema|index)\b/i, what: (m: string) => `a ${m.toLowerCase().replace(/\s+/g, " ")}` },
  { re: /\btruncate\b/i, what: () => "truncate, which empties a table" },
  { re: /\bdelete\s+from\b/i, what: () => "delete" },
  { re: /\bupdate\b[\s\S]*\bset\b/i, what: () => "update" },
  { re: /\balter\s+table\b[\s\S]*\bdrop\b/i, what: () => "a column drop" },
];

function sqlFindings(sql: string, i: RuleInput, how: string): Finding[] {
  const out: Finding[] = [];
  const stripped = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  for (const d of SQL_DESTRUCTIVE) {
    const m = d.re.exec(stripped);
    if (!m) continue;
    const noWhere = /\b(delete\s+from|update)\b/i.test(m[0]) && !/\bwhere\b/i.test(stripped);
    const prod = i.ctx.databaseLooksProd;
    out.push({
      rule: noWhere ? "sql.no-where" : "sql.destructive", severity: prod ? "stop" : noWhere ? "confirm" : "confirm", program: i.program,
      headline: noWhere ? `This ${/update/i.test(m[0]) ? "updates" : "deletes"} every row in the table: there is no WHERE clause.` : `This statement contains ${d.what(m[0])}.`,
      facts: [
        `the statement reaches the server through ${how}`,
        `matched: ${m[0].replace(/\s+/g, " ").trim()}`,
        ...(i.ctx.databaseHosts.length ? [`${i.ctx.databaseHosts.length === 1 ? "the database host in your environment is" : "database hosts in your environment:"} ${i.ctx.databaseHosts.join(", ")}`] : ["no database host is visible in this shell's environment, so the target is whatever the client defaults to"]),
        ...(prod ? ["the host or NODE_ENV says production"] : []),
      ],
      recovery: "unless the server has point-in-time recovery or you have a dump from before this, there is no way back",
      alternative: noWhere ? "run it as SELECT count(*) first with the same conditions" : "take a dump first: pg_dump or mysqldump",
    });
    break;
  }
  return out;
}

const dbRule: Rule = {
  id: "db",
  appliesTo: ["psql", "mysql", "mariadb", "sqlite3", "mongosh", "mongo", "redis-cli", "clickhouse-client"],
  check(i) {
    const out: Finding[] = [];
    const inline = flagValue(i.flags, "-c") ?? flagValue(i.flags, "--command") ?? flagValue(i.flags, "-e") ?? flagValue(i.flags, "--execute") ?? flagValue(i.flags, "--eval") ?? flagValue(i.flags, "-q");
    const positional = i.program === "sqlite3" ? i.operands[1]?.text : undefined;
    const sql = inline ?? positional;
    if (sql) out.push(...sqlFindings(sql, i, `${i.program} ${inline ? "-c" : ""}`.trim()));
    if (i.program === "redis-cli" && /\b(flushall|flushdb)\b/i.test(i.operands.map((w) => w.text).join(" "))) {
      out.push({ rule: "redis.flush", severity: i.ctx.databaseLooksProd ? "stop" : "confirm", program: i.program, headline: "FLUSHALL empties every key in the instance.", facts: i.ctx.databaseHosts.length ? [`hosts in this environment: ${i.ctx.databaseHosts.join(", ")}`] : [], recovery: "only from a snapshot or AOF file, if persistence is on" });
    }
    if ((i.program === "mongosh" || i.program === "mongo") && /\bdrop(Database)?\s*\(/i.test(i.operands.map((w) => w.text).join(" ") + (inline ?? ""))) {
      out.push({ rule: "mongo.drop", severity: "confirm", program: i.program, headline: "This drops a collection or database.", facts: [], recovery: "only from a mongodump" });
    }
    return out;
  },
};

// ---------------------------------------------------------------- kubernetes, terraform, clouds

const kubectlRule: Rule = {
  id: "kubectl",
  appliesTo: ["kubectl", "oc", "helm"],
  check(i) {
    const out: Finding[] = [];
    const sub = i.operands[0]?.text ?? "";
    const ctxName = flagValue(i.flags, "--context") ?? i.ctx.kubeContext;
    const ns = flagValue(i.flags, "-n") ?? flagValue(i.flags, "--namespace") ?? null;
    const prod = !!ctxName && /(^|[^a-z])(prod|production|live)([^a-z]|$)/i.test(ctxName);
    const where = [ctxName ? `cluster: ${ctxName}` : "no current cluster could be read from your kubeconfig", ns ? `namespace: ${ns}` : "namespace: whatever the context defaults to"];

    if (i.program === "helm" && (sub === "uninstall" || sub === "delete")) {
      out.push({ rule: "helm.uninstall", severity: prod ? "stop" : "confirm", program: "helm", headline: `This removes the release ${i.operands[1]?.text ?? ""} and everything it created.`.replace("  ", " "), facts: where, recovery: "helm keeps release history unless --purge; the objects themselves go" });
      return out;
    }
    if (sub === "delete") {
      const all = i.flags.has("--all") || i.operands.some((w) => w.text === "--all");
      out.push({
        rule: "kubectl.delete", severity: prod || all ? "stop" : "confirm", program: i.program,
        headline: all ? `This deletes every ${singular(i.operands[1]?.text ?? "object")} in the namespace.` : `This deletes ${i.operands.slice(1).map((w) => w.text).join(" ") || "cluster objects"}.`,
        facts: [...where, ...(prod ? ["the cluster name says production"] : []), ...(all ? ["--all means every object of that kind, not just yours"] : [])],
        recovery: "if the objects came from a manifest in git you can re-apply it; anything with data attached does not come back",
        alternative: "add --dry-run=client to see the list first",
      });
    }
    if (sub === "scale" && /replicas=0/.test([...i.flags].join(" "))) out.push({ rule: "kubectl.scale-zero", severity: prod ? "confirm" : "note", program: i.program, headline: "Scaling to zero stops serving traffic.", facts: where, recovery: "scale back up with the old replica count" });
    if (sub === "drain" || sub === "cordon") out.push({ rule: "kubectl.drain", severity: prod ? "confirm" : "note", program: i.program, headline: `This moves every pod off ${i.operands[1]?.text ?? "the node"}.`, facts: where, recovery: "kubectl uncordon brings the node back" });
    if ((sub === "apply" || sub === "replace") && prod) out.push({ rule: "kubectl.apply-prod", severity: "confirm", program: i.program, headline: "This applies changes to a cluster whose name says production.", facts: where, recovery: "kubectl rollout undo works for deployments" });
    return out;
  },
};

const terraformRule: Rule = {
  id: "terraform",
  appliesTo: ["terraform", "tofu", "pulumi"],
  check(i) {
    const out: Finding[] = [];
    const sub = i.operands[0]?.text ?? "";
    const ws = i.ctx.terraformWorkspace;
    const prod = !!ws && /prod|live/i.test(ws);
    const where = [ws ? `workspace: ${ws}` : "no workspace file in this folder, so the default workspace applies", ...(i.ctx.awsProfile ? [`AWS_PROFILE: ${i.ctx.awsProfile}`] : [])];
    if (sub === "destroy") out.push({ rule: "terraform.destroy", severity: "stop", program: i.program, headline: "This destroys every resource in the state.", facts: [...where, ...(i.flags.has("-auto-approve") || i.flags.has("--yes") ? ["auto-approve means no plan will be shown and no confirmation asked"] : ["terraform will show a plan and ask first"])], recovery: "terraform apply can recreate the resources, but data in them is gone" });
    if ((sub === "apply" || sub === "up") && (i.flags.has("-auto-approve") || i.flags.has("--yes")) && prod) out.push({ rule: "terraform.auto-approve-prod", severity: "confirm", program: i.program, headline: "Applying with auto-approve on a production workspace skips the plan review.", facts: where, recovery: null });
    return out;
  },
};

const cloudRule: Rule = {
  id: "cloud",
  appliesTo: ["aws", "gsutil", "gcloud", "az", "s3cmd", "rclone"],
  check(i) {
    const args = i.operands.map((w) => w.text);
    const line = args.join(" ");
    const recursive = i.flags.has("--recursive") || i.flags.has("-r") || i.flags.has("-R");
    const prof = i.ctx.awsProfile ? [`AWS_PROFILE: ${i.ctx.awsProfile}`] : ["no AWS_PROFILE set, so the default profile applies"];
    if (i.program === "aws" && args[0] === "s3" && (args[1] === "rm" || args[1] === "rb")) {
      return [{ rule: "cloud.s3-rm", severity: recursive || args[1] === "rb" ? "stop" : "confirm", program: i.program, headline: args[1] === "rb" ? `This removes the bucket ${args[2] ?? ""}.`.replace("  ", " ") : `This deletes ${recursive ? "every object under" : ""} ${args[2] ?? "an S3 path"}.`.replace(/\s+/g, " "), facts: [...prof, ...(recursive ? ["--recursive means the whole prefix, with no listing shown first"] : []), ...(i.flags.has("--dryrun") ? ["--dryrun is set, so nothing will actually be deleted"] : [])], recovery: "only if the bucket has versioning on", alternative: "add --dryrun to list what would go" }];
    }
    if ((i.program === "gsutil" || i.program === "gcloud") && /\brm\b/.test(line) && recursive) {
      return [{ rule: "cloud.gcs-rm", severity: "stop", program: i.program, headline: `This deletes everything under ${args[args.length - 1]}.`, facts: ["object versioning is the only thing that would let you undo it"], recovery: null }];
    }
    if (i.program === "rclone" && /\b(delete|purge|sync)\b/.test(line)) {
      return [{ rule: "cloud.rclone", severity: /purge/.test(line) ? "stop" : "confirm", program: i.program, headline: /sync/.test(line) ? "rclone sync deletes anything at the destination that is not at the source." : `rclone ${/purge/.test(line) ? "purge" : "delete"} removes remote data.`, facts: [`command: ${["rclone", ...args].join(" ")}`], recovery: null, alternative: "add --dry-run" }];
    }
    return [];
  },
};

// ---------------------------------------------------------------- docker

const dockerRule: Rule = {
  id: "docker",
  appliesTo: ["docker", "podman", "docker-compose"],
  check(i) {
    const out: Finding[] = [];
    const args = i.operands.map((w) => w.text);
    const line = args.join(" ");
    if (/^system\s+prune/.test(line) || (args[0] === "prune")) {
      const vols = i.flags.has("--volumes"), all = i.flags.has("-a") || i.flags.has("--all");
      out.push({ rule: "docker.prune", severity: vols ? "confirm" : "note", program: i.program, headline: vols ? "This deletes unused volumes, which is where container data lives." : "This deletes stopped containers, unused networks and dangling images.", facts: [...(all ? ["-a also removes every image not used by a running container, so the next build downloads everything again"] : []), ...(vols ? ["a volume that is not attached to a running container counts as unused, including database data from a stopped stack"] : ["volumes are left alone without --volumes"])], recovery: vols ? null : "images and containers can be rebuilt or re-pulled" });
    }
    if (args[0] === "volume" && args[1] === "rm") out.push({ rule: "docker.volume-rm", severity: "confirm", program: i.program, headline: `This deletes the volume ${args.slice(2).join(" ")} and its data.`, facts: [], recovery: null });
    if ((i.program === "docker-compose" || args[0] === "compose") && /\bdown\b/.test(line) && (i.flags.has("-v") || i.flags.has("--volumes"))) out.push({ rule: "docker.compose-down-v", severity: "confirm", program: i.program, headline: "compose down -v deletes the stack's volumes, so database contents go with it.", facts: ["without -v the containers stop but the data stays"], recovery: null, alternative: "docker compose down keeps the volumes" });
    return out;
  },
};

// ---------------------------------------------------------------- disks, permissions, processes

const diskRule: Rule = {
  id: "disk",
  appliesTo: ["dd", "mkfs", "fdisk", "parted", "shred", "wipefs", "diskutil"],
  check(i) {
    const of = [...i.flags].map((f) => /^of=(.+)$/.exec(f)?.[1]).find(Boolean) ?? i.operands.map((w) => /^of=(.+)$/.exec(w.text)?.[1]).find(Boolean);
    const target = of ?? i.operands.find((w) => w.text.startsWith("/dev/"))?.text ?? null;
    if (i.program === "dd" && !of) return [];
    const isDevice = !!target && /^\/dev\//.test(target);
    return [{
      rule: "disk.write", severity: isDevice ? "stop" : "confirm", program: i.program,
      headline: isDevice ? `This writes straight to the device ${target}, past the filesystem.` : `${i.program} overwrites data at ${target ?? "the given target"}.`,
      facts: [...(isDevice ? ["nothing on that device is recoverable afterwards, including partitions you did not mean to touch"] : []), ...(target && existsSync(target) ? [] : target ? [`${target} does not exist right now`] : [])],
      recovery: null,
    }];
  },
};

const permRule: Rule = {
  id: "perm",
  appliesTo: ["chmod", "chown", "chgrp"],
  check(i) {
    const out: Finding[] = [];
    const recursive = i.flags.has("-R") || i.flags.has("--recursive") || i.flags.has("-r");
    const mode = i.operands[0]?.text ?? "";
    const targets = i.operands.slice(1).map((w) => subject(i, w)).flatMap((e) => e.paths);
    for (const p of targets) {
      const place = describePlace(p, i.env);
      if (place && recursive) out.push({ rule: "perm.recursive-special", severity: "stop", program: i.program, headline: `This changes ${i.program === "chmod" ? "permissions" : "ownership"} on ${place}, recursively.`, facts: [`path: ${p}`, "system folders have permissions that programs depend on; changing them all at once usually needs a reinstall to put right"], recovery: null });
    }
    if (i.program === "chmod" && /^(0?777|a\+rwx|ugo\+rwx)$/.test(mode)) out.push({ rule: "perm.777", severity: "confirm", program: "chmod", headline: "Mode 777 lets every user on the machine read, write and run these files.", facts: [...(recursive ? [`applied recursively to ${i.operands.slice(1).map((w) => w.text).join(", ")}`] : []), "SSH keys and many services refuse to work with permissions this open"], recovery: "the old permissions are not stored anywhere, so they have to be set back by hand", alternative: "755 for folders and executables, 644 for files" });
    if (recursive && targets.length) {
      const s = survey(targets, i.ctx.git?.root ?? null);
      if (s.files + s.dirs > 1000) out.push({ rule: "perm.wide", severity: "note", program: i.program, headline: `This touches ${plural(s.files + s.dirs, "path")}.`, facts: [`${plural(s.files, "file")} in ${plural(s.dirs, "folder")}`], recovery: null });
    }
    return out;
  },
};

const procRule: Rule = {
  id: "proc",
  appliesTo: ["kill", "killall", "pkill", "systemctl", "service", "shutdown", "reboot", "halt", "launchctl"],
  check(i) {
    const out: Finding[] = [];
    const args = i.operands.map((w) => w.text);
    if (["shutdown", "reboot", "halt"].includes(i.program)) out.push({ rule: "proc.shutdown", severity: "confirm", program: i.program, headline: `This ${i.program === "reboot" ? "restarts" : "shuts down"} the machine.`, facts: [...(i.ctx.git?.dirty.length ? [`${plural(i.ctx.git.dirty.length, "file")} in this repository ${i.ctx.git.dirty.length === 1 ? "has" : "have"} uncommitted changes`] : []), ...(i.ctx.inContainer ? ["you appear to be in a container, so this would stop the container"] : [])], recovery: null });
    if (i.program === "kill" && args.includes("1")) out.push({ rule: "proc.kill-init", severity: "stop", program: "kill", headline: "PID 1 is the init process; killing it stops the whole system or container.", facts: [], recovery: null });
    if ((i.program === "killall" || i.program === "pkill") && (i.flags.has("-9") || i.flags.has("-KILL"))) out.push({ rule: "proc.kill-9", severity: "note", program: i.program, headline: `SIGKILL gives ${args.join(", ") || "the process"} no chance to save or clean up.`, facts: ["databases and editors can leave a lock file or a half-written file behind"], recovery: null, alternative: `${i.program} ${args.join(" ")} without -9 sends TERM first` });
    if (i.program === "systemctl" && ["stop", "disable", "mask"].includes(args[0] ?? "")) out.push({ rule: "proc.systemctl", severity: args[0] === "mask" ? "confirm" : "note", program: "systemctl", headline: `This ${args[0]}s ${args.slice(1).join(", ") || "a service"}.`, facts: args[0] === "disable" ? ["it will not come back after a reboot"] : [], recovery: `systemctl ${args[0] === "stop" ? "start" : args[0] === "mask" ? "unmask" : "enable"} ${args.slice(1).join(" ")}` });
    return out;
  },
};

// ---------------------------------------------------------------- publishing and the network

const publishRule: Rule = {
  id: "publish",
  appliesTo: ["npm", "yarn", "pnpm", "cargo", "gem", "twine", "pip"],
  check(i) {
    const out: Finding[] = [];
    const args = i.operands.map((w) => w.text);
    const sub = args[0] ?? "";
    if (sub === "publish" || (i.program === "twine" && sub === "upload")) {
      out.push({ rule: "publish.public", severity: "confirm", program: i.program, headline: "This puts a package on a public registry, where the version can never be reused.", facts: [...(i.ctx.git?.dirty.length ? [`${plural(i.ctx.git.dirty.length, "file")} ${i.ctx.git.dirty.length === 1 ? "is" : "are"} uncommitted, so what you publish will not match any commit`] : []), ...(i.ctx.git && !i.ctx.git.onDefaultBranch ? [`you are on ${i.ctx.git.branch}, not ${i.ctx.git.defaultBranch}`] : []), ...(i.flags.has("--dry-run") ? ["--dry-run is set, so nothing will be uploaded"] : [])], recovery: "unpublishing is limited to a short window and the version number stays used forever", alternative: "npm publish --dry-run shows the file list first" });
    }
    if (sub === "unpublish") out.push({ rule: "publish.unpublish", severity: "stop", program: i.program, headline: "Unpublishing breaks every install that depends on this version.", facts: ["the version number can never be published again"], recovery: null });
    if (i.program !== "pip" && sub === "install" && (i.flags.has("-g") || i.flags.has("--global"))) out.push({ rule: "publish.global-install", severity: "note", program: i.program, headline: "A global install puts files outside the project, where nothing records them.", facts: [], recovery: `${i.program} uninstall -g ${args.slice(1).join(" ")}` });
    return out;
  },
};

const netRule: Rule = {
  id: "net",
  appliesTo: ["curl", "wget", "ssh", "scp", "rsync"],
  check(i) {
    const out: Finding[] = [];
    const args = i.operands.map((w) => w.text);
    if (i.program === "rsync" && i.flags.has("--delete")) {
      const dest = args[args.length - 1];
      out.push({ rule: "net.rsync-delete", severity: "confirm", program: "rsync", headline: `--delete removes anything at ${dest} that is not in the source.`, facts: [...(i.flags.has("-n") || i.flags.has("--dry-run") ? ["--dry-run is set, so nothing changes"] : ["without --dry-run the deletions happen immediately"]), ...(args.length >= 2 && !/:/.test(dest) ? [(() => { const p = resolve(i.ctx.cwd, dest); const s = survey([p], null); return `${shorten(p, i.ctx.cwd, i.env)} currently holds ${plural(s.files, "file")}`; })()] : [])], recovery: null, alternative: "rsync -n --delete lists what would be removed" });
    }
    if (i.program === "ssh" && args.length > 1) {
      const remote = args.slice(1).join(" ");
      if (/\brm\s+-[a-z]*[rf]|\bdrop\s+(table|database)\b|\bshutdown\b|\breboot\b|\btruncate\b/i.test(remote)) {
        out.push({ rule: "net.ssh-destructive", severity: "stop", program: "ssh", headline: `This runs a destructive command on ${args[0]}, where nothing local can undo it.`, facts: [`remote command: ${remote}`, "this check cannot see what is on that machine, so it cannot tell you what would be lost"], recovery: null });
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------- find, sed, redirects, pipes to shells

const findRule: Rule = {
  id: "find",
  appliesTo: ["find", "fd"],
  check(i) {
    const argv = i.cmd.argv.map((w) => w.text);
    const deletes = argv.includes("-delete") || /(-exec|-execdir|-x)$/.test("") || argv.some((a, k) => (a === "-exec" || a === "-execdir" || a === "-X" || a === "-x") && /\b(rm|unlink|shred|truncate)\b/.test(argv.slice(k + 1, k + 3).join(" ")));
    if (!deletes) return [];
    const root = i.operands[0] ? subject(i, i.operands[0]) : null;
    const place = root?.paths[0] ? describePlace(root.paths[0], i.env) : null;
    return [{
      rule: "find.delete", severity: place ? "stop" : "confirm", program: i.program,
      headline: `This deletes every match under ${root?.shown ?? "the given path"}${place ? `, which is ${place}` : ""}.`,
      facts: ["find walks into every subfolder unless -maxdepth says otherwise", ...(root?.paths[0] ? [(() => { const s = survey(root.paths, i.ctx.git?.root ?? null); return `${root.shown} currently holds ${plural(s.files, "file")} in ${plural(s.dirs, "folder")}`; })()] : [])],
      recovery: null,
      alternative: `run the same find with -print instead of -delete first`,
    }];
  },
};

const sedRule: Rule = {
  id: "sed",
  appliesTo: ["sed", "perl", "ruby"],
  check(i) {
    const inPlace = [...i.flags].some((f) => f === "-i" || f.startsWith("-i=")) || i.cmd.argv.some((w) => /^-i/.test(w.text) && w.text.length <= 4);
    if (!inPlace) return [];
    const files = i.operands.slice(i.program === "sed" ? 1 : 0).map((w) => subject(i, w)).flatMap((e) => e.paths);
    const g = i.ctx.git;
    const unsaved = g ? uncommittedAmong(g, files) : [];
    // sed -i.bak keeps a backup; sed -i does not. The suffix is attached to the flag, not separate.
    const suffix = i.cmd.argv.slice(1).map((w) => /^-i\.?(.+)$/.exec(w.text)?.[1]).find(Boolean);
    return [{
      rule: "sed.in-place", severity: unsaved.length ? "confirm" : "note", program: i.program,
      headline: `This rewrites ${plural(files.length, "file")} in place${suffix ? ` (a .${suffix.replace(/^\./, "")} backup is kept)` : " with no backup"}.`,
      facts: [...(unsaved.length ? unsaved.slice(0, 4).map((p) => `uncommitted: ${p}`) : g && files.length ? ["the files are committed, so git has a copy"] : [])],
      recovery: unsaved.length ? null : g && files.length ? `git checkout -- ${i.operands.slice(1).map((w) => w.text).slice(0, 3).join(" ")}` : null,
      alternative: suffix ? undefined : i.program === "sed" ? "sed -i.bak keeps the original next to it" : undefined,
    }];
  },
};

const redirectRule: Rule = {
  id: "redirect",
  appliesTo: "any",
  check(i) {
    const out: Finding[] = [];
    for (const r of i.cmd.redirects) {
      if (r.op !== ">" && r.op !== ">|" && r.op !== "&>") continue;
      const e = expand(r.target, i.ctx.cwd, i.env);
      const p = e.paths[0];
      if (!p || e.unknown) continue;
      if (/^\/dev\/(?!null|stdout|stderr|tty|fd)/.test(p)) { out.push({ rule: "redirect.device", severity: "stop", program: i.program, headline: `This writes over the device ${p}.`, facts: [], recovery: null }); continue; }
      if (e.missing) continue;
      let size = 0;
      try { const st = lstatSync(p); if (!st.isFile()) continue; size = st.size; } catch { continue; }
      const g = i.ctx.git;
      const unsaved = g ? uncommittedAmong(g, [p]) : [];
      out.push({
        rule: "redirect.truncate", severity: unsaved.length ? "confirm" : "note", program: i.program,
        headline: `> empties ${shorten(p, i.ctx.cwd, i.env)} before the command writes anything, and it currently holds ${bytes(size)}.`,
        facts: unsaved.length ? [`${shorten(p, i.ctx.cwd, i.env)} has uncommitted changes`] : g && trackedCount(g, [p], i.ctx.cwd) ? ["the file is committed, so git has a copy"] : ["the file is not in git"],
        recovery: unsaved.length ? null : g && trackedCount(g, [p], i.ctx.cwd) ? `git checkout -- ${shorten(p, i.ctx.cwd, i.env)}` : null,
        alternative: ">> appends instead of replacing",
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------- whole-line checks

export interface LineInput { line: string; commands: SimpleCommand[]; ctx: Context; env: NodeJS.ProcessEnv }

/** Rules that need to see the pipeline rather than one command. */
export function lineRules(i: LineInput): Finding[] {
  const out: Finding[] = [];
  const progs = i.commands.map((c) => programName(unwrap(c).cmd));
  for (let k = 0; k < i.commands.length - 1; k++) {
    const c = i.commands[k];
    if (c.then !== "|") continue;
    const next = unwrap(i.commands[k + 1]);
    const nextProg = programName(next.cmd);
    const fetcher = programName(unwrap(c).cmd);
    if (["sh", "bash", "zsh", "python", "python3", "perl", "ruby", "node"].includes(nextProg) && ["curl", "wget", "fetch"].includes(fetcher)) {
      const url = unwrap(c).cmd.argv.map((w) => w.text).find((t) => /^https?:\/\//.test(t)) ?? null;
      out.push({
        rule: "pipe.download-to-shell", severity: next.sudo ? "stop" : "confirm", program: fetcher,
        headline: `This runs whatever that URL returns${next.sudo ? ", as root" : ""}, sight unseen.`,
        facts: [...(url ? [`url: ${url}`] : ["the url is built at run time, so it cannot be shown here"]), "the server can send different content to a browser than to this command", ...(next.sudo ? ["sudo means the script has full control of the machine"] : [])],
        recovery: null,
        alternative: url ? `curl -fsSL ${url} -o install.sh and read it before running it` : "download to a file and read it first",
      });
    }
  }
  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&?\s*\}\s*;?\s*:/.test(i.line)) out.push({ rule: "line.fork-bomb", severity: "stop", program: "shell", headline: "This is a fork bomb: it spawns processes until the machine stops responding.", facts: [], recovery: null });
  if (/\bhistory\s+-c\b/.test(i.line)) out.push({ rule: "line.history-clear", severity: "note", program: "history", headline: "This clears your shell history.", facts: [], recovery: null });
  return out;
}

export const RULES: Rule[] = [rm, gitRule, dbRule, kubectlRule, terraformRule, cloudRule, dockerRule, diskRule, permRule, procRule, publishRule, netRule, findRule, sedRule, redirectRule];

const OPTS_WITH_VALUES = new Set(["-c", "--command", "-e", "--execute", "--eval", "-n", "--namespace", "--context", "-o", "--output", "--replicas", "--prune", "-u", "--user", "-s", "-k", "-q"]);

/** Builds the input a rule sees from one simple command. */
export function ruleInput(cmd: SimpleCommand, ctx: Context, env: NodeJS.ProcessEnv, via: string | null): RuleInput {
  const u = unwrap(cmd);
  const { flags, operands } = splitArgs(u.cmd.argv, OPTS_WITH_VALUES);
  // Assignments on the command itself are part of its environment: FOO=bar rm -rf "$FOO".
  const merged = { ...env };
  for (const a of [...cmd.assigns, ...u.cmd.assigns]) merged[a.name] = a.value.text;
  return { cmd: u.cmd, program: programName(u.cmd), sudo: u.sudo, operands, flags, ctx, env: merged, via };
}
