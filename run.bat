@echo off
cd /d %~dp0
start cmd /k "npm run dev"
start http://localhost:3000
