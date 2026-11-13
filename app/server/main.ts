import { createHandler, listen, workerModel } from './app.ts';
import { createChatManager } from './chat.ts';
import { configDir } from './config.ts';
import { cleanupOrphans } from './proc.ts';

const cfgDir = configDir();
// 지난 실행이 강제로 꺼지며 남긴 채팅 claude 프로세스
try {
  const n = await cleanupOrphans(cfgDir);
  if (n) console.log(`Plenum: 지난 실행이 남긴 claude 프로세스 ${n}개를 정리했다`);
} catch (e: any) { console.error(`Plenum: 고아 프로세스 정리 실패: ${e && e.message ? e.message : e}`); }

const chats = createChatManager({ cfgDir, env: process.env, deps: { workerModel: (t) => workerModel(cfgDir, t) } });
const start = process.env.PLENUM_PORT ? Number(process.env.PLENUM_PORT) : 4317;
const { server, port } = await listen(createHandler({ cfgDir, chats }), start);
// 테스트·스크립트가 이 줄에서 실제 포트를 읽는다
console.log(`Plenum: http://127.0.0.1:${port}  (설정 ${cfgDir})`);

// 끌 때 채팅 claude 를 고아로 남기지 않는다. Windows 콘솔 창 닫기는 node 에서 SIGHUP.
// Windows 는 창을 닫으면 몇 초 뒤 프로세스를 강제로 끝내므로 SIGHUP 은 3초 안에 정리한다.
// 두 번째 신호면 기다리지 않고 트리째 죽이고 끝낸다.
let stopping = false;
async function shutdown(sig: string) {
  if (stopping) { chats.killAllNow(); process.exit(1); }
  stopping = true;
  try { await chats.shutdownAll(sig === 'SIGHUP' ? 3000 : undefined); } catch { /* 무시 */ }
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => { void shutdown(sig); });
