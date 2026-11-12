import { test, after } from "node:test";
import assert from "node:assert/strict";
import { startFake } from "./fake-ollama.ts";
import { explain, factSheet, oneSentence } from "../src/explain.ts";
import { makeRepo, cleanup, look } from "./helpers.ts";

after(cleanup);

const opts = (host: string, budgetMs = 2000) => ({ host, model: "test-model", budgetMs });

test("the summary is used when the model answers in time", async () => {
  const fake = await startFake();
  fake.replies.push({ summary: "This deletes 41 files, 1 of them outside the repository." });
  const root = makeRepo({ committed: { "a.ts": "a" }, outside: { "x/y.txt": "y" } });
  const x = await explain(look("rm -rf ../x", root), opts(fake.host));
  assert.match(x.summary!, /outside the repository/);
  await fake.close();
});

test("a slow model is abandoned at the budget and the review still stands", async () => {
  const fake = await startFake();
  fake.replies.push(900);
  const root = makeRepo({ committed: { "a.ts": "a" } });
  const started = Date.now();
  const x = await explain(look("rm -rf /", root), opts(fake.host, 150));
  const took = Date.now() - started;
  assert.equal(x.summary, null);
  assert.match(x.skipped!, /no answer within 150 ms/);
  assert.ok(took < 700, `gave up after ${took} ms, which is past the budget`);
  await fake.close();
});

test("an Ollama that is not running is reported, not thrown", async () => {
  const root = makeRepo({ committed: { "a.ts": "a" } });
  const x = await explain(look("rm -rf /", root), opts("http://127.0.0.1:1", 500));
  assert.equal(x.summary, null);
  assert.ok(x.skipped);
});

test("an error status from Ollama is reported, not thrown", async () => {
  const fake = await startFake();
  fake.fail = 500;
  const root = makeRepo({ committed: { "a.ts": "a" } });
  const x = await explain(look("rm -rf /", root), opts(fake.host));
  assert.match(x.skipped!, /500/);
  await fake.close();
});

test("the model is never sent file contents or the environment", async () => {
  const fake = await startFake();
  fake.replies.push({ summary: "ok" });
  const root = makeRepo({ committed: { "secret.txt": "AWS_SECRET=hunter2" }, modified: { "secret.txt": "AWS_SECRET=changed" } });
  await explain(look("rm -rf secret.txt", root), opts(fake.host));
  const sent = JSON.stringify(fake.requests);
  assert.ok(!sent.includes("hunter2"), "file contents must never reach the model");
  assert.ok(!sent.includes("PATH"), "the environment must never reach the model");
  await fake.close();
});

test("a fact sheet contains only the headlines and facts the rules established", () => {
  const root = makeRepo({ committed: { "a.ts": "a" } });
  const sheet = factSheet(look("rm -rf /", root));
  assert.match(sheet, /command: rm -rf \//);
  assert.match(sheet, /whole filesystem/);
  assert.ok(sheet.split("\n").length < 40, "the sheet stays small enough for a 1B model");
});

test("a note about an unknown program is kept only when the argument it names is really in the command", async () => {
  const fake = await startFake();
  const root = makeRepo({ committed: { "a.ts": "a" } });
  // No summary job runs because there are no findings; the first reply answers the unknown-program question.
  fake.replies.push({ destructive: true, argument: "--wipe-everything", reason: "it wipes the index" });
  const good = await explain(look("frobnicate --wipe-everything", root), opts(fake.host));
  assert.equal(good.notes.length, 1);
  assert.match(good.notes[0].headline, /--wipe-everything/);
  assert.match(good.notes[0].facts.join(" "), /the model's opinion, not a checked fact/);

  fake.replies.push({ destructive: true, argument: "--destroy-all", reason: "made up" });
  const bad = await explain(look("frobnicate --wipe-everything", root), opts(fake.host));
  assert.deepEqual(bad.notes, [], "an argument the model invented must be dropped");
  await fake.close();
});

test("a model note can only ever be a note, never a stop", async () => {
  const fake = await startFake();
  fake.replies.push({ destructive: true, argument: "--yes", reason: "irreversible" });
  const root = makeRepo({ committed: { "a.ts": "a" } });
  const x = await explain(look("frobnicate --yes", root), opts(fake.host));
  assert.deepEqual(x.notes.map((n) => n.severity), ["note"]);
  await fake.close();
});

test("destructive=false produces no note at all", async () => {
  const fake = await startFake();
  fake.replies.push({ destructive: false, argument: "", reason: "" });
  const root = makeRepo({ committed: { "a.ts": "a" } });
  const x = await explain(look("frobnicate --list", root), opts(fake.host));
  assert.deepEqual(x.notes, []);
  await fake.close();
});

test("junk from the model is dropped instead of being shown", async () => {
  const fake = await startFake();
  const root = makeRepo({ committed: { "a.ts": "a" } });
  for (const junk of ["not json at all", JSON.stringify({ summary: 42 }), JSON.stringify({}), JSON.stringify({ summary: "" })]) {
    fake.replies.push(junk);
    const x = await explain(look("rm -rf /", root), opts(fake.host));
    assert.equal(x.summary, null, `junk accepted: ${junk}`);
  }
  await fake.close();
});

test("the model is asked for JSON with a schema and no creativity", async () => {
  const fake = await startFake();
  fake.replies.push({ summary: "ok" });
  const root = makeRepo({ committed: { "a.ts": "a" } });
  await explain(look("rm -rf /", root), opts(fake.host));
  const req = fake.requests[0] as unknown as { format?: unknown; options?: { temperature?: number } };
  assert.ok(req.format, "a JSON schema must be sent so the answer can be parsed");
  assert.equal(req.options?.temperature, 0);
  await fake.close();
});

test("nothing is asked of the model when there is nothing to say", async () => {
  const fake = await startFake();
  const root = makeRepo({ committed: { "a.ts": "a" } });
  const x = await explain(look("ls -la", root), opts(fake.host));
  assert.equal(fake.requests.length, 0);
  assert.match(x.skipped!, /nothing to explain/);
  await fake.close();
});

test("a rambling answer is cut down to one sentence", () => {
  assert.equal(oneSentence("This deletes everything. Then it also does more. And more."), "This deletes everything.");
  assert.equal(oneSentence("  Careful!!  "), "Careful.");
  assert.ok(oneSentence("x".repeat(400)).length <= 200);
});
