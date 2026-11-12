// The shape of everything a rule can say. Rules state facts; they never speculate.

export type Severity = "stop" | "confirm" | "note";

export interface Finding {
  /** Stable identifier, e.g. "rm.outside-repo". Used to silence a rule and in tests. */
  rule: string;
  severity: Severity;
  /** One line saying what the command does. Written by the rule, never by a model. */
  headline: string;
  /** Concrete, checkable facts. Shown one per line. */
  facts: string[];
  /** How to get back, or null when there is no way back. */
  recovery: string | null;
  /** A safer command that does the same job, when one exists. */
  alternative?: string;
  /** The program this is about, for grouping. */
  program: string;
}

export const RANK: Record<Severity, number> = { stop: 3, confirm: 2, note: 1 };

export const worst = (fs: Finding[]): Severity | null =>
  fs.length ? fs.reduce<Severity>((a, f) => (RANK[f.severity] > RANK[a] ? f.severity : a), "note") : null;

export function plural(n: number, one: string, many = one + "s"): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
