// Turning the words of a command into the files it would really touch.
// Globs are matched against the filesystem, not guessed at, because "rm -rf build/*" is
// harmless or ruinous depending on what is in build/.

import { readdirSync, lstatSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join, sep, isAbsolute, dirname, basename, relative } from "node:path";
import type { Word } from "./shell.ts";

export interface Expansion {
  /** Absolute paths this word resolves to. Empty when unknown. */
  paths: string[];
  /** The value could not be worked out without running something. */
  unknown: boolean;
  /** Why it is unknown, in words. */
  why?: string;
  /** The word looked like a path but matched nothing on disk. */
  missing?: boolean;
}

/** Translates a shell glob segment into a regular expression. */
function globToRegExp(seg: string): RegExp {
  let out = "^";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "[") {
      const end = seg.indexOf("]", i + 1);
      if (end < 0) out += "\\[";
      else { let cls = seg.slice(i + 1, end); if (cls.startsWith("!")) cls = "^" + cls.slice(1); out += `[${cls}]`; i = end; }
    } else out += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(out + "$");
}

const hasGlobChars = (s: string) => /[*?[]/.test(s);

/** Lists the entries of a directory, or nothing if it cannot be read. */
function ls(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

/** Expands one glob pattern against the filesystem. Dotfiles only match when the pattern starts with a dot, as in bash. */
function globMatch(pattern: string, cwd: string): string[] {
  const absolute = isAbsolute(pattern);
  const segs = pattern.split("/").filter((s, i) => s !== "" || i === 0);
  let heads: string[] = [absolute ? "/" : cwd];
  for (const seg of segs) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { heads = heads.map((h) => dirname(h)); continue; }
    if (!hasGlobChars(seg)) { heads = heads.map((h) => join(h, seg)); continue; }
    const re = globToRegExp(seg);
    const next: string[] = [];
    for (const h of heads) for (const name of ls(h)) {
      if (name.startsWith(".") && !seg.startsWith(".")) continue;
      if (re.test(name)) next.push(join(h, name));
    }
    heads = next;
    if (!heads.length) break;
  }
  return heads;
}

/** Resolves a word to paths, as far as that can be done without executing anything. */
export function expand(w: Word, cwd: string, env: NodeJS.ProcessEnv = process.env): Expansion {
  if (w.dynamic) return { paths: [], unknown: true, why: "it contains a command substitution, so its value is only known when it runs" };
  let text = w.text;
  // Substitute variables we can see; anything else makes the word unknown.
  const unresolved: string[] = [];
  text = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])\}/g, (_m, name: string) => {
    const v = env[name];
    if (v === undefined) { unresolved.push(name); return `\u0000${name}\u0000`; }
    return v;
  });
  if (unresolved.length) {
    const empty = unresolved.filter((n) => env[n] === undefined);
    return { paths: [], unknown: true, why: `$${empty[0]} is not set in this shell, so the path is not known${/\u0000[^\u0000]*\u0000\/?$/.test(text) ? "" : ""}` };
  }
  if (w.tilde) {
    const home = env.HOME || homedir();
    text = text.replace(/^~(?=$|\/)/, home);
  }
  const unquotedGlob = w.glob && hasGlobChars(text);
  if (unquotedGlob) {
    const paths = globMatch(text, cwd);
    return { paths, unknown: false, missing: paths.length === 0 };
  }
  const p = resolve(cwd, text);
  let missing = false;
  try { lstatSync(p); } catch { missing = true; }
  return { paths: [p], unknown: false, missing };
}

export interface Survey {
  /** Regular files that would be affected. */
  files: number;
  dirs: number;
  bytes: number;
  /** Paths that are not under the repository (or under cwd when there is no repository). */
  outside: string[];
  /** Symlinks encountered, which rm would remove without touching the target. */
  symlinks: number;
  /** We stopped counting at the cap. */
  truncated: boolean;
  /** The deepest paths found, for showing an example. */
  examples: string[];
}

const CAP = 20_000;

/** Walks the given paths and counts what is there. Never follows symlinks. */
export function survey(paths: string[], boundary: string | null): Survey {
  const s: Survey = { files: 0, dirs: 0, bytes: 0, outside: [], symlinks: 0, truncated: false, examples: [] };
  const stack: string[] = [];
  for (const p of paths) {
    if (boundary && !isInside(p, boundary)) s.outside.push(p);
    stack.push(p);
  }
  let seen = 0;
  while (stack.length) {
    const p = stack.pop()!;
    if (++seen > CAP) { s.truncated = true; break; }
    let st;
    try { st = lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) { s.symlinks++; if (s.examples.length < 4) s.examples.push(p); continue; }
    if (st.isDirectory()) {
      s.dirs++;
      for (const name of ls(p)) stack.push(join(p, name));
      continue;
    }
    s.files++;
    s.bytes += st.size;
    if (s.examples.length < 4) s.examples.push(p);
  }
  return s;
}

/** True when child is the same path as parent or sits under it. Pure string work, no symlink resolution. */
export function isInside(child: string, parent: string): boolean {
  const r = relative(parent, child);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

/** Where a path sits relative to a few places worth warning about. */
export function describePlace(p: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const home = env.HOME || homedir();
  if (p === "/") return "the whole filesystem";
  if (p === home) return "your entire home folder";
  if (["/usr", "/etc", "/var", "/bin", "/sbin", "/lib", "/boot", "/System", "/Library"].includes(p)) return `the system folder ${p}`;
  if (/^\/dev\/(sd|nvme|disk|hd)/.test(p)) return `the raw disk device ${p}`;
  const special: Record<string, string> = { ".ssh": "your SSH keys", ".aws": "your AWS credentials", ".gnupg": "your GPG keys", ".kube": "your cluster credentials", ".config": "your application settings" };
  for (const [name, what] of Object.entries(special)) if (p === join(home, name) || isInside(p, join(home, name))) return what;
  if (basename(p) === ".git") return "the repository's own history";
  return null;
}

export const shorten = (p: string, cwd: string, env: NodeJS.ProcessEnv = process.env): string => {
  const home = env.HOME || homedir();
  if (isInside(p, cwd) && p !== cwd) return relative(cwd, p) || ".";
  if (p === home) return "~";
  if (isInside(p, home)) return "~" + sep + relative(home, p);
  return p;
};

export { readlinkSync };
