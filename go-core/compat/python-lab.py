"""Run the existing Python classifier on an ephemeral loopback port, without
executing its production launcher or writing the production serve.log."""
import json
import runpy
import sys
from http.server import ThreadingHTTPServer
from pathlib import Path

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / 'scripts'))
module = runpy.run_path(str(root / 'scripts' / 'serve_classifier.py'))
server = ThreadingHTTPServer(('127.0.0.1', 0), module['Handler'])
print(json.dumps({'port': server.server_address[1], 'laboratory': True}), flush=True)
server.serve_forever()
