#!/bin/sh
# 커밋 작성자·커미터 이메일이 noreply 목록 밖이면 실패한다 (공개 레포에 개인 이메일이 남지 않게).
# 사용: .githooks/check-commit-emails.sh [<git log 범위 인자>...]   기본: 어느 원격에도 없는 커밋(HEAD --not --remotes)
# pre-push 훅과 CI 가 같이 쓴다. 허용: GitHub noreply, Claude 커미터, GitHub 웹 병합
ALLOW='^(248580898\+KJH-code@users\.noreply\.github\.com|noreply@anthropic\.com|noreply@github\.com)$'
if [ $# -eq 0 ]; then set -- HEAD --not --remotes; fi
bad=0
for line in $(git log --format='%h|%ae|%ce' "$@"); do
  h=${line%%|*}; rest=${line#*|}; ae=${rest%%|*}; ce=${rest#*|}
  for e in "$ae" "$ce"; do
    if ! printf '%s\n' "$e" | grep -Eq "$ALLOW"; then
      echo "작성자 이메일 검사 실패: $h $(git log -1 --format='author=<%ae> committer=<%ce> %s' "$h")" >&2
      bad=1; break
    fi
  done
done
if [ $bad -ne 0 ]; then
  echo "→ noreply 가 아닌 이메일이 있다. GIT_AUTHOR_EMAIL·GIT_COMMITTER_EMAIL 환경 변수와 git config user.email 을 확인하고 커밋을 고친다(git commit --amend --author=...)" >&2
  exit 1
fi
