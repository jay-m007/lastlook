// The only place a language model is involved. It has two jobs and no authority:
//
//   1. put the rules' facts into one plain sentence, for the one-line summary;
//   2. say whether a command no rule covers looks destructive, and which argument worries it.
//
// Everything it returns is checked against the command before it is shown, and it can only ever
// add a note. It cannot raise a severity, clear a finding, or decide anything. If it is slow,
// absent or wrong, the rules' own wording is used instead, which is why there is no fallback model.

import type { Finding } from "./findings.ts";
import type { Review } from "./review.ts";

export interface ExplainOptions {
  host: string;
  model: string;
  /** Hard ceiling. A shell hook that waits longer than this is worse than no hook. */
  budgetMs: number;
}

export interface Explanation {
  /** One sentence, or null when the model did not answer in time. */
  summary: string | null;
  /** Notes about programs no rule covered. Already checked against the command line. */
  notes: Finding[];
  /** How long the model took, in milliseconds. */
  ms: number;
  /** Why there is no answer, when there is none. */
  skipped: string | null;
}

const SUMMARY_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
} as const;

const UNKNOWN_SCHEMA = {
  type: "object",
  properties: {
    destructive: { type: "boolean" },
    /** Must be copied from the command line, so it can be checked. */
    argument: { type: "string" },
    reason: { type: "string" },
  },
  required: ["destructive", "argument", "reason"],
} as const;

async function ask(o: ExplainOptions, system: string, user: string, schema: object, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(`${o.host}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: o.model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      stream: false,
      format: schema,
      options: { temperature: 0, num_predict: 120 },
    }),
    signal,
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const body = (await res.json()) as { message?: { content?: string } };
  return JSON.parse(body.message?.content ?? "{}");
}

const SUMMARY_SYSTEM = [
  "You turn a list of established facts about a shell command into one sentence for a developer about to press enter.",
  "Rules: use only the facts given. Never add a number, a path or a consequence that is not in them.",
  "No greeting, no advice, no exclamation marks. One sentence, at most 25 words, present tense.",
].join("\n");

const UNKNOWN_SYSTEM = [
  "You judge whether a shell command could destroy data, cost money or take a service down.",
  "Answer destructive=false unless you are confident. A command that only reads, lists, builds or prints is not destructive.",
  "If destructive=true, copy the single argument that worries you into the argument field, exactly as it appears in the command, character for character.",
  "The reason must be one short clause. Do not guess what the arguments contain.",
].join("\n");

/** Builds the fact sheet the model is allowed to see. Deliberately small: no file contents, no environment. */
export function factSheet(r: Review): string {
  const lines = [`command: ${r.line}`];
  for (const f of r.findings.slice(0, 6)) {
    lines.push(`- ${f.headline}`);
    for (const fact of f.facts.slice(0, 4)) lines.push(`  - ${fact}`);
  }
  return lines.join("\n");
}

export async function explain(r: Review, o: ExplainOptions): Promise<Explanation> {
  const started = performance.now();
  const out: Explanation = { summary: null, notes: [], ms: 0, skipped: null };
  if (!r.findings.length && !r.unknownPrograms.length) { out.skipped = "nothing to explain"; return out; }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), o.budgetMs);
  try {
    const jobs: Promise<void>[] = [];
    if (r.findings.length) {
      jobs.push(ask(o, SUMMARY_SYSTEM, factSheet(r), SUMMARY_SCHEMA, controller.signal).then((v) => {
        const s = (v as { summary?: unknown }).summary;
        if (typeof s === "string" && s.trim()) out.summary = oneSentence(s);
      }));
    }
    for (const prog of r.unknownPrograms.slice(0, 2)) {
      jobs.push(ask(o, UNKNOWN_SYSTEM, `command: ${r.line}\nthe program is: ${prog}`, UNKNOWN_SCHEMA, controller.signal).then((v) => {
        const got = v as { destructive?: unknown; argument?: unknown; reason?: unknown };
        if (got.destructive !== true) return;
        const argument = typeof got.argument === "string" ? got.argument.trim() : "";
        const reason = typeof got.reason === "string" ? got.reason.trim() : "";
        // The argument has to be in the command, or the model made it up.
        if (!argument || !r.line.includes(argument)) return;
        if (!reason) return;
        out.notes.push({
          rule: "model.unknown-program", severity: "note", program: prog,
          headline: `No rule covers ${prog}, and the model thinks ${argument} makes this destructive.`,
          facts: [oneSentence(reason), `this is the model's opinion, not a checked fact: lastlook knows nothing about ${prog}`],
          recovery: null,
        });
      }));
    }
    await Promise.all(jobs);
  } catch (e) {
    out.skipped = controller.signal.aborted ? `no answer within ${o.budgetMs} ms` : e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
  }
  out.ms = Math.round(performance.now() - started);
  return out;
}

/** One sentence, trimmed, with the model's enthusiasm removed. */
export function oneSentence(s: string): string {
  let t = s.replace(/\s+/g, " ").trim().replace(/^["']|["']$/g, "");
  const stop = t.search(/[.!?](\s|$)/);
  if (stop > 20) t = t.slice(0, stop + 1);
  t = t.replace(/!+/g, ".").replace(/\.\.+$/, ".");
  if (t.length > 200) t = t.slice(0, 197).replace(/\s\S*$/, "") + "...";
  return t;
}
