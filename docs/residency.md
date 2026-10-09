# Data residency (M-16)

**Rule:** customer data (scans, plans, drawings, 3D models, account details,
mail recipients, logs that identify people) is stored and processed in
**ap-southeast-2 (Sydney)** only.

This page lists every service the system uses and where it runs. The infra
test `infra/test/residency.test.ts` enforces the AWS part: it synthesizes
every environment and fails if any stack is outside ap-southeast-2, apart
from the us-east-1 stacks listed below, or if any template names another
region.

Run it with `cd infra && npm test`.

## AWS services (dev, staging, prod)

| Service | What it holds or does | Region | Customer data? | Notes |
|---------|-----------------------|--------|----------------|-------|
| VPC, NAT, VPC endpoints | Network | ap-southeast-2 | Passes through | |
| RDS MySQL 8.4 | Accounts, facilities, plans, audit | ap-southeast-2 | Yes | KMS-encrypted; Multi-AZ in prod (both AZs in Sydney); backups and snapshots stay in the region (no cross-region copy configured) |
| S3 captures bucket | Raw scans, uploads, drawings | ap-southeast-2 | Yes | KMS; versioned; cold objects move to Glacier Instant Retrieval in the same region |
| S3 models bucket | 3D models | ap-southeast-2 | Yes | KMS; versioned |
| S3 logs bucket | ALB and S3 access logs (IPs, paths) | ap-southeast-2 | Personal data (IPs) | SSE-S3 (log delivery cannot use KMS); expires after 400 days |
| S3 web bucket | Built web app (HTML/JS) | ap-southeast-2 | No | |
| SQS jobs, gpu-jobs and DLQs | Job messages (ids, not content) | ap-southeast-2 | Ids only | KMS |
| Secrets Manager | App and database secrets | ap-southeast-2 | No | |
| KMS | Encryption keys | ap-southeast-2 | No | One data key per environment |
| ECS Fargate, ECR | API and Node worker, container images | ap-southeast-2 | Processes it | |
| ALB, AWS WAF (regional) | API traffic | ap-southeast-2 | Passes through | WAF sampled requests stay in the region |
| SES | Outgoing mail | ap-southeast-2 | Recipient addresses, mail content | Configuration set and suppression list are regional |
| SNS (mail events, alarms) | Bounce/complaint events; alarm messages | ap-southeast-2 | Mail events: addresses | Mail-events topic is KMS-encrypted |
| CloudWatch Logs, metrics, dashboard, alarms | App logs, metrics | ap-southeast-2 | Logs may contain ids and emails | Retention 30 days (dev/staging), 365 days (prod) |
| Route 53 | DNS records | Global service | No | DNS names only |
| **CloudFront** (web app; models when enabled) | Edge cache | **Global edge locations** | Web app: no. Models: cached copies of signed responses | See below |
| **ACM certificate for CloudFront** | Public TLS certificate | **us-east-1** (AWS requirement) | No | `<env>/EdgeCerts` stack. Holds only the certificate |
| **CDK Pipelines support stack** | Artifact bucket for deploying EdgeCerts | **us-east-1** | No | `cross-region-stack-<account>:us-east-1`: templates and build artifacts only |
| CodePipeline, CodeBuild, CodeCommit | Source, build, release | ap-southeast-2 | No | Backend tests use a throwaway MySQL with test data only |
| AWS Chatbot (optional) | Forwards alarms to Slack | Global service | No | Alarm text only; Slack is outside AWS |

### CloudFront and edge caching

CloudFront serves from edge locations worldwide, so responses can be cached
outside Australia close to the viewer. **Origins stay in Sydney**: the web
bucket, and the models bucket behind signed URLs. For the web app this is
fine (public static files, no customer data). For 3D models, cached copies of
a model can sit at an edge location near whoever opened the signed link,
for as long as the cache policy allows. If that is not acceptable for
models, the 3D team should either:

- switch the models distribution to `CachePolicy.CACHING_DISABLED` (edges
  then pass requests through to Sydney without keeping a copy; no price class
  limits edges to Australia), or
- serve models with presigned S3 URLs from the Sydney bucket directly and drop
  the models distribution.

Decision owner: product owner with the 3D team (open item 3).

## Outside AWS

| Service | Where | Customer data? | Owner |
|---------|-------|----------------|-------|
| GoalCert Hub (OIDC sign-in, events) | GoalCert's hosting | User identity | GoalCert team |
| GoalCert DNS (web subdomain, NS delegation) | GoalCert's DNS provider | No | GoalCert team |
| Apple TestFlight / App Store | Apple | App binary only | Mobile team |
| fastlane match signing repo | Private git host | No (signing material) | Mobile team |
| Slack (alarm channel) | Slack | Alarm text only | Ops |

## Open items (owned by others)

1. **Vision model.** Wherever the scan-understanding model runs (hosted API
   or self-hosted), it must run in Sydney. If it is a third-party API, its
   processing region must be confirmed in writing as Australia, or it must be
   self-hosted in ap-southeast-2. Owner: ML / 3D team.
2. **GPU worker.** The 3D reconstruction worker (`gpu-jobs` queue, `g6e.xlarge`)
   must run in ap-southeast-2. Its quota request is in
   `runbooks/service-quotas.md`. If g6e is not available in Sydney, a
   different Sydney instance type must be chosen, not a different region.
   Owner: 3D team.
3. **Models distribution caching** (see above). Owner: product owner and 3D
   team.
4. **GoalCert Hub location.** Confirm with GoalCert where Hub stores the user
   identities it shares with us. Owner: GoalCert team.
5. **Backups.** No cross-region backup copy is configured, on purpose. If a
   disaster-recovery copy is wanted later, it must go to another Australian
   region (ap-southeast-4, Melbourne), and this page and the test must be
   updated. Owner: product owner.
