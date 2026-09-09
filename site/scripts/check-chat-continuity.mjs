import assert from 'node:assert/strict';
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';

// Run against a freshly compiled engine; all projects and journals are temporary.
const binary = process.argv[2];
if (!binary) throw new Error('Usage: node scripts/check-chat-continuity.mjs /path/to/engine');
const root = await mkdtemp(path.join(os.tmpdir(), 'donkey-chat-http-'));
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const engine = spawn(path.resolve(binary), [], { env: { ...process.env, DONKEY_CUT_DATA_DIR: root, DONKEY_CUT_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
const logs = [];
engine.stdout.on('data', data => logs.push(data.toString()));
engine.stderr.on('data', data => logs.push(data.toString()));
const base = `http://127.0.0.1:${port}/api/cut`;
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${base}/projects`).then(r => r.ok).catch(() => false)) { ready = true; break; }
    await pause();
  }
  assert(ready, 'engine started');
  const made = await fetch(`${base}/projects`, { method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({name: 'Closed tab fixture'}) });
  assert(made.ok);
  const project = await made.json();
  const head = await fetch(`${base}/projects/${project.id}`, { method: 'HEAD', headers: { origin: 'https://donkeycut.com' } });
  assert(head.headers.get('x-cut-doc-version'));
  assert(head.headers.get('access-control-expose-headers')?.includes('x-cut-doc-version'));
  assert.equal(await head.text(), '');
  const opened = await fetch(`${base}/projects/${project.id}`);
  assert.equal(opened.headers.get('x-cut-doc-version'), head.headers.get('x-cut-doc-version'));
  const saved = await fetch(`${base}/projects/${project.id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Closed tab fixture renamed' }),
  }).then(response => response.json());
  const changedHead = await fetch(`${base}/projects/${project.id}`, { method: 'HEAD' });
  assert.equal(changedHead.headers.get('x-cut-doc-version'), saved.revision);
  assert.notEqual(saved.revision, head.headers.get('x-cut-doc-version'));

  const blocked = await fetch(`${base}/projects`, {headers:{origin:'https://example.com'}});
  assert.equal(blocked.status, 403);
  const preflight = await fetch(`${base}/projects`, {method:'OPTIONS',headers:{origin:'https://donkeycut.com','access-control-request-headers':'content-type'}});
  assert.equal(preflight.status, 204);
  const media = new FormData();
  media.set('file',new File(['0123456789'], 'continuity.txt', {type:'text/plain'}));
  const upload = await fetch(`${base}/projects/${project.id}/media`, {method:'POST',body:media});
  assert(upload.ok, 'multipart media upload');
  const {fileName} = await upload.json();
  const range = await fetch(`${base}/projects/${project.id}/media/${encodeURIComponent(fileName)}`, {headers:{range:'bytes=2-5'}});
  assert.equal(range.status,206);
  assert.equal(await range.text(),'2345');
  const threadId = 'http-check';
  await new Promise((resolve,reject) => {
    const req = request(`${base}/ai/chat`, { method:'POST', agent:false, headers:{'content-type':'application/json'} }, response => {
      assert.equal(response.statusCode,200);
      response.once('data', () => { response.destroy(); req.destroy(); resolve(); });
    });
    req.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
    req.end(JSON.stringify({threadId, model:'cut-test', runtime:{syncIntervalMs:5000,sceneLeaseMs:30000,journalBytes:8388608},context:{project:{id:project.id}},messages:[{id:'ask',role:'user',parts:[{type:'text',text:'Add the test title.'}]}]}));
  });
  let doc;
  for (let i = 0; i < 100; i++) {
    doc = await fetch(`${base}/projects/${project.id}`).then(r => r.json());
    if (doc.overlays?.some(o => o.text === 'TESTMARK title')) break;
    await pause();
  }
  assert.equal(doc.overlays.filter(o => o.text === 'TESTMARK title').length, 1);
  const journal = await fetch(`${base}/ai/chat/${threadId}/stream?projectId=${project.id}`).then(r => r.text());
  assert(journal.includes('Done: TESTMARK title added.'));
  assert(journal.includes('data: [DONE]'));
  assert(!journal.includes('"type":"tool-output-error"'));
  console.log('PASS: detached chat completion, single tool application, journal replay, cross-origin revision headers, CORS, multipart upload, and media range reads.');
} catch (error) { console.error(logs.join('')); for(const file of await readdir(root+'/chat-streams').catch(()=>[])) console.error(await readFile(root+'/chat-streams/'+file,'utf8')); throw error; }
finally {
  engine.kill('SIGTERM');
  await once(engine, 'close');
  await rm(root, {recursive:true,force:true});
}
