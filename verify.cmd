@echo off
REM Runs lastlook's offline tests and then measures the real Ollama model on this machine.
REM Double-click this file, or run it from a terminal. Results land in out\.
setlocal enabledelayedexpansion
cd /d "%~dp0"
if not exist out mkdir out
del /q out\DONE.txt 2>nul

echo === versions > out\env.txt
node -v >> out\env.txt 2>&1
ollama --version >> out\env.txt 2>&1
echo === installed models >> out\env.txt
ollama list >> out\env.txt 2>&1
type out\env.txt

echo.
echo Running the offline test suite...
call npm test > out\test.txt 2>&1
findstr /C:"# fail" out\test.txt

echo.
echo Measuring the model. This takes a few minutes per model.
set COUNT=0
for /f "skip=1 tokens=1" %%m in ('ollama list 2^>nul') do (
  if !COUNT! lss 2 (
    set /a COUNT+=1
    echo   %%m
    call node eval\run.ts --model %%m > "out\eval-%%~nm.txt" 2>&1
    findstr /C:"latency" /C:"invented" /C:"unknown programs" "out\eval-%%~nm.txt"
  )
)

echo ran !COUNT! model(s) > out\DONE.txt
echo.
echo Done. Everything is in the out folder.
pause
