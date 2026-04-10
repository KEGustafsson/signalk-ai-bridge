# signalk-ai-bridge

Signal K AI Bridge configured as an **embedded webapp** for Signal K Admin UI.

## Plan implementation (current)

### ✅ Embedded webapp integration

- `src/index.ts` exports `AppPanel` as the embedded panel entry for host integration.
- Package is marked with `signalk-embeddable-webapp` keyword.
- App metadata includes display name and icon.

### ✅ Read-only operator tools

- **Get Vessel Snapshot** (`navigation.position`, SOG, COGT)
- **Get Active Alarms** (`vessels.self.notifications`)
- **Get Recent Deltas** from diffed `vessels.self` snapshots persisted in app data

### ✅ Draft-only workflow starter

- **Create Waypoint Draft** with explicit user action.
- Draft object is persisted in app data and does not mutate vessel state.

### ✅ Policy and authorization baseline

- Tool authorization is enforced via `authorizeTool()` before every action.
- Role-based policy supports `viewer`, `operator`, and `admin` via app data key `ai-bridge/user-role`.
- Additional allow-list policy can be set via `ai-bridge/allowed-tools`.
- Signed policy documents can be verified/applied through `applySignedPolicyUpdate()`.
- Remote signed policy sync can be performed through `syncPolicyFromServer()` / `syncPolicyFromServerWithTokenProvider()`.
- Policy sync mTLS attestation checks can be required, and are pinned-certificate gated by default to reduce trust-on-header-only configurations.
- Pinned certificate fingerprint comparisons use normalized, constant-time equality checks to reduce side-channel leakage.
- Policy sync can enforce freshness windows (`maxPolicyAgeMs`), future timestamp skew limits (`maxFutureSkewMs`), and expiry checks before applying remote policy documents.
- Freshness window options are validated as finite non-negative values, and future-issued policies are rejected by default unless bounded skew is explicitly configured.
- Policy sync allows transport wiring via `fetchImpl` + `fetchInitOverrides` (for example, Node fetch `dispatcher` configuration used for client-certificate mTLS plumbing).
- `createMutualTlsFetchInitOverrides()` can build Node-compatible fetch overrides from client cert/key material for runtime mTLS transport wiring.
- `syncPolicyFromServer()` can also accept `mutualTlsClientConfig` + `mutualTlsAgentFactory` to derive mTLS transport overrides directly in the sync call path.
- `createHardenedPolicySyncOptions()` provides a secure-by-default preset (`requireMutualTls: true` + mandatory pinned fingerprint), and requires `mutualTlsAgentFactory` when mTLS client cert config is provided.
- Logged-out users are blocked from tool execution.

### ✅ Runtime bridge boundary baseline

- Tool execution is routed through `executeBridgeRequest()` with auth-token verification, policy checks, and audit logging before tool dispatch.

### ✅ Audit trail baseline

- Tool execution outcomes are appended to app data audit key `ai-bridge/audit-log`.
- Outcomes are tracked as `allowed`, `denied`, or `error` with timestamps and tool IDs.
- Malformed existing audit payloads are safely normalized before appending new entries.

### ✅ Quality gates and operations baseline

- TypeScript strict checks + Node-based unit tests + mocked integration harness test + smoke baseline
- GitHub Actions CI pipeline for lint, typecheck, test, npm audit, and Trivy filesystem scan
- Hardened Docker Compose template for Gemma + bridge isolation

## Development

```bash
npm install
npm run dev
```

## Local checks

```bash
npm run lint        # smoke-based lint gate in this environment
npm run typecheck
npm run test        # compiles and runs unit tests with Node test runner
npm run test:smoke  # lightweight source smoke validation
npm run check
```

## Build

```bash
npm run build
```

## Compose template

Use `docker-compose.gemma.yml` as a starting point for local/private deployment and hardening.

## Remaining roadmap

- None currently tracked in this baseline slice.
