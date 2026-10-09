# Flex Gym Scan infrastructure (AWS CDK)

AWS CDK v2 app (TypeScript) for the backend, web app hosting, email,
monitoring and the release pipeline. Everything runs in **ap-southeast-2
(Sydney)**; the one exception is the web app's CloudFront certificate, which
AWS requires in us-east-1 (see `../docs/residency.md`).

Nothing here deploys by itself. `cdk synth` needs no AWS credentials.

## Commands

```sh
cd infra
npm install
npx tsc --noEmit          # type-check
npm test                  # residency test (synthesizes everything)
npx cdk synth             # all stacks -> cdk.out/
npx cdk ls                # stack list
npx cdk diff "FlexGym-Dev/*"   --profile <dev profile>
npx cdk deploy "FlexGym-Dev/*" --profile <dev profile>
npx cdk deploy FlexGym-Pipeline --profile <tooling profile>   # once; it then updates itself
```

Deploying and rolling back: `../docs/runbooks/`.

## What gets built

```
bin/app.ts                 entry point
lib/app.ts                 builds the app: FlexGym-Dev stage + FlexGym-Pipeline stack
lib/config.ts              per-environment settings from cdk.json (M-01)
lib/stage.ts               one environment = these stacks:
  lib/network-stack.ts       Network     VPC (public / private-egress / isolated), endpoints (M-02)
  lib/dns-stack.ts           Dns         Route 53 zone for API + mail (M-08)
  lib/edge-cert-stack.ts     EdgeCerts   us-east-1 ACM cert for CloudFront (M-06, M-08)
  lib/data-stack.ts          Data        KMS, RDS MySQL 8.4, S3, SQS, secrets (M-03, M-04, M-10)
  lib/models-distribution.ts             CloudFront + key group for models (M-07, 3D team)
  lib/mail-stack.ts          Mail        SES identity, DKIM, MAIL FROM, DMARC, events (M-09)
  lib/api-stack.ts           Api         ECS Fargate API + ALB, worker, autoscaling (M-05)
  lib/waf.ts                             WAF web ACL with rate limits (D-10)
  lib/web-stack.ts           Web         SPA bucket + CloudFront + security headers (M-06)
  lib/monitoring-stack.ts    Monitoring  dashboard, alarms, Slack (M-11)
lib/pipeline-stack.ts      CodePipeline V2: tests, synth, staging, approval, prod (M-12)
test/residency.test.ts     every stack in Sydney except the cert stacks (M-16)
```

Stacks are named `<stage>-<stack>`: `FlexGym-Dev-Api`,
`FlexGym-Staging-Data`, `FlexGym-Prod-Web`, ... Dev is deployed by hand;
staging and prod only through the pipeline.

### Container image

The API and the worker use one image built from `../backend/Dockerfile` with
the **repository root** as build context, because the backend imports
`../../../shared/plan/index.js`. CDK builds and pushes it to the bootstrap
ECR repository on deploy (a `DockerImageAsset`); only `backend/` and
`shared/` are sent to Docker. Build it locally with:

```sh
docker build -f backend/Dockerfile -t flexgym-backend .   # from the repo root
```

| Service | Command | Port | Health check |
|---------|---------|------|--------------|
| API | `node src/server.js` | 8080 | ALB `GET /health`; container `node src/healthcheck.js` |
| worker | `node src/worker.js` | none | container `node src/healthcheck.js` |

Both get the same environment (`NODE_ENV`, `PUBLIC_*_URL`, `DB_*`, `S3_*`,
`MODELS_BUCKET`, `QUEUE_DRIVER=sqs`, `JOBS_QUEUE_URL`, `GPU_JOBS_QUEUE_URL`,
`MAIL_*`, `SES_CONFIGURATION_SET`, `HUB_*`, `ALLOW_SIMULATED_SCANS=false`) and
secrets (`DB_USER`, `DB_PASSWORD`, `JWT_SECRET`, `STORAGE_SIGNING_SECRET`,
`HUB_CLIENT_SECRET`, `HUB_EVENTS_SECRET`) from Secrets Manager. See
`lib/api-stack.ts` for the full list.

`DB_SSL=true` and the database has `require_secure_transport=ON`. The backend
must trust the Amazon RDS CA (mysql2's `ssl: 'Amazon RDS'` profile, or the
bundle from https://truststore.pki.rds.amazonaws.com).

## Context (cdk.json)

All environment settings are placeholders until GoalCert and the product
owner confirm them. Change them in `cdk.json`.

| Key | Meaning |
|-----|---------|
| `environments.<dev\|staging\|prod>.account` | AWS account id (placeholders `111111111111`, ...) |
| `.region` | Must be `ap-southeast-2`; synth fails otherwise |
| `.hostedZoneName` / `.hostedZoneId` | Route 53 zone we manage (delegated from GoalCert DNS). Empty id = create it |
| `.apiDomain` | API host, inside the zone, e.g. `api.gym.goalcert.example` |
| `.webDomain` | Web app host on the GoalCert domain, e.g. `gym.goalcert.example` |
| `.webDnsManagedByGoalCert` | `true`: we output the CNAME (and the cert validation record is added by GoalCert). `false`: we create the records in our zone (webDomain must then be inside it) |
| `.mailDomain`, `.mailFromLocalPart` | SES identity (inside the zone) and sender, e.g. `no-reply@...` |
| `.webCsp` | Content-Security-Policy for the web app; empty = default in `web-stack.ts` |
| `.natGateways`, `.db*`, `.api*`, `.worker*` | Sizes. Multi-AZ (`dbMultiAz`) only in prod |
| `.logRetentionDays` | CloudWatch log retention |
| `.alarmEmail` | Optional email subscribed to alarms and mail events |
| `.slackWorkspaceId`, `.slackChannelId` | Optional AWS Chatbot Slack target (authorise the workspace in the Chatbot console first) |
| `.modelsSigningPublicKeyPem` | Public key for signed model URLs. Empty = no models distribution (M-07, 3D team) |
| `.hub.*` | GoalCert Hub OIDC endpoints, client id, org id, redirect URIs |
| `pipeline.account`, `.repositoryName`, `.branch` | Tooling account and CodeCommit source |
| `deployWebAssets` | `true` uploads `../web/dist` (build it first). Pass `-c deployWebAssets=true`. The pipeline always does |
| `webDistPath` | Optional other folder to upload instead of `../web/dist` |

## Things to know

- **Stateful resources are kept.** Buckets, the KMS key and secrets are
  retained when a stack is deleted. The database is snapshotted (dev,
  staging) or retained with deletion protection (prod).
- **Cross-stack references.** The Data stack must never reference anything
  in the Api stack (that would be a cycle). That is why the database's
  security group rules are created in the Api stack, and why secrets use
  Secrets Manager's own KMS key rather than the data key.
- **No lookups.** Synth makes no AWS calls: AZs are pinned in the Network
  stack and the zone is created or imported by id.
- **Jobs metrics.** The worker publishes `JobsSucceeded`, `JobsFailed` and
  `JobsDead` in namespace `FlexGym/Jobs` (embedded metric format, dimension
  `Kind`). The `jobs-dead` alarm uses a Metrics Insights query that sums
  over all kinds.
- **GPU worker (3D team).** The `gpu-jobs` queue and its DLQ alarm exist; the
  GPU service, its image and the models distribution's custom domain are left
  as TODOs for the 3D team (`pipeline-stack.ts`, `data-stack.ts`).
