// 새 클론 연기 테스트: 서버를 실제로 띄워 /api/settings 와 웹 첫 페이지가 오는지 본다. (npm start 와 같은 진입점)
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsx = path.join(app, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const child = spawn(process.execPath, [tsx, 'server/main.ts'], {
  cwd: app,
  env: { ...process.env, PLENUM_PORT: '0', PLENUM_CONFIG_DIR: path.join(app, '.smoke-config') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
const fail = (m) => { console.error(`smoke 실패: ${m}\n${out}`); child.kill(); process.exit(1); };
const timer = setTimeout(() => fail('서버가 30초 안에 안 떴다'), 30000);
child.stdout.on('data', async (d) => {
  out += d;
  const m = /Plenum: (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
  if (!m) return;
  clearTimeout(timer);
  try {
    const s = await fetch(`${m[1]}/api/settings`);
    if (s.status !== 200) fail(`/api/settings ${s.status}`);
    const k = await (await fetch(`${m[1]}/api/kit/workers`)).json();
    if (k.ok !== false || !/지정되지 않았다/.test(k.message)) fail(`kit 응답이 이상하다: ${JSON.stringify(k)}`);
    const h = await fetch(`${m[1]}/`);
    if (h.status !== 200 || !(await h.text()).includes('<div id="root">')) fail('웹 첫 페이지가 안 온다');
    console.log(`smoke 통과 (${m[1]})`);
    child.kill();
  } catch (e) { fail(e.message); }
});
child.stderr.on('data', (d) => { out += d; });
child.on('exit', (c) => { if (c && c !== 0 && !child.killed) fail(`서버 종료 ${c}`); });
