# SOS 서버 구현 계획 (MVP v1.0)

기준 문서: Notion「0. SOS MVP 확정서 — 문제·가설·검증·제품·기술」(2026-11-10, MVP v1.0).
「SOS MVP 제품 계약 — Step 1」과「MVP 설문 분석」은 확정서에 통합된 원본이므로, 둘이 충돌하면 확정서를 따른다.
(예: 저장소 50~100개 → 20개, 평균 첫 리뷰 시간 제외, 자동 스택 추론은 선택)

## 1. 범위

이번 단계는 **서버만** 만든다. 클라이언트(화면)는 이후 `apps/web`에 추가한다.

| 포함 | 제외 (확정서 5·7절) |
| --- | --- |
| F1~F9의 서버 API, DB 스키마·RLS, 수집·리포트·PR 동기화 잡, 추천 규칙, AI 출력 검증 | 화면, 자동 게시·PR 생성, private 저장소, 코드 자동 수정, 평균 첫 리뷰 시간, 리더보드, 알림, 결제 |

## 2. 저장소 구조 (pnpm 모노레포)

```
sos/
├─ apps/
│  ├─ server/          Next.js 16 App Router — API 전용 (route handlers + Inngest)
│  └─ web/             (예정) 클라이언트
├─ packages/
│  └─ shared/          API 계약(Zod 스키마·타입·상수) — 서버·클라이언트 공용
├─ supabase/
│  ├─ config.toml
│  └─ migrations/      SQL migration (스키마, RLS, RPC, 검색 함수)
└─ docs/
```

- 서버를 Next.js로 둔 이유: 확정서의 배포 단위(Vercel + Inngest + Supabase)를 유지하고, 이후 웹 앱을 같은 프레임워크로 붙이기 쉽다.
- 클라이언트와 서버는 `@sos/shared`의 Zod 스키마로 요청·응답 계약을 공유한다.

## 3. 기술 스택 (확정서 9절)

Node.js 24(로컬 22 이상 허용) · pnpm · TypeScript strict · Next.js 16 · Supabase Postgres/Auth(GitHub) · pgvector · Inngest · Vercel AI SDK + Zod · OpenAI `gpt-6-luna`(기본) / `gpt-6.1-sol`(검증 실패 시 1회 재생성) / `text-embedding-3-small`(1536차원) · Octokit · Vitest.

모델 이름은 환경 변수로 받는다(`AI_MODEL_DEFAULT`, `AI_MODEL_FALLBACK`). 임의로 다른 모델로 바꾸지 않는다.

## 4. 인증·권한

- Supabase Auth GitHub provider(PKCE). `GET /api/auth/callback`에서 code를 세션으로 교환하고 `github_login_completed`를 기록한다.
- 요청 인증은 두 가지를 모두 받는다: Supabase SSR 쿠키, `Authorization: Bearer <supabase access token>`(별도 클라이언트용).
- GitHub OAuth scope는 신원 확인 최소 범위만 쓴다. `repo`, `public_repo`, `workflow`는 요청하지 않는다. 사용자 provider token은 저장하지 않는다.
- 공개 자료 수집은 운영자 fine-grained 토큰(`GITHUB_TOKEN`, 읽기 전용)만 쓴다.
- 개인 테이블은 `auth.uid() = user_id` RLS. 공개 자료 테이블은 누구나 읽기, 쓰기는 service role(잡·운영자)만.
- 상태 변경 + 이벤트 기록은 DB RPC(트랜잭션) 하나로 처리한다.

## 5. 데이터 모델 (확정서 10.1)

| 테이블 | 핵심 |
| --- | --- |
| `profiles` | auth user ID, GitHub numeric ID(unique), login, stacks, experience_level, interested_task_types, 동의(분석·공개 추론) 버전·시각 |
| `repositories` | GitHub repo ID(unique), owner/name, 언어, stack_tags, 라이선스, 승인 상태·승인 이유(사람 작성)·승인자, 큐레이션 점검 결과, contributing URL, 라벨 설정(진행 중·보안·고급), 수집 시각 |
| `issues` | GitHub issue ID(unique), 상태·locked·라벨·assignee·연결 열린 PR, 추천 신호, 적격성(eligible / excluded / needs_review)·제외 사유, 작업 유형·부담, rule_version, last_checked_at, 운영자 플래그 |
| `source_documents` | repo/issue ID, kind(issue·closed_issue·pull_request·comment·review_comment·contributing·readme), canonical URL, 제목, content_hash, commit SHA, 절단 여부, 수집 시각 |
| `document_chunks` | source ID, chunk text, `tsvector`, `vector(1536)`, 임베딩 모델·차원 |
| `reports` | issue ID, cache_key(원문 hash 묶음 + 모델·프롬프트·스키마 버전), 상태(queued·running·ready·insufficient_evidence·failed), 검증된 결과, 요청자 |
| `journeys` | user, issue, 상태(selected·preparing·pr_linked·merged·closed_without_merge·abandoned). 사용자·이슈별 활성 여정 1개 |
| `checklist_items` | journey, 단계(env·work·test·pre_pr), kind(general·repo_rule), source ID, 완료 시각 |
| `linked_prs` | journey, GitHub PR ID, author ID, URL, 상태, merged_at, 조회 실패 상태, 마지막 성공 조회·수동 새로고침 시각 |
| `product_events` | event ID(unique), user/journey/issue/repo ID, 이벤트명, 서버 시각, dedupe_key(unique), 제한된 속성 |
| `ai_runs` / `sync_runs` | 잡 ID, 멱등 키, 성공·실패, 토큰·비용 추정·지연, 재시도·오류 코드 |
| `app_settings` | 운영자 생성 중단 스위치 |

