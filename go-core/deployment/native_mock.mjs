// CI-only provider/classifier stand-in. All credentials and TLS files are synthetic.
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
const config = JSON.parse(readFileSync('/app/config/router.json', 'utf8'));
httpServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"status":"ok"}'); }).listen(8788, '0.0.0.0');
httpsServer({ key: readFileSync('/app/config/tls-key.pem'), cert: readFileSync('/app/config/tls-cert.pem') }, async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.headers.authorization !== 'Bearer fixture-service-key') { res.writeHead(401); return res.end('{}'); }
  if (req.method === 'GET' && req.url === '/v1/models') return res.end(JSON.stringify({ data: config.models.map(m => ({ id: m.id })) }));
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end('{}'); }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw), usage = { prompt_tokens: 200, completion_tokens: 20 };
  if (body.stream) {
    res.setHeader('content-type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'fixture-ok' } }] })}\n\n`);
    return setTimeout(() => res.end(`data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`), 30);
  }
  res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: 'assistant', content: 'fixture-ok' } }], usage }));
}).listen(8790, '0.0.0.0');
