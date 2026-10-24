#!/bin/zsh
# Adds autodemo to the Claude chat app. Run from Terminal.app (it quits and reopens Claude).
osascript -e 'quit app "Claude"'; sleep 4
F=~/Library/Application\ Support/Claude/claude_desktop_config.json
cp "$F" "$F.bak"
python3 - "$F" "$(which node)" <<'PY'
import json,sys
f,node=sys.argv[1:]
d=json.load(open(f))
d.setdefault('mcpServers',{})['autodemo']={'command':node,'args':['/Users/mdayan/autodemo/bin/autodemo.js','mcp']}
json.dump(d,open(f,'w'),indent=2)
print('autodemo added')
PY
open -a Claude
