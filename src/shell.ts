// A POSIX-ish shell tokenizer: enough of bash's grammar to know which programs a line runs,
// with which arguments, redirections and variable references. It never executes anything.

/** One shell word, with what we could learn about it before expansion. */
export interface Word {
  /** Text with quotes removed. Variable references stay as $NAME so expansion can be done later. */
  text: string;
  /** Exactly as typed. */
  raw: string;
  /** Names of variables referenced ($X, ${X}), in order. */
  vars: string[];
  /** Contains $(...) or `...`: the value cannot be known without running code. */
  dynamic: boolean;
  /** Contains an unquoted *, ? or [: the shell would glob it. */
  glob: boolean;
  /** Starts with an unquoted ~. */
  tilde: boolean;
  /** Parts of text that came from quotes (so a later glob/tilde pass leaves them alone). */
  quotedSpans: [number, number][];
}

export interface Redirect { fd: number; op: ">" | ">>" | "<" | ">|" | "&>" | ">&" | "<<" | "<<<"; target: Word }

export interface SimpleCommand {
  argv: Word[];
  /** VAR=value prefixes. */
  assigns: { name: string; value: Word }[];
  redirects: Redirect[];
  /** Separator that ended this command: ";", "&&", "||", "|", "&" or "" at the end. */
  then: string;
  /** Runs inside ( ... ) or $( ... ) or a function body. */
  nested: boolean;
}

export interface Parsed { commands: SimpleCommand[]; /** Something we could not follow, such as an unterminated quote or a heredoc body. */ incomplete: string[] }

const OPERATORS = ["&&", "||", ";;", "|&", ";", "|", "&", "\n"];

function emptyWord(): Word { return { text: "", raw: "", vars: [], dynamic: false, glob: false, tilde: false, quotedSpans: [] }; }

