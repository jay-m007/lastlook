@echo off
REM One double-click to check all three projects against the real Ollama model on this machine.
REM
REM Put this file in any folder and run it. It fetches lastlook, whyline and firstfail next to
REM itself, runs each one's offline tests, then measures the real model, and puts everything in
REM one out\ folder. Nothing leaves this machine.
setlocal enabledelayedexpansion
cd /d "%~dp0"
if not exist out mkdir out
del /q out\DONE.txt 2>nul

echo ===== this machine > out\env.txt
node -v >> out\env.txt 2>&1
git --version >> out\env.txt 2>&1
ollama --version >> out\env.txt 2>&1
echo ===== installed models >> out\env.txt
ollama list >> out\env.txt 2>&1
type out\env.txt

where node >nul 2>nul || (echo Node is not on the PATH. Install Node 22.18 or newer and run this again. & pause & exit /b 1)
where git  >nul 2>nul || (echo Git is not on the PATH. & pause & exit /b 1)

for %%P in (lastlook whyline firstfail) do (
  echo.
  echo ===================== %%P
  if exist "%%P\.git" ( git -C "%%P" pull --quiet ) else ( git clone --quiet https://github.com/jay-m007/%%P.git "%%P" )
  pushd "%%P"
  call npm install --silent > "..\out\%%P-install.txt" 2>&1
  echo   offline tests
  call npm test > "..\out\%%P-test.txt" 2>&1
  findstr /C:"# pass" /C:"# fail" "..\out\%%P-test.txt"
  echo   the model
  call npm run eval > "..\out\%%P-eval.txt" 2>&1
  findstr /C:"latency" /C:"invented" /C:"refused" /C:"agreed" /C:"within" /C:"unknown programs" /C:"found the written" /C:"rules found" "..\out\%%P-eval.txt"
  popd
)

echo all three done > out\DONE.txt
echo.
echo ===== Finished. Everything is in the out folder.
echo ===== Send me out\*.txt and I will fix whatever the model got wrong.
pause
