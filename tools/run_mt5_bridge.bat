@echo off
REM POLIS MT5 Bridge — supervised launcher.
REM
REM The bridge is the only piece of POLIS that Docker does not keep alive, and
REM when it stops the kernel still approves trades that nothing sends to MT5 —
REM the system looks healthy while placing no orders at all. This wrapper
REM restarts it, and the scheduled task starts it at logon.
REM
REM Register (run once, from this folder):
REM   schtasks /Create /TN "POLIS MT5 Bridge" /TR "d:\polis\tools\run_mt5_bridge.bat" /SC ONLOGON /RL LIMITED /F

setlocal
set PYTHONIOENCODING=utf-8
set PYTHONUNBUFFERED=1
cd /d "%~dp0\.."

set LOGDIR=%~dp0..\logs
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

:loop
echo [%date% %time%] starting MT5 bridge >> "%LOGDIR%\mt5_bridge.log"
python -u tools\polis_mt5_bridge.py >> "%LOGDIR%\mt5_bridge.log" 2>&1
echo [%date% %time%] bridge exited with code %ERRORLEVEL% — restarting in 15s >> "%LOGDIR%\mt5_bridge.log"
REM Not "timeout": it refuses to run when stdin is redirected, which it is here
REM because the whole loop writes to the log. It failed instantly and the bridge
REM restarted several times a second against a crashing MT5 API instead of
REM backing off. ping is the delay that survives redirection.
ping -n 16 127.0.0.1 > nul
goto loop
