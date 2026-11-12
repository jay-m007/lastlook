// Turning a review into something readable in the half-second before someone presses enter.

import type { Finding, Severity } from "./findings.ts";
import type { Review } from "./review.ts";
import type { Explanation } from "./explain.ts";

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  red: "\x1b[31m", yellow: "\x1b[33m", blue: "\x1b[34m", grey: "\x1b[90m", green: "\x1b[32m",
};

export interface RenderOptions { color: boolean; width: number; verbose: boolean }

const LABEL: Record<Severity, string> = { stop: "stop", confirm: "check", note: "note" };
const COLOR: Record<Severity, string> = { stop: C.red, confirm: C.yellow, note: C.blue };

export function renderFinding(f: Finding, o: RenderOptions): string {
  const c = (code: string, s: string) => (o.color ? code + s + C.reset : s);
  const out: string[] = [];
  out.push(`  ${c(COLOR[f.severity] + C.bold, LABEL[f.severity].padEnd(5))} ${c(C.bold, f.headline)}`);
  for (const fact of f.facts) out.push(`        ${c(C.grey, "·")} ${wrap(fact, o.width - 10, 10)}`);
  if (f.recovery) out.push(`        ${c(C.grey, "back:")} ${wrap(f.recovery, o.width - 15, 15)}`);
  else if (f.recovery === null && f.severity !== "note") out.push(`        ${c(C.grey, "back:")} ${c(f.severity === "stop" ? C.red : C.yellow, "nothing to undo this")}`);
  if (f.alternative) out.push(`        ${c(C.grey, "try:")}  ${wrap(f.alternative, o.width - 15, 15)}`);
  if (o.verbose) out.push(`        ${c(C.grey, `[${f.rule}]`)}`);
  return out.join("\n");
}

export function render(r: Review, x: Explanation | null, o: RenderOptions): string {
  const c = (code: string, s: string) => (o.color ? code + s + C.reset : s);
  if (!r.findings.length) return r.unknownPrograms.length && o.verbose ? `  ${c(C.grey, `no rule covers ${r.unknownPrograms.join(", ")}`)}` : "";
  const out: string[] = [""];
  if (x?.summary) out.push(`  ${c(COLOR[r.severity ?? "note"] + C.bold, "lastlook")}  ${x.summary}`, "");
  for (const f of r.findings.slice(0, o.verbose ? 20 : 4)) out.push(renderFinding(f, o));
  const hidden = r.findings.length - (o.verbose ? 20 : 4);
  if (hidden > 0) out.push(`        ${c(C.grey, `and ${hidden} more (lastlook check -v to see them)`)}`);
  for (const n of x?.notes ?? []) out.push(renderFinding(n, o));
  if (o.verbose) {
    const timing = [`rules ${r.ms} ms`, ...(x && x.ms ? [`model ${x.ms} ms`] : []), ...(x?.skipped ? [`model skipped: ${x.skipped}`] : [])];
    out.push(`        ${c(C.grey, timing.join(", "))}`);
  }
  out.push("");
  return out.join("\n");
}

/** Wraps text to a width, indenting continuation lines. */
export function wrap(text: string, width: number, indent: number): string {
  if (width < 20 || text.length <= width) return text;
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line && line.length + w.length + 1 > width) { lines.push(line); line = w; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.join("\n" + " ".repeat(indent));
}

export const colors = C;
