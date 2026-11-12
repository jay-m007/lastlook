// "Show me the files" — the answer to the only question anyone actually has at the prompt.

import { parse, unwrap } from "./shell.ts";
import { splitArgs } from "./rules.ts";
import { expand, survey, shorten, isInside } from "./paths.ts";
import type { Context } from "./context.ts";
import { plural, bytes } from "./findings.ts";

/** Lists what the delete-ish arguments of a command line resolve to, newest first. */
export function listTargets(line: string, ctx: Context, env: NodeJS.ProcessEnv): string {
  const parsed = parse(line);
  const out: string[] = [""];
  for (const cmd of parsed.commands) {
    const u = unwrap(cmd);
    const { operands } = splitArgs(u.cmd.argv);
    for (const w of operands) {
      const e = expand(w, ctx.cwd, env);
      if (e.unknown) { out.push(`  ${w.raw}: not known until it runs`); continue; }
      if (!e.paths.length) { out.push(`  ${w.raw}: matches nothing`); continue; }
      const s = survey(e.paths, ctx.git?.root ?? null);
      if (s.files + s.dirs === 0) continue;
      out.push(`  ${w.raw} → ${plural(s.files, "file")} in ${plural(s.dirs, "folder")}, ${bytes(s.bytes)}`);
      for (const p of s.examples.slice(0, 8)) out.push(`      ${shorten(p, ctx.cwd, env)}${ctx.git && !isInside(p, ctx.git.root) ? "   (outside the repo)" : ""}`);
      if (s.files > s.examples.length) out.push(`      … and ${plural(s.files - s.examples.length, "more file")}`);
    }
  }
  out.push("");
  return out.join("\n");
}
