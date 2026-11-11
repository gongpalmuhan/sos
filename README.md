# SOS (Search Open Source)

한국어 사용자가 공개 오픈소스에서 자신에게 맞는 이슈를 고르고, 저장소의 맥락과 절차를 원문 근거와 함께 이해해 첫 기여를 실행하도록 돕는 서비스.

- 제품·기술 기준: Notion「0. SOS MVP 확정서」(MVP v1.0)
- 서버 구현 계획: [docs/server-plan.md](docs/server-plan.md)

## 저장소 구조

```
apps/server      Next.js 16 API 서버 (route handlers + Inngest 잡)
apps/web         (예정) 클라이언트
packages/shared  API 계약: Zod 스키마·타입·상수 (서버·클라이언트 공용)
supabase/        config, SQL migration, RPC 시나리오 테스트
docs/            계획·범위 문서
```

## 시작하기

```bash
pnpm install
```

```bash
cp apps/server/.env.example apps/server/.env.local
```

```bash
supabase start && supabase db reset
```

```bash
pnpm dev:server
```

서버는 `http://localhost:4000`에서 뜹니다. 자세한 내용은 [apps/server/README.md](apps/server/README.md).

## 검증

```bash
pnpm test
```

```bash
pnpm typecheck
```

DB RPC 시나리오(로컬 Supabase가 떠 있을 때):

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/tests/rpc_scenarios.sql
```
