import type { Project } from './api';

const ICONS = ['var(--icon-1)', 'var(--icon-2)', 'var(--icon-3)', 'var(--icon-4)', 'var(--icon-5)'];
export function iconColor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return ICONS[h % ICONS.length];
}
export const initial = (name: string) => Array.from(name.trim())[0]?.toUpperCase() || '?';

export function subtitle(p: Project): string {
  const d = p.detection;
  if (!d.exists) return '폴더 없음';
  if (d.github) return `GitHub · ${d.branch || '[브랜치 없음]'}`;
  if (d.git === 'none') return '로컬 폴더 · git 아님';
  return `로컬 git · ${d.branch || '[브랜치 없음]'}`;
}

export function GitBadges({ p }: { p: Project }) {
  const d = p.detection;
  return (
    <>
      {!d.exists && <span className="badge bad">폴더 없음</span>}
      {d.exists && d.git === 'none' && <span className="badge warn">git 아님</span>}
      {d.exists && d.git === 'empty' && <span className="badge">커밋 없음</span>}
      {d.exists && d.git === 'none' && d.parentRepo && <span className="badge warn">상위 폴더가 레포</span>}
    </>
  );
}

export function NotGitNotice() {
  return (
    <div className="notice" role="note">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--fg-warn)" strokeWidth="2" aria-hidden="true" style={{ flex: '0 0 auto', marginTop: 2 }}><path d="M12 3l9 16H3z" /><path d="M12 10v4M12 17h.01" /></svg>
      <div>
        <b>git이 아니라서 절약~극한 모드는 끝까지 못 간다</b>
        <div>편집은 되지만 커밋과 검수(check)가 막힌다. 폴더에서 <code>git init</code> 을 하면 풀린다.</div>
      </div>
    </div>
  );
}

export function ParentRepoNotice({ parent }: { parent: string }) {
  return (
    <div className="notice" role="note" data-testid="parent-repo-notice">
      <div>
        <b>이 폴더엔 .git이 없는데 상위 폴더가 git 레포다</b>
        <div>상위 레포: <span className="mono">{parent}</span>. 여기서 Claude Code를 쓰면 커밋·diff가 그 레포에 걸린다. 의도한 게 아니면 그 폴더의 <code>.git</code>을 확인한다.</div>
      </div>
    </div>
  );
}
