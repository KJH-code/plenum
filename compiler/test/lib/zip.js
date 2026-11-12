'use strict';
const zlib = require('zlib');

let TABLE = null;
function crc32(buf) {
  if (!TABLE) {
    TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 작은 zip 리더: central directory를 파싱하고 inflateRaw + CRC 검증. Map(이름 → Buffer)을 돌려준다.
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD를 못 찾았다');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  const order = [];
  const modes = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`central directory 서명 불일치 (엔트리 ${i})`);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const ext = buf.readUInt32LE(p + 38);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    if (buf.readUInt32LE(off) !== 0x04034b50) throw new Error(`local header 서명 불일치: ${name}`);
    const dstart = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const raw = buf.subarray(dstart, dstart + csize);
    let data;
    if (method === 8) data = zlib.inflateRawSync(raw);
    else if (method === 0) data = Buffer.from(raw);
    else throw new Error(`지원하지 않는 압축 방식 ${method}: ${name}`);
    if (data.length !== usize) throw new Error(`크기 불일치: ${name}`);
    if (crc32(data) !== crc) throw new Error(`CRC 불일치: ${name}`);
    files.set(name, data);
    modes.set(name, (ext >>> 16) & 0o7777);
    order.push(name);
    p += 46 + nlen + elen + clen;
  }
  return { files, order, modes };
}

module.exports = { readZip, crc32 };
