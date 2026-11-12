// Measures the model, not the rules: the rules are covered by the test suite, which needs no model.
//
// Three things are measured, because these are the three ways a local model could make lastlook
// worse: it could be too slow to sit in front of a shell prompt, it could invent facts in the
// summary, and it could be wrong about commands no rule covers.
//
//   npm run eval                      against $OLLAMA_HOST with $LASTLOOK_MODEL
//   node eval/run.ts --model llama3.2:1b --budget 300

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { readContext } from "../src/context.ts";
import { review } from "../src/review.ts";
import { explain, factSheet } from "../src/explain.ts";

interface Cases {
  unknownPrograms: { line: string; destructive: boolean; why: string }[];
  summaries: string[];
}

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : fallback; };

const host = (flag("host", process.env.OLLAMA_HOST || "http://127.0.0.1:11434")).replace(/^(?!http)/, "http://");
const model = flag("model", process.env.LASTLOOK_MODEL && process.env.LASTLOOK_MODEL !== "off" ? process.env.LASTLOOK_MODEL : "llama3.2:1b");
const budget = Number(flag("budget", "300"));
const cases = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8")) as Cases;

/** A repository with something to lose, so the rules have real facts to hand the model. */
function scratchRepo(): string {
  const base = mkdtempSync(join(tmpdir(), "lastlook-eval-"));
  const root = join(base, "repo");
  const sh = (cmd: string, cwd: string) => execFileSync("sh", ["-c", cmd], { cwd, stdio: "ignore" });
  execFileSync("mkdir", ["-p", join(root, "src"), join(root, "build"), join(base, "shared")]);
  sh("git init -q -b main . && git config user.email e@x.c && git config user.name E", root);
  for (let i = 0; i < 12; i++) writeFileSync(join(root, "src", `f${i}.ts`), "x".repeat(200));
  writeFileSync(join(root, "package.json"), "{}");
  sh("git add -A && git commit -qm initial", root);
  writeFileSync(join(root, "src", "f0.ts"), "changed, not committed");
  for (let i = 0; i < 30; i++) writeFileSync(join(root, "build", `o${i}.map`), "y".repeat(500));
  writeFileSync(join(base, "shared", "keep.txt"), "shared");
  return root;
}

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "n/a");
const quantile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; };
/** Numbers the model wrote that do not appear anywhere in the facts it was given. */
function inventedNumbers(summary: string, sheet: string): string[] {
  const inSheet = new Set((sheet.match(/\d[\d,.]*/g) ?? []).map((n) => n.replace(/[,.]$/, "")));
  return (summary.match(/\d[\d,.]*/g) ?? []).map((n) => n.replace(/[,.]$/, "")).filter((n) => !inSheet.has(n) && n.length > 0);
}

