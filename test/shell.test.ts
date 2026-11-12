import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, unwrap, programName, innerScript } from "../src/shell.ts";

const progs = (line: string) => parse(line).commands.map((c) => programName(unwrap(c).cmd));
const argv = (line: string, n = 0) => parse(line).commands[n].argv.map((w) => w.text);

test("splits on the operators that separate commands", () => {
  assert.deepEqual(progs("ls && rm -rf x"), ["ls", "rm"]);
  assert.deepEqual(progs("a; b | c || d & e"), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(parse("a | b").commands[0].then, "|");
});

test("does not split on a separator inside quotes", () => {
  assert.deepEqual(progs('git commit -m "fix; rm -rf /"'), ["git"]);
  assert.deepEqual(argv('git commit -m "fix; rm -rf /"'), ["git", "commit", "-m", "fix; rm -rf /"]);
  assert.deepEqual(progs("echo 'a && b'"), ["echo"]);
});

test("keeps a quoted glob literal but marks an unquoted one", () => {
  const quoted = parse('rm "a*b"').commands[0].argv[1];
  assert.equal(quoted.glob, false, "a quoted star is not a glob");
  const bare = parse("rm a*b").commands[0].argv[1];
  assert.equal(bare.glob, true);
});

test("records variable references without expanding them", () => {
  const w = parse('rm -rf "$BUILD/dist"').commands[0].argv[2];
  assert.deepEqual(w.vars, ["BUILD"]);
  assert.equal(w.text, "${BUILD}/dist");
  assert.equal(w.dynamic, false);
});

test("marks command substitution as dynamic", () => {
  assert.equal(parse("rm -rf $(cat list)").commands[0].argv[2].dynamic, true);
  assert.equal(parse("rm -rf `cat list`").commands[0].argv[2].dynamic, true);
});

test("strips sudo, env, timeout and nice to find the real program", () => {
  assert.deepEqual(progs("sudo -u www rm -rf /var/www"), ["rm"]);
  assert.equal(unwrap(parse("sudo rm x").commands[0]).sudo, true);
  assert.deepEqual(progs("timeout 5s nice -n 10 rm -r dist"), ["rm"]);
  assert.deepEqual(progs("env FOO=1 rm x"), ["rm"]);
  const u = unwrap(parse("env FOO=1 rm x").commands[0]);
  assert.deepEqual(u.cmd.assigns.map((a) => `${a.name}=${a.value.text}`), ["FOO=1"]);
});

test("reads redirections and their targets", () => {
  const c = parse("echo hi > out.txt 2>&1").commands[0];
  assert.deepEqual(c.redirects.map((r) => `${r.fd}${r.op}${r.target.text}`), ["1>out.txt"]);
  assert.deepEqual(parse("cmd >> log").commands[0].redirects[0].op, ">>");
  assert.deepEqual(parse("cmd &> log").commands[0].redirects[0].op, "&>");
  assert.deepEqual(progs("cmd &> log"), ["cmd"], "&> is a redirection, not a background operator");
});

test("skips a heredoc body instead of reading it as commands", () => {
  const p = parse("cat <<EOF > f\nrm -rf /\nEOF\nls");
  assert.deepEqual(p.commands.map((c) => programName(c)), ["cat", "ls"]);
  assert.deepEqual(p.incomplete, []);
});

test("reports an unclosed heredoc rather than guessing", () => {
  const p = parse("cat <<EOF\nstuff");
  assert.match(p.incomplete.join(" "), /heredoc/);
});

test("reports unterminated quotes", () => {
  assert.match(parse('rm "x').incomplete.join(" "), /double quote/);
  assert.match(parse("rm 'x").incomplete.join(" "), /single quote/);
});

test("finds the command inside bash -c, eval and xargs", () => {
  assert.deepEqual(innerScript(parse('bash -c "rm -rf /tmp/x"').commands[0]), { line: "rm -rf /tmp/x", via: "bash -c" });
  assert.equal(innerScript(parse("eval rm -rf x").commands[0])?.via, "eval");
  assert.equal(innerScript(parse("xargs -n1 rm -f").commands[0])?.line, "rm -f");
  assert.equal(innerScript(parse("ls -la").commands[0]), null);
});

test("marks commands inside a subshell as nested", () => {
  const p = parse("(cd /tmp && rm -rf x)");
  assert.ok(p.commands.every((c) => c.nested));
});

test("takes VAR=value prefixes off the command", () => {
  const c = parse("FOO=bar BAZ=1 rm -rf x").commands[0];
  assert.deepEqual(c.assigns.map((a) => a.name), ["FOO", "BAZ"]);
  assert.equal(programName(c), "rm");
});

test("ignores a comment", () => {
  assert.deepEqual(progs("ls # rm -rf /"), ["ls"]);
});

test("handles an empty or whitespace line", () => {
  assert.deepEqual(parse("").commands, []);
  assert.deepEqual(parse("   \n  ").commands, []);
});
