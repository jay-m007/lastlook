import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, cleanup, look, ruleIds, find, allText } from "./helpers.ts";

after(cleanup);

const many = (n: number, prefix = "f") => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}.tmp`, "x"]));

test("rm of a committed file is only a note, and says how to get it back", () => {
  const root = makeRepo({ committed: { "src/a.ts": "a" } });
  const r = look("rm src/a.ts", root);
  assert.equal(r.severity, "note");
  assert.match(find(r, "rm.tracked")!.recovery!, /git checkout/);
});

test("rm of a file with uncommitted changes needs a check and offers a stash", () => {
  const root = makeRepo({ committed: { "src/a.ts": "a" }, modified: { "src/a.ts": "changed" } });
  const r = look("rm src/a.ts", root);
  assert.equal(r.severity, "confirm");
  const f = find(r, "rm.uncommitted")!;
  assert.match(f.headline, /not committed/);
  assert.equal(f.recovery, null, "there is nothing to recover uncommitted changes from");
  assert.match(f.facts.join(" "), /git has no copy of these changes/);
  assert.match(f.alternative!, /git stash push/);
});

test("rm counts the files inside an untracked folder rather than saying one", () => {
  const root = makeRepo({ committed: { "a.ts": "a" }, untracked: Object.fromEntries(Object.entries(many(30)).map(([k, v]) => [`build/${k}`, v])) });
  const r = look("rm -rf build", root);
  assert.match(find(r, "rm.untracked-in-repo")!.headline, /30 files are not in git/);
});

test("rm reports paths outside the repository separately", () => {
  const root = makeRepo({ committed: { "a.ts": "a" }, outside: { "elsewhere/keep.txt": "k" } });
  const r = look("rm -rf ../elsewhere", root);
  assert.ok(ruleIds(r).includes("rm.outside-repo"));
  assert.match(allText(r), /elsewhere/);
});

test("an unset variable that would collapse to the root directory is a stop", () => {
  const root = makeRepo({ committed: { "a.ts": "a" } });
  const r = look('rm -rf "$BUILD/"', root);
  assert.equal(r.severity, "stop");
  const f = find(r, "rm.unset-variable")!;
  assert.match(f.headline, /whole filesystem/);
  assert.match(f.facts.join(" "), /rm -rf \//, "it shows the command the shell would really run");
  assert.match(f.alternative!, /\$\{BUILD:\?/);
});

test("the same variable set to a real folder is not a stop", () => {
  const root = makeRepo({ committed: { "a.ts": "a" }, untracked: { "build/x": "x" } });
  const r = look('rm -rf "$BUILD"', root, { BUILD: "build" });
  assert.notEqual(r.severity, "stop");
  assert.ok(!ruleIds(r).includes("rm.unset-variable"));
});

test("rm of the root, home or an ssh folder is always a stop", () => {
  const root = makeRepo({});
  for (const target of ["/", "~", "~/.ssh"]) {
    const r = look(`rm -rf ${target}`, root);
    assert.equal(r.severity, "stop", `${target} should stop`);
  }
});

test("a glob matching far more than expected is flagged with an example", () => {
  const root = makeRepo({ untracked: many(40) });
  const r = look("rm -f *.tmp", root);
  const f = find(r, "rm.wide-glob")!;
  assert.match(f.headline, /matches 40 paths/);
  assert.match(f.alternative!, /echo/);
});

test("rm of something that is not there says so instead of inventing a count", () => {
  const root = makeRepo({});
  const r = look("rm -f nope.txt", root);
  assert.match(find(r, "rm.nothing-there")!.headline, /Nothing at/);
});

test("a path built by a command substitution is reported as unknowable", () => {
  const root = makeRepo({ committed: { "a.ts": "a" } });
  const r = look("rm -rf $(cat list.txt)", root);
  assert.match(find(r, "rm.unknown-target")!.facts.join(" "), /command substitution/);
});

test("force push without a lease is a check, and a stop on the default branch", () => {
  const root = makeRepo({ committed: { "a.ts": "a" }, branch: "main", withUpstream: true });
  const plain = look("git push --force origin main", root);
  assert.equal(plain.severity, "stop");
  assert.match(find(plain, "git.force-push")!.alternative!, /force-with-lease/);
  const other = look("git push --force origin feature-x", root);
  assert.equal(other.severity, "confirm");
});

test("force push says plainly when there is no upstream to compare with", () => {
  const root = makeRepo({ committed: { "a.ts": "a" }, branch: "main" });
  const r = look("git push -f origin main", root);
  assert.match(find(r, "git.force-push")!.facts.join(" "), /no upstream/);
});

test("a mirror push is a stop", () => {
  const root = makeRepo({ committed: { "a.ts": "a" } });
  assert.equal(look("git push --mirror origin", root).severity, "stop");
});

test("reset --hard is a check when the tree is dirty and a note when it is clean", () => {
  const dirty = makeRepo({ committed: { "a.ts": "a" }, modified: { "a.ts": "b" } });
  assert.equal(look("git reset --hard HEAD~1", dirty).severity, "confirm");
  const clean = makeRepo({ committed: { "a.ts": "a" } });
  const r = look("git reset --hard HEAD~1", clean);
  assert.equal(r.severity, "note");
  assert.match(find(r, "git.reset-hard")!.facts.join(" "), /working tree is clean/);
  assert.match(find(r, "git.reset-hard")!.recovery!, /reflog/);
});

test("git clean -fdx names what ignored files usually are", () => {
  const root = makeRepo({ committed: { "a.ts": "a" }, untracked: { ".env": "SECRET=1", "node_modules/x/p.js": "x" } });
  const r = look("git clean -fdx", root);
  assert.match(find(r, "git.clean")!.facts.join(" "), /\.env/);
  assert.match(find(r, "git.clean")!.alternative!, /-ndx/);
});

test("deleting rows with no where clause is a check, and a stop against production", () => {
  const root = makeRepo({});
  const dev = look(`psql -c "DELETE FROM users"`, root, { DATABASE_URL: "postgres://u:p@localhost:5432/dev" });
  assert.equal(dev.severity, "confirm");
  assert.match(find(dev, "sql.no-where")!.headline, /every row/);
  assert.ok(!allText(dev).includes("u:p@"), "the password must never be shown");
  const prod = look(`psql -c "DELETE FROM users"`, root, { DATABASE_URL: "postgres://u:p@db.prod.internal:5432/app" });
  assert.equal(prod.severity, "stop");
  assert.match(allText(prod), /db\.prod\.internal/);
});

test("a delete with a where clause is only reported as destructive, not as a whole-table wipe", () => {
  const root = makeRepo({});
  const r = look(`psql -c "DELETE FROM users WHERE id = 3"`, root);
  assert.ok(!ruleIds(r).includes("sql.no-where"));
  assert.ok(ruleIds(r).includes("sql.destructive"));
});

test("sql inside a comment does not count", () => {
  const root = makeRepo({});
  const r = look(`psql -c "SELECT 1 -- DROP TABLE users"`, root);
  assert.deepEqual(r.findings.filter((f) => f.rule.startsWith("sql")), []);
});

test("kubectl delete --all is a stop and names the cluster it would hit", () => {
  const root = makeRepo({});
  const kube = makeRepo({ outside: { "kube/config": "current-context: prod-eu-1\n" } });
  const r = look("kubectl delete pods --all", root, { KUBECONFIG: `${kube}/../kube/config` });
  assert.equal(r.severity, "stop");
  assert.match(find(r, "kubectl.delete")!.facts.join(" "), /prod-eu-1/);
});

test("kubectl says plainly when it cannot read a cluster name", () => {
  const root = makeRepo({});
  const r = look("kubectl delete deployment web", root, { KUBECONFIG: "/nonexistent" });
  assert.match(find(r, "kubectl.delete")!.facts.join(" "), /no current cluster/);
});

test("terraform destroy is a stop and notes whether a plan will be shown", () => {
  const root = makeRepo({});
  const r = look("terraform destroy -auto-approve", root);
  assert.equal(r.severity, "stop");
  assert.match(find(r, "terraform.destroy")!.facts.join(" "), /no plan will be shown/);
  const asked = look("terraform destroy", root);
  assert.match(find(asked, "terraform.destroy")!.facts.join(" "), /will show a plan/);
});

test("docker prune only warns about volumes when --volumes is given", () => {
  const root = makeRepo({});
  assert.equal(look("docker system prune", root).severity, "note");
  const vols = look("docker system prune -a --volumes", root);
  assert.equal(vols.severity, "confirm");
  assert.match(find(vols, "docker.prune")!.headline, /volumes/);
});

test("compose down -v is separated from a plain compose down", () => {
  const root = makeRepo({});
  assert.deepEqual(look("docker compose down", root).findings, []);
  assert.match(find(look("docker compose down -v", root), "docker.compose-down-v")!.alternative!, /keeps the volumes/);
});

test("curl piped into a shell is a check, and a stop with sudo", () => {
  const root = makeRepo({});
  const plain = look("curl -fsSL https://example.com/i.sh | bash", root);
  assert.equal(plain.severity, "confirm");
  assert.match(find(plain, "pipe.download-to-shell")!.facts.join(" "), /example\.com/);
  assert.equal(look("curl -fsSL https://example.com/i.sh | sudo bash", root).severity, "stop");
});

test("dd to a device is a stop; dd to a file is a check", () => {
  const root = makeRepo({});
  assert.equal(look("dd if=a.img of=/dev/sda bs=4M", root).severity, "stop");
  assert.equal(look("dd if=a.img of=out.img", root).severity, "confirm");
});

test("chmod 777 explains what it opens up, and -R on a system folder is a stop", () => {
  const root = makeRepo({ committed: { "a.ts": "a" } });
  assert.match(find(look("chmod 777 a.ts", root), "perm.777")!.headline, /every user/);
  assert.equal(look("chmod -R 755 /usr", root).severity, "stop");
});

test("find -delete is a check and offers -print first", () => {
  const root = makeRepo({ untracked: many(5) });
  const r = look("find . -name '*.tmp' -delete", root);
  assert.match(find(r, "find.delete")!.alternative!, /-print/);
});

test("find -exec rm is caught as well as -delete", () => {
  const root = makeRepo({ untracked: many(3) });
  assert.ok(ruleIds(look("find . -name '*.tmp' -exec rm {} ;", root)).includes("find.delete"));
});

test("sed -i warns only when the file has unsaved changes, and knows about a backup suffix", () => {
  const root = makeRepo({ committed: { "a.ts": "a" }, modified: { "a.ts": "b" } });
  assert.equal(look("sed -i s/a/b/ a.ts", root).severity, "confirm");
  const clean = makeRepo({ committed: { "a.ts": "a" } });
  const r = look("sed -i.bak s/a/b/ a.ts", clean);
  assert.match(find(r, "sed.in-place")!.headline, /backup is kept/);
});

test("a truncating redirect reports the file size it would wipe", () => {
  const root = makeRepo({ committed: { "data.json": "x".repeat(2048) }, modified: { "data.json": "y".repeat(3000) } });
  const r = look("echo {} > data.json", root);
  const f = find(r, "redirect.truncate")!;
  assert.match(f.headline, /2\.9 KB|3\.0 KB|2\.9 KB/);
  assert.match(f.alternative!, />> appends/);
  assert.equal(f.severity, "confirm");
});

test("appending is never flagged", () => {
  const root = makeRepo({ committed: { "log.txt": "x" } });
  assert.deepEqual(look("echo hi >> log.txt", root).findings, []);
});

test("rsync --delete reports what is at the destination", () => {
  const root = makeRepo({ untracked: { "dest/a": "1", "dest/b": "2" } });
  const r = look("rsync -a src/ dest/ --delete", root);
  assert.match(find(r, "net.rsync-delete")!.facts.join(" "), /2 files/);
});

test("ssh running a destructive command is a stop and admits it cannot see the other machine", () => {
  const root = makeRepo({});
  const r = look('ssh web01 "rm -rf /var/lib/app"', root);
  assert.equal(r.severity, "stop");
  assert.match(find(r, "net.ssh-destructive")!.facts.join(" "), /cannot see what is on that machine/);
});

test("npm publish mentions uncommitted files and the branch", () => {
  const root = makeRepo({ committed: { "package.json": "{}" }, modified: { "package.json": "{ }" }, branch: "feature" });
  const r = look("npm publish", root);
  assert.match(find(r, "publish.public")!.facts.join(" "), /uncommitted/);
  assert.match(find(r, "publish.public")!.facts.join(" "), /feature/);
});

test("a dry run is noticed and said out loud", () => {
  const root = makeRepo({ committed: { "package.json": "{}" } });
  assert.match(find(look("npm publish --dry-run", root), "publish.public")!.facts.join(" "), /nothing will be uploaded/);
  assert.match(find(look("aws s3 rm s3://b/x --recursive --dryrun", makeRepo({})), "cloud.s3-rm")!.facts.join(" "), /nothing will actually be deleted/);
});

test("aws s3 rm --recursive is a stop and names the profile in use", () => {
  const root = makeRepo({});
  const r = look("aws s3 rm s3://bucket/prefix --recursive", root, { AWS_PROFILE: "prod" });
  assert.equal(r.severity, "stop");
  assert.match(find(r, "cloud.s3-rm")!.facts.join(" "), /prod/);
});

test("a destructive command hidden in bash -c is still found, and says how it was reached", () => {
  const root = makeRepo({ committed: { "a.ts": "a" } });
  const r = look('bash -c "rm -rf /"', root);
  assert.equal(r.severity, "stop");
  assert.match(allText(r), /reached through bash -c/);
});

test("a fork bomb is recognised", () => {
  assert.equal(look(":(){ :|:& };:", makeRepo({})).severity, "stop");
});

test("kill 1 is a stop", () => {
  assert.equal(look("kill 1", makeRepo({})).severity, "stop");
});

test("ordinary commands produce nothing at all", () => {
  const root = makeRepo({ committed: { "a.ts": "a", "package.json": "{}" } });
  for (const line of ["ls -la", "git status", "npm test", "cat a.ts", "grep -r foo src", "git commit -m wip", "docker ps", "kubectl get pods", "echo hello > /dev/null", "npm run build", "git log --oneline | head -20", "mkdir -p build"]) {
    assert.deepEqual(look(line, root).findings, [], `${line} should be silent`);
  }
});

test("a broken rule is reported but never stops the review", () => {
  const root = makeRepo({});
  const r = look("rm -rf /proc/1/mem", root);
  assert.ok(r.severity !== null);
});

test("an unterminated quote is reported as an incomplete check", () => {
  const r = look('rm -rf "x', makeRepo({}));
  assert.ok(ruleIds(r).includes("parse.incomplete"));
});

test("the review stays quick on a big folder", () => {
  const root = makeRepo({ untracked: many(400) });
  const r = look("rm -rf .", root);
  assert.ok(r.ms < 2000, `review took ${r.ms} ms`);
});

test("a plural kubernetes resource reads correctly after \"every\"", () => {
  const root = makeRepo({});
  for (const [resource, expected] of [["pods", "every pod in"], ["deployments", "every deployment in"], ["ingresses", "every ingress in"], ["policies", "every policy in"]] as const) {
    const r = look(`kubectl delete ${resource} --all`, root);
    assert.match(find(r, "kubectl.delete")!.headline, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${resource} read wrongly`);
  }
});