/** Reads $NAME, ${NAME...}, $(...), $((...)) or `...` starting at s[i] (which is $ or `). Returns the end index and what it found. */
function readDollar(s: string, i: number): { end: number; name?: string; dynamic?: boolean; literal?: string } {
  if (s[i] === "`") {
    let j = i + 1;
    while (j < s.length && s[j] !== "`") j += s[j] === "\\" ? 2 : 1;
    return { end: Math.min(j + 1, s.length), dynamic: true };
  }
  const c = s[i + 1];
  if (c === "(") {
    let depth = 0, j = i + 1;
    for (; j < s.length; j++) {
      if (s[j] === "(") depth++;
      else if (s[j] === ")") { depth--; if (depth === 0) break; }
      else if (s[j] === "'") { const k = s.indexOf("'", j + 1); j = k < 0 ? s.length : k; }
    }
    return { end: Math.min(j + 1, s.length), dynamic: true };
  }
  if (c === "{") {
    const j = s.indexOf("}", i + 2);
    const inner = s.slice(i + 2, j < 0 ? s.length : j);
    const m = /^[#!]?([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])/.exec(inner);
    // ${X:-default} and friends still depend on X, but the default makes an empty X less dangerous.
    const hasDefault = /^[A-Za-z_][A-Za-z0-9_]*:?[-=+?]/.test(inner);
    return { end: j < 0 ? s.length : j + 1, name: m ? m[1] : undefined, dynamic: hasDefault || /^[#!]/.test(inner) ? true : undefined };
  }
  const m = /^([A-Za-z_][A-Za-z0-9_]*|[0-9]|[@*#?$!-])/.exec(s.slice(i + 1));
  if (!m) return { end: i + 1, literal: "$" };
  return { end: i + 1 + m[1].length, name: m[1] };
}

/** Splits a command line into simple commands. */
export function parse(line: string): Parsed {
  const commands: SimpleCommand[] = [];
  const incomplete: string[] = [];
  let words: Word[] = [];
  let cur: Word | null = null;
  let depth = 0;
  let pendingRedirect: { fd: number; op: Redirect["op"] } | null = null;
  let redirects: Redirect[] = [];
  let heredocs: string[] = [];

  const finishWord = () => {
    if (!cur) return;
    if (pendingRedirect) { redirects.push({ ...pendingRedirect, target: cur }); pendingRedirect = null; }
    else words.push(cur);
    cur = null;
  };
  const finishCommand = (then: string) => {
    finishWord();
    if (pendingRedirect) { incomplete.push(`redirection "${pendingRedirect.op}" has no target`); pendingRedirect = null; }
    const assigns: SimpleCommand["assigns"] = [];
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0].raw)) {
      const w = words.shift()!;
      const eq = w.text.indexOf("=");
      assigns.push({ name: w.text.slice(0, eq), value: { ...w, text: w.text.slice(eq + 1), raw: w.raw.slice(w.raw.indexOf("=") + 1) } });
    }
    if (words.length || assigns.length || redirects.length) commands.push({ argv: words, assigns, redirects, then, nested: depth > 0 });
    words = []; redirects = [];
  };

  let i = 0;
  while (i < line.length) {
    const ch = line[i];

    // Heredoc bodies follow the line they were introduced on; we skip them.
    if (ch === "\n" && heredocs.length) {
      const delim = heredocs.shift()!;
      const end = line.indexOf(`\n${delim}\n`, i);
      const endAtEof = line.endsWith(`\n${delim}`) ? line.length - delim.length - 1 : -1;
      const stop = end >= 0 ? end : endAtEof;
      finishCommand(";");
      if (stop < 0) { incomplete.push(`heredoc "${delim}" is not closed`); break; }
      i = stop + delim.length + 2;
      continue;
    }

    if (!cur && ch === "#") { // comment to end of line
      const nl = line.indexOf("\n", i);
      i = nl < 0 ? line.length : nl;
      continue;
    }

    if (ch === " " || ch === "\t") { finishWord(); i++; continue; }
    if (ch === "\\" && line[i + 1] === "\n") { i += 2; continue; }

    // &> and &>> are redirections, not the background operator, so they are checked first.
    if (!line.startsWith("&>", i)) {
      const op = OPERATORS.find((o) => line.startsWith(o, i));
      if (op) { finishCommand(op === "\n" ? ";" : op); i += op.length; continue; }
    }

    if (ch === "(" || ch === ")" || ((ch === "{" || ch === "}") && !cur && /[\s;]/.test(line[i + 1] ?? " "))) {
      finishCommand(";");
      if (ch === "(" || ch === "{") depth++; else depth = Math.max(0, depth - 1);
      i++;
      continue;
    }

    // Redirections: [n]> [n]>> < >| &> [n]>&m << <<< (only at a word boundary or after digits)
    const redir = /^(\d*)(&>>?|>>|>\||>&|<<<|<<-?|>|<)/.exec(line.slice(i));
    if (redir && (!cur || /^\d+$/.test(cur.raw))) {
      const fd = cur && /^\d+$/.test(cur.raw) ? Number(cur.raw) : redir[2].startsWith("<") ? 0 : 1;
      cur = null;
      finishWord();
      let op = redir[2].replace("-", "") as Redirect["op"];
      if (op === ("&>>" as string)) op = "&>";
      i += redir[0].length;
      // 2>&1 style: the target is a file descriptor, not a file.
      if (op === ">&") { const m = /^\s*(\d+|-)/.exec(line.slice(i)); if (m) { i += m[0].length; continue; } }
      pendingRedirect = { fd, op };
      if (op === "<<") {
        const m = /^\s*(['"]?)([A-Za-z0-9_]+)\1/.exec(line.slice(i));
        if (m) { heredocs.push(m[2]); redirects.push({ fd, op, target: { ...emptyWord(), text: m[2], raw: m[0].trim() } }); pendingRedirect = null; i += m[0].length; }
      }
      continue;
    }

    if (cur === null) cur = emptyWord();
    const w: Word = cur;
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) { incomplete.push("unterminated single quote"); w.raw += line.slice(i); const start = w.text.length; w.text += line.slice(i + 1); w.quotedSpans.push([start, w.text.length]); break; }
      const start = w.text.length;
      w.text += line.slice(i + 1, end);
      w.quotedSpans.push([start, w.text.length]);
      w.raw += line.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === "\"") {
      let j = i + 1;
      const start = w.text.length;
      let closed = false;
      while (j < line.length) {
        const c = line[j];
        if (c === "\"") { closed = true; break; }
        if (c === "\\" && j + 1 < line.length && "$`\"\\\n".includes(line[j + 1])) { w.text += line[j + 1]; j += 2; continue; }
        if (c === "$" || c === "`") {
          const d = readDollar(line, j);
          if (d.name) { w.vars.push(d.name); w.text += "$" + `{${d.name}}`; }
          if (d.dynamic) w.dynamic = true;
          if (d.literal) w.text += d.literal;
          j = d.end;
          continue;
        }
        w.text += c; j++;
      }
      w.quotedSpans.push([start, w.text.length]);
      w.raw += line.slice(i, Math.min(j + 1, line.length));
      if (!closed) { incomplete.push("unterminated double quote"); i = line.length; break; }
      i = j + 1;
      continue;
    }
    if (ch === "\\") { w.text += line[i + 1] ?? ""; const start = w.text.length - 1; w.quotedSpans.push([start, w.text.length]); w.raw += line.slice(i, i + 2); i += 2; continue; }
    if (ch === "$" || ch === "`") {
      const d = readDollar(line, i);
      if (d.name) { w.vars.push(d.name); w.text += "$" + `{${d.name}}`; }
      if (d.dynamic) w.dynamic = true;
      if (d.literal) w.text += d.literal;
      w.raw += line.slice(i, d.end);
      i = d.end;
      continue;
    }
    if (ch === "~" && w.raw === "") w.tilde = true;
    if (ch === "*" || ch === "?" || (ch === "[" && line.indexOf("]", i) > i)) w.glob = true;
    w.text += ch; w.raw += ch; i++;
  }
  finishCommand("");
  return { commands, incomplete };
}

/** Program name without its directory: /usr/bin/rm -> rm. */
export function programName(cmd: SimpleCommand): string {
  const w = cmd.argv[0];
  if (!w) return "";
  return w.text.replace(/^.*\//, "");
}

const WRAPPERS = new Set(["sudo", "doas", "nohup", "time", "nice", "ionice", "command", "builtin", "exec", "env", "stdbuf", "timeout", "caffeinate", "chronic", "unbuffer"]);

/** Strips sudo, env, nohup, time, timeout and similar so the rule sees the real program. Reports whether sudo was involved. */
export function unwrap(cmd: SimpleCommand): { cmd: SimpleCommand; sudo: boolean; wrappers: string[] } {
  let argv = cmd.argv.slice();
  const wrappers: string[] = [];
  let sudo = false;
  const assigns = cmd.assigns.slice();
  while (argv.length && WRAPPERS.has(argv[0].text.replace(/^.*\//, ""))) {
    const w = argv.shift()!.text.replace(/^.*\//, "");
    wrappers.push(w);
    if (w === "sudo" || w === "doas") sudo = true;
    // Drop the wrapper's own options. sudo -u user, timeout 5s, nice -n 10, env -i VAR=x.
    const withValue: Record<string, string[]> = { sudo: ["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U"], nice: ["-n"], ionice: ["-c", "-n", "-p"], timeout: ["-s", "-k", "--signal", "--kill-after"], env: ["-u", "-C", "-S"], stdbuf: ["-i", "-o", "-e"] };
    while (argv.length && argv[0].text.startsWith("-") && argv[0].text !== "--") {
      const o = argv.shift()!.text;
      if ((withValue[w] ?? []).includes(o)) argv.shift();
    }
    if (argv[0]?.text === "--") argv.shift();
    if (w === "timeout" && argv.length && /^[0-9.]+[smhd]?$/.test(argv[0].text)) argv.shift();
    if (w === "env") while (argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0].text)) { const a = argv.shift()!; const eq = a.text.indexOf("="); assigns.push({ name: a.text.slice(0, eq), value: { ...a, text: a.text.slice(eq + 1) } }); }
  }
  return { cmd: { ...cmd, argv, assigns }, sudo, wrappers };
}

/** If the command is `bash -c "..."`, `sh -c '...'`, `eval ...` or `xargs <cmd>`, returns the inner command line. */
export function innerScript(cmd: SimpleCommand): { line: string; via: string } | null {
  const p = programName(cmd);
  const args = cmd.argv.slice(1).map((w) => w.text);
  if (["bash", "sh", "zsh", "dash", "ksh", "fish"].includes(p)) {
    const c = args.findIndex((a) => a === "-c" || (/^-[a-z]*c[a-z]*$/.test(a) && !a.startsWith("--")));
    if (c >= 0 && args[c + 1] !== undefined) return { line: args[c + 1], via: `${p} -c` };
  }
  if (p === "eval" && args.length) return { line: args.join(" "), via: "eval" };
  if (p === "xargs") {
    let k = 0;
    const withValue = new Set(["-I", "-n", "-P", "-L", "-d", "-a", "-E", "-s", "--max-args", "--max-procs", "--delimiter", "--arg-file"]);
    while (k < args.length && args[k].startsWith("-")) { if (withValue.has(args[k])) k++; k++; }
    if (k < args.length) return { line: cmd.argv.slice(1 + k).map((w) => w.raw).join(" "), via: "xargs" };
  }
  if (p === "ssh") return null; // runs elsewhere; handled by the rules as remote
  return null;
}
