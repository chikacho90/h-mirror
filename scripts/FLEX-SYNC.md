# flex.team → h-mirror 구성원 무인 자동 동기화

flex.team 현직 명단을 h-mirror 인식 DB(Supabase `employees`)와 맞춘다.
신규 입사자/새 프로필 사진 → 얼굴 임베딩 생성 후 등록, 퇴사자 → 삭제. 반복 실행 안전(증분).

핵심 스크립트: `scripts/flex-sync-auto.mjs`
Playwright가 **전용 프로필 Chrome을 (화면 밖) 창 모드로** 띄워 로그인 → 구성원 페이지 → 동기화까지 알아서 한다.
크롬을 켜둘 필요도, flex 페이지를 열어둘 필요도, 로그인 상태일 필요도 없다.

## 준비 (최초 1회)
`.env.local` 에 구글 계정 비번 입력 (이 파일은 git 추적 안 됨):
```
FLEX_EMAIL=kyungmin.woo@hnine.com
FLEX_PASSWORD=<구글 계정 비밀번호>
```

## 자동 스케줄 (매일 09:30) — 이미 설치됨
```
bash scripts/install-launchd.sh        # 설치/갱신
launchctl kickstart -k gui/$(id -u)/uk.wooo.h-mirror.flex-sync   # 지금 한 번 실행
tail -f scripts/flex-sync.log          # 로그
bash scripts/install-launchd.sh uninstall   # 제거
```
Mac이 로그인된 상태로 켜져 있는 동안 백그라운드로 돈다. 예약 시각에 꺼져 있었으면 다음 예약 때.

## 수동 실행
- `bun run sync` — 실제 동기화(기본 창 모드, 창은 화면 밖)
- `DRY=1 bun run sync` — 변경 없이 신규/삭제 대상만 출력
- `HEADLESS=1 bun run sync` — 창 없이 실행 (세션이 살아있을 때만 권장)

## 왜 창 모드(headless 아님)인가 — 중요
구글은 **헤드리스 브라우저의 로그인을 "본인 인증"(휴대폰 푸시 탭)으로 막는다.** 그래서 세션이 만료된 뒤
헤드리스로는 무인 재로그인이 불가능하다. 반면 **실제 Chrome 창 모드는 비번만으로 통과**(휴대폰 탭 불필요)한다.
→ 무인 재로그인을 보장하기 위해 창 모드를 기본으로 쓰고, 창은 화면 밖(`--window-position`)으로 보낸다.
세션 만료(비번 변경/수동 로그아웃/구글 위험감지) 시에도 저장된 비번으로 자동 재로그인된다. (검증 완료: 쿠키 전체 삭제 후에도 무인 재로그인 성공)

## 동작 / 한계
- 전용 프로필 `scripts/.flex-profile`(쿠키 세션, .gitignore)에 로그인 유지. 대부분 실행은 로그인 단계를 조용히 통과.
- 실패 시 macOS 알림이 뜬다. 만약 구글이 드물게 휴대폰 본인인증을 강제하면(예: 평소와 다른 환경 감지) 그 회차는 실패할 수 있고, 로그의 안내대로 한 번 더 돌리면 된다.
- 프로필 사진이 없는 사람은 "사진없음(대기)" — 사진 올라오면 다음 실행 때 자동 등록.
- **이름 기준** 대조. 신규자가 기존 등록자와 완전 동명이인이면 건너뜀.
- 비번 변경 시 `.env.local`의 `FLEX_PASSWORD`도 갱신.
- `scripts/.flex-profile/`, `scripts/flex-sync.log`는 커밋 금지(.gitignore 처리됨).
