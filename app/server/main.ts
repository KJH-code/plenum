import { createHandler, listen } from './app.ts';
import { configDir } from './config.ts';
import { removeServerFile, writeServerFile } from './serverfile.ts';
import { cleanupOrphans } from './proc.ts';

const cfgDir = configDir();
// 지난 실행이 강제로 꺼지며 남긴 채팅 claude 프로세스
try {
  const n = await cleanupOrphans(cfgDir);
  if (n) console.log(`Plenum: 지난 실행이 남긴 claude 프로세스 ${n}개를 정리했다`);
} catch (e: any) { console.error(`Plenum: 고아 프로세스 정리 실패: ${e && e.message ? e.message : e}`); }

const start = process.env.PLENUM_PORT ? Number(process.env.PLENUM_PORT) : 4317;
const handler = createHandler({ cfgDir });
const { chats } = handler;
const { server, port } = await listen(handler, start);
// 훅 스크립트가 지금 포트를 읽는 파일. 끝날 때 내가 쓴 것만 지운다
writeServerFile(cfgDir, port);
process.on('exit', () => removeServerFile(cfgDir));
// 테스트·스크립트가 이 줄에서 실제 포트를 읽는다
console.log(`Plenum: http://127.0.0.1:${port}  (설정 ${cfgDir})`);

// 끌 때 채팅 claude 를 고아로 남기지 않는다. Windows 콘솔 창 닫기는 node 에서 SIGHUP.
// Windows 는 창을 닫으면 몇 초 뒤 프로세스를 강제로 끝내므로 SIGHUP 은 3초 안에 정리한다.
// 두 번째 신호면 기다리지 않고 트리째 죽이고 끝낸다.
let stopping = false;
async function shutdown(sig: string) {
  if (stopping) { console.log(`Plenum: ${sig} 다시 받음 — 채팅 claude 를 바로 끝낸다`); chats.killAllNow(); process.exit(1); }
  stopping = true;
  console.log(`Plenum: ${sig} 받음 — 채팅 claude 를 정리하고 끈다`);
  try { await chats.shutdownAll(sig === 'SIGHUP' ? 3000 : undefined); } catch { /* 무시 */ }
  console.log('Plenum: 정리 끝, 서버를 끈다');
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => { void shutdown(sig); });
