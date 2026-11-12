import { createHandler, listen } from './app.ts';
import { configDir } from './config.ts';

const start = process.env.PLENUM_PORT ? Number(process.env.PLENUM_PORT) : 4317;
const { port } = await listen(createHandler(), start);
// 테스트·스크립트가 이 줄에서 실제 포트를 읽는다
console.log(`Plenum: http://127.0.0.1:${port}  (설정 ${configDir()})`);