## 6. API (확정서 10.2 + 기능 계약에서 필요한 보조 경로)

| 경로 | 기능 | 책임 |
| --- | --- | --- |
| `GET /api/health` | - | 상태 확인 |
| `GET /api/auth/callback`, `POST /api/auth/signout` | F1 | 세션 교환·종료 |
| `GET /api/profile`, `PUT /api/profile` | F2 | 허용된 스택·경험·관심 유형·동의만 갱신. 확인(`confirmed: true`) 없이는 저장하지 않음 |
| `GET /api/profile/stack-suggestions` | F2 | 공개 추론 동의 시에만 공개 저장소 언어로 후보와 근거 제시(저장 안 함) |
| `GET /api/repos`, `GET /api/repos/:id` | F3 | 승인 저장소 목록·필터, 채택 이유, 원문 신호, 마지막 확인 시각 |
| `GET /api/repos/:id/issues` | F4 | 사용자 조건 기반 최대 5개 추천, 추천 이유, rule_version, 확인 시각 |
| `POST /api/journeys`, `GET /api/journeys`, `GET /api/journeys/:id`, `PATCH /api/journeys/:id` | F9 | 서버 재검사 후 여정 생성, 진행도, 중단 |
| `PATCH /api/journeys/:id/checklist` | F6 | 본인 여정 항목 완료·취소 |
| `POST /api/reports`, `GET /api/reports/:id`, `POST /api/reports/:id/rating` | F5 | 할당량 검사·캐시 재사용·잡 접수, 상태 조회, 평가 |
| `POST /api/drafts` | F7 | 첫 댓글·PR 설명 영어 초안(저장 안 함) |
| `POST /api/journeys/:id/pr` | F8 | PR URL 파싱·작성자/저장소 확인·멱등 연결 |
| `POST /api/prs/:id/refresh` | F8 | 60초 제한 동기화 |
| `POST /api/prs/:id/review-interpretations` | F7 | 리뷰 코멘트 한국어 해석 + 원문 링크(저장 안 함) |
| `POST /api/events` | 13절 | 클라이언트가 보낼 수 있는 이벤트만 허용(초안 복사, 게시 자기보고, 리포트 열람 등), event_id 멱등 |
| `DELETE /api/account` | 12절 | 삭제 접수·세션 종료, 잡에서 삭제 |
| `/api/inngest` | - | Inngest 함수 serve |

오류 응답은 `{ error: { code, message, details? } }`로 통일한다.

## 7. 추천 규칙 (확정서 8.2·8.3) — `rule_version = 2026-11-10.1`

순수 함수(`domain/recommendation.ts`)로 구현하고 수집 시점에 계산해 저장한다. 요청 시점에는 스택·최신성 필터와 정렬만 한다.

1. **제외**: closed, locked, assignee 있음, 연결된 열린 PR, 진행 중·중단 라벨 또는 운영자 플래그, 보안 라벨/키워드, 고급 라벨(핵심 API 재설계·대규모 마이그레이션) 또는 운영자 플래그, 24시간 넘게 확인 실패.
2. **검토 필요**: 본문이 짧거나 기대 결과를 설명할 수 없음.
3. **충돌 가능성 표시(제외 아님)**: 댓글에 "working on"·"assign me" 등 작업 신호.
4. **정렬**: 신호 충족 개수(good first issue/help wanted 라벨, 운영자 확인 기대 결과, 기여 문서 존재, 30일 내 협업자 응답) 내림차순 → updated_at 내림차순 → GitHub ID 오름차순. 상위 5개.
5. **표시**: 작업 유형 docs/test/bug/feature/unknown, 부담 low_prerequisites/needs_confirmation/advanced + 근거. "성공 확률"·"쉬움"으로 표현하지 않는다.

LLM은 제외·순위 결정에 쓰지 않는다.

## 8. 수집·갱신 잡 (확정서 8.4, Inngest)

| 함수 | 주기 | 내용 |
| --- | --- | --- |
| `sync-repositories` | 24시간 | 메타데이터, CONTRIBUTING/README(SHA·hash로 변경 감지) |
| `sync-issues` | 6시간 | 열린 이슈 증분 수집, 규칙 평가, 12개월 이슈 500/PR 300 인덱싱 |
| `sync-linked-prs` | 1시간 | open PR 상태 동기화 |
| `embed-chunks` | 이벤트 | 임베딩 없는 chunk 처리 |
| `generate-report` | 이벤트 | 전체 동시 2, 사용자별 1 |
| `delete-account` | 이벤트 | 계정 삭제 |
| `cleanup` | 매일 | 90일 미참조 리포트·이벤트, 30일 로그 정리 |