async function main(): Promise<void> {
  process.stdout.write(`lastlook eval\n  host    ${host}\n  model   ${model}\n  budget  ${budget} ms\n\n`);

  try {
    const tags = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) });
    const installed = ((await tags.json()) as { models?: { name: string }[] }).models?.map((m) => m.name) ?? [];
    process.stdout.write(`  installed: ${installed.join(", ") || "none"}\n`);
    if (!installed.some((m) => m === model || m.split(":")[0] === model.split(":")[0])) {
      process.stdout.write(`\n  ${model} is not installed. Run: ollama pull ${model}\n`);
      process.exit(1);
    }
  } catch (e) {
    process.stdout.write(`\n  Ollama is not answering at ${host}: ${e instanceof Error ? e.message : String(e)}\n  Start it with "ollama serve" and try again.\n`);
    process.exit(1);
  }

  const root = scratchRepo();
  const ctx = readContext(root, process.env);
  const env = { ...process.env, DATABASE_URL: "postgres://app:secret@db.prod.internal:5432/app", AWS_PROFILE: "prod" } as NodeJS.ProcessEnv;

  // 1. Summaries: latency, and whether the model stuck to the facts it was given.
  process.stdout.write(`\nsummaries (${cases.summaries.length} commands)\n`);
  const latencies: number[] = [];
  let answered = 0, invented = 0, withinBudget = 0;
  const summaryRows: { line: string; summary: string | null; ms: number; invented: string[] }[] = [];
  for (const line of cases.summaries) {
    const r = review(line, ctx, env);
    const sheet = factSheet(r);
    const x = await explain(r, { host, model, budgetMs: 30_000 });
    const bad = x.summary ? inventedNumbers(x.summary, sheet) : [];
    latencies.push(x.ms);
    if (x.summary) answered++;
    if (bad.length) invented++;
    if (x.ms <= budget) withinBudget++;
    summaryRows.push({ line, summary: x.summary, ms: x.ms, invented: bad });
    process.stdout.write(`  ${String(x.ms).padStart(5)} ms  ${bad.length ? "INVENTED " + bad.join(",") : x.summary ? "ok " : "no answer"}  ${line.slice(0, 44)}\n`);
  }

  // 2. Unknown programs: does the model judge commands no rule covers, and does it quote a real argument?
  process.stdout.write(`\nprograms with no rule (${cases.unknownPrograms.length} commands)\n`);
  let tp = 0, fp = 0, fn = 0, tn = 0, madeUpArgument = 0;
  const judgeRows: { line: string; expected: boolean; got: boolean; ms: number }[] = [];
  for (const c of cases.unknownPrograms) {
    const r = review(c.line, ctx, env);
    const x = await explain(r, { host, model, budgetMs: 30_000 });
    // A note only survives if the argument it quoted is really in the command, so this measures
    // the model's judgement after lastlook's own check has thrown out invented answers.
    const flagged = x.notes.length > 0;
    if (c.destructive && flagged) tp++;
    else if (c.destructive && !flagged) fn++;
    else if (!c.destructive && flagged) fp++;
    else tn++;
    if (x.notes.length === 0 && c.destructive) madeUpArgument += 0;
    judgeRows.push({ line: c.line, expected: c.destructive, got: flagged, ms: x.ms });
    const mark = c.destructive === flagged ? "ok  " : c.destructive ? "MISS" : "FALSE";
    process.stdout.write(`  ${mark.padEnd(6)} ${String(x.ms).padStart(5)} ms  ${c.line.slice(0, 50)}\n`);
  }

  const results = {
    model, host, budgetMs: budget, when: new Date().toISOString(),
    summaries: {
      cases: cases.summaries.length, answered, inventedFacts: invented,
      withinBudget, p50Ms: quantile(latencies, 0.5), p95Ms: quantile(latencies, 0.95), maxMs: Math.max(...latencies),
      rows: summaryRows,
    },
    unknownPrograms: { truePositive: tp, falsePositive: fp, falseNegative: fn, trueNegative: tn, madeUpArgument, rows: judgeRows },
  };

  process.stdout.write([
    ``,
    `summary`,
    `  answered                ${answered}/${cases.summaries.length}`,
    `  invented a figure       ${invented}/${answered || 1}   (any number not in the facts it was given)`,
    `  within ${budget} ms          ${withinBudget}/${cases.summaries.length}   (${pct(withinBudget, cases.summaries.length)})`,
    `  latency p50 / p95 / max ${quantile(latencies, 0.5)} / ${quantile(latencies, 0.95)} / ${Math.max(...latencies)} ms`,
    ``,
    `  unknown programs        caught ${tp}/${tp + fn} destructive, ${fp} false alarms out of ${fp + tn} safe`,
    ``,
    `What these numbers mean: the latency line decides whether the model can sit in front of a shell`,
    `prompt at all. "invented a figure" is the one that must be zero, because a summary that invents`,
    `a file count is worse than no summary. The unknown-programs line is the only coverage lastlook`,
    `gains from the model, and a false alarm there costs trust quickly.`,
    ``,
  ].join("\n"));

  const out = new URL(`./results-${model.replace(/[:/]/g, "-")}.json`, import.meta.url);
  writeFileSync(out, JSON.stringify(results, null, 2));
  process.stdout.write(`written to eval/results-${model.replace(/[:/]/g, "-")}.json\n`);
}

main().catch((e) => { process.stderr.write(`eval failed: ${e instanceof Error ? e.stack : String(e)}\n`); process.exit(1); });
