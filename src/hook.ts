// The shell integration lives in hooks/ as real shell files so they can be read, linted and tested
// as shell rather than as strings inside TypeScript.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function hookScript(shell: "bash" | "zsh"): string {
  return readFileSync(join(here, "..", "hooks", `lastlook.${shell}`), "utf8");
}
