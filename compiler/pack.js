#!/usr/bin/env node
// build/claude-code/ 를 의존성 없이 zip 하나로 묶는다. 같은 build면 같은 바이트(날짜 고정, 이름 정렬).
// 쓰는 법: plenum-pack [--build <dir>] [--out <file>]  (기본 build=<cwd>/build/claude-code, out=<cwd>/dist/<name>-<version>.zip)
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const REPO = process.cwd();

// CRC32 (Node 18에는 zlib.crc32가 없다)
const TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  TABLE[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function listFiles(dir) {
  const out = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  })(dir, '');
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// Windows 체크아웃(core.autocrlf, 실행 비트 없음)에서 묶어도 같은 zip이 나오게:
// - 텍스트 파일(앞 8000바이트에 NUL이 없는 파일, git과 같은 판정)은 CRLF → LF
// - 훅·스크립트 .js 는 파일 시스템 권한과 상관없이 755
const FORCE_EXEC = /^(hooks|scripts)\/[^/]+\.js$/;
function isText(buf) { return !buf.subarray(0, 8000).includes(0); }
function toLf(buf) {
  if (!isText(buf) || !buf.includes(0x0d)) return buf;
  const out = Buffer.alloc(buf.length);
  let j = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) continue;
    out[j++] = buf[i];
  }
  return out.subarray(0, j);
}

const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01

function buildZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data, executable } of files) {
    const mode = executable ? 0o100755 : 0o100644; // 실행 비트만 보존해 결정성 유지
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 이름
    lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    parts.push(lh, nameBuf, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE((3 << 8) | 20, 4); // unix, 2.0
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(((mode << 16) >>> 0), 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

function fail(msg) { process.stderr.write(`ERROR ${msg}\n`); process.exit(1); }

function main() {
  const argv = process.argv.slice(2);
  let build = path.join(REPO, 'build', 'claude-code');
  let out = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--build' && argv[i + 1]) build = path.resolve(argv[++i]);
    else if (argv[i] === '--out' && argv[i + 1]) out = path.resolve(argv[++i]);
    else fail(`알 수 없는 인자: ${argv[i]}\n쓰는 법: plenum-pack [--build <dir>] [--out <file>]`);
  }
  if (!fs.existsSync(build) || !fs.statSync(build).isDirectory()) fail(`build 폴더가 없다: ${build} (npm run build 먼저)`);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(build, '.claude-plugin', 'plugin.json'), 'utf8')); }
  catch (e) { fail(`.claude-plugin/plugin.json을 못 읽었다: ${e.message}`); }
  const { name, version } = manifest;
  if (typeof version !== 'string' || !version) fail('plugin.json에 version이 없다');
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(name)) fail(`plugin.json name이 이상하다: ${name}`);
  if (!out) out = path.join(REPO, 'dist', `${name}-${version}.zip`);

  const names = listFiles(build);
  if (names.length === 0) fail(`build 폴더에 파일이 없다: ${build}`);
  const buf = buildZip(names.map((name) => ({
    name,
    data: toLf(fs.readFileSync(path.join(build, name))),
    executable: FORCE_EXEC.test(name) || (fs.statSync(path.join(build, name)).mode & 0o111) !== 0,
  })));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buf);
  const rel = path.relative(REPO, out);
  console.log(`${rel.startsWith('..') ? out : rel.split(path.sep).join('/')} (${names.length} files)`);
}

main();
