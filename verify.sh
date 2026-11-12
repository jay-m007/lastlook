#!/bin/sh
# Same as verify.cmd, for macOS and Linux.
set -e
cd "$(dirname "$0")"
mkdir -p out
node -v > out/env.txt 2>&1
ollama list >> out/env.txt 2>&1 || echo "ollama not found" >> out/env.txt
npm test > out/test.txt 2>&1 || true
grep -E "# (tests|pass|fail)" out/test.txt
for m in $(ollama list 2>/dev/null | tail -n +2 | head -2 | awk "{print \$1}"); do
  echo "  $m"
  node eval/run.ts --model "$m" > "out/eval-$(echo "$m" | tr ":/" "--").txt" 2>&1 || true
  grep -E "latency|invented|unknown programs" "out/eval-$(echo "$m" | tr ":/" "--").txt" || true
done
echo "Done. Everything is in out/."
