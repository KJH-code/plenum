'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// 폴더 아래 모든 파일의 상대경로(`/` 구분, 정렬). 디렉터리는 넣지 않는다.
function listFiles(dir) {
  const out = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  })(dir, '');
  return out.sort();
}

// refDir(기준)과 outDir(결과)을 바이트 단위로 비교한다.
// allowExtra: outDir에만 있어도 되는 파일. compared(양쪽에 있어 비교한 파일 수)가 0이면 throw.
function compareTrees(refDir, outDir, { allowExtra = ['GENERATED.md'] } = {}) {
  const ref = listFiles(refDir);
  const out = listFiles(outDir);
  const refSet = new Set(ref);
  const outSet = new Set(out);
  const missing = ref.filter((f) => !outSet.has(f));
  const extra = out.filter((f) => !refSet.has(f) && !allowExtra.includes(f));
  const different = [];
  let compared = 0;
  for (const f of ref) {
    if (!outSet.has(f)) continue;
    compared++;
    if (!fs.readFileSync(path.join(refDir, f)).equals(fs.readFileSync(path.join(outDir, f)))) different.push(f);
  }
  if (compared === 0) throw new Error(`비교한 파일이 0개다 (ref=${refDir}, out=${outDir}) — 빈 폴더끼리 비교하면 항상 통과하므로 실패로 본다`);
  return { missing, extra, different, compared };
}

function makeTmp(prefix = 'jhkit-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function rmTmp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 정리 실패는 무시 */ }
}

module.exports = { listFiles, compareTrees, makeTmp, rmTmp };