GitHub 403/429는 `retry-after`/`x-ratelimit-reset`에 따른 지수 백오프. 마지막 성공 자료와 실패 상태를 분리 저장한다. PR 조회 실패는 `closed`로 추정하지 않고 `fetch_error`로 표시한다.

## 9. 리포트 파이프라인 (확정서 11절)

1. 이슈가 15분 넘게 미확인이면 재조회.
2. 이슈 본문, 댓글(처음 20 + 최근 80, 중간 누락 표시), CONTRIBUTING, 명시적 연결 이슈·PR 수집.
3. 약 800토큰/100토큰 겹침 chunk, FTS 상위 20 + 벡터 상위 20 → RRF(k=60), 동일 저장소만, 상위 8개 + 필수 기여 안내.
4. 입력 12,000토큰, 출력 3,000토큰 상한. 원문은 `<source id="S3">` 데이터로만 전달하고, 원문 속 지시는 실행하지 않도록 지시.
5. 출력: `items[{claim, kind: fact|interpretation|unknown, source_ids}]`, `related_work`, `contributing_steps[{stage, text, source_ids, command?}]`, `unknowns`.
6. 검증: 제공한 source ID만 허용, fact/interpretation은 1개 이상 필수, 명령어는 원문에 그대로 있어야 함. 실패 시 fallback 모델로 1회 재생성, 그래도 실패하면 `insufficient_evidence`.
7. URL은 서버가 source ID → canonical URL로 변환. 모델 출력 URL은 쓰지 않는다.
8. 캐시: 원문 hash 묶음 + 모델·프롬프트·스키마 버전.

## 10. 여정·PR 상태 (확정서 10.2)

`selected → preparing → pr_linked → merged | closed_without_merge`, `selected|preparing → abandoned`, reopen 시 `pr_linked`로 복귀.
PR 이벤트 dedupe key는 `pr:{id}:v{status_version}`. `first_pr_merged`, `second_contribution_started`, `second_pr_connected`는 사용자별 1회(unique index).

## 11. 비용·사용 제한 (확정서 12절)

사용자별 하루 리포트 5회, 초안+번역 10회(캐시 조회 제외). 리포트 동시 전체 2/사용자 1. 월 예산(`AI_MONTHLY_BUDGET_USD`, 기본 50) 80%에서 경고 로그, 소진 시 새 생성 중단. `app_settings.generation_enabled`로 운영자 즉시 중단.

## 12. 테스트

- Vitest 단위 테스트: 추천 규칙(제외·동점·빈 후보·오래된 자료), PR URL 파싱, 여정·PR 상태 전이, 리포트 출력 검증(없는 source ID·명령어 날조·근거 없는 사실), chunking·RRF, 할당량.
- SQL: 임시 Postgres에서 migration 적용·RPC 동작 확인.
- E2E·AI 평가 세트(50개)는 실제 계정·데이터가 생긴 뒤 진행.

## 13. 이번에 막혀서 넘기는 것

| 항목 | 이유 | 이후 할 일 |
| --- | --- | --- |
| Supabase 프로젝트·GitHub OAuth 앱·OpenAI·Inngest·GitHub 토큰 설정 | 계정·키 필요 | `.env.example` 값 채우기 |
| 초기 20개 저장소 실제 목록 | 운영자 검수 필요(확정서 8.1) | `pnpm --filter @sos/server curate check owner/name` 후 `approve` |
| 실제 GitHub/OpenAI 호출 검증, 지연·비용 측정 | 키 없음 | 키 설정 후 스모크 테스트 |
| PostHog·Sentry | 키 없음, 선택 기능 | 인터페이스만 두고 미연결 |
| pgvector 포함 로컬 DB 검증 | 로컬 Docker 미실행, pgvector 미설치 | `supabase start` 후 `supabase db reset` |

## 14. 구현 상태 (2026-11-11)

| 영역 | 상태 | 확인 방법 |
| --- | --- | --- |
| 모노레포·공유 계약(`@sos/shared`) | 완료 | `pnpm typecheck` |
| DB 스키마·RLS·RPC·하이브리드 검색 | 완료 | 임시 Postgres에서 migration 적용 + `supabase/tests/rpc_scenarios.sql` 통과 (pgvector는 shim으로 대체해 검증) |
| 추천 규칙·PR·리포트 검증·chunking·큐레이션 점검 | 완료 | Vitest 53개 통과 |
| API 22개 경로 + CORS proxy | 완료 | `next build` 통과, 인증·검증·CORS·DB 장애 응답 스모크 테스트 |
| 수집·리포트·PR 동기화·삭제·정리 잡 | 코드 완료 | 실제 GitHub/OpenAI/Inngest 키가 없어 미실행 |
| 운영자 큐레이션 CLI | 코드 완료 | 실제 저장소 대상 미실행 |
| 실제 20개 저장소, AI 평가 세트, E2E | 미착수 | 계정·키·운영자 검수 필요 (13절) |
