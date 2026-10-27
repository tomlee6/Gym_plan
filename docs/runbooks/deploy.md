# Deploy

How code gets to dev, staging and prod. Infrastructure code is in `infra/`
(see `infra/README.md`). Everything runs in **ap-southeast-2**; the only
us-east-1 stack holds the web app's CloudFront certificate.

| Environment | Stack prefix | How it is deployed |
|-------------|--------------|--------------------|
| dev | `FlexGym-Dev-` | By hand, `cdk deploy` from a laptop |
| staging | `FlexGym-Staging-` | Pipeline `flexgym-release`, on every push to `main` |
| prod | `FlexGym-Prod-` | Same pipeline, after the manual approval `PromoteToProd` |

## Normal release (staging, then prod)

1. Merge to `main` in CodeCommit `gym_floor_plan`.
2. The pipeline runs: web tests and build, infra synth (with infra tests),
   self-update, image publishing, backend tests against MySQL 8.4, staging
   deploy.
3. Check staging: `https://api.staging.gym.goalcert.example/health`, sign in
   on the web app, upload a scan from a TestFlight build.
4. Approve `PromoteToProd`:

   ```sh
   aws codepipeline get-pipeline-state --name flexgym-release --region ap-southeast-2 \
     --query "stageStates[?stageName=='FlexGym-Prod'].actionStates[?actionName=='PromoteToProd'].latestExecution.token" --output text
   aws codepipeline put-approval-result --pipeline-name flexgym-release --region ap-southeast-2 \
     --stage-name FlexGym-Prod --action-name PromoteToProd --token <token> \
     --result summary="Checked staging",status=Approved
   ```

   (Or click **Review** in the CodePipeline console.)
5. Watch the ECS deployment finish. The deployment circuit breaker rolls
   back by itself if new tasks fail their health checks.

   ```sh
   aws ecs describe-services --region ap-southeast-2 --cluster flexgym-prod \
     --services flexgym-prod-api flexgym-prod-worker \
     --query "services[].{name:serviceName,rollout:deployments[0].rolloutState,running:runningCount}"
   ```

## Database migrations

Migrations are not run by the deploy. Run them as a one-off task with the new
image before (additive changes) or after (removals) the release:

```sh
aws ecs run-task --region ap-southeast-2 --cluster flexgym-prod --launch-type FARGATE \
  --task-definition flexgym-prod-worker \
  --network-configuration "awsvpcConfiguration={subnets=[<private-subnet-id>],securityGroups=[<worker-sg-id>]}" \
  --overrides '{"containerOverrides":[{"name":"worker","command":["node","src/db/migrate.js"]}]}'
```

Subnet and security group ids: `aws ecs describe-services --cluster flexgym-prod --services flexgym-prod-worker --query "services[0].networkConfiguration"`.

## Deploying dev by hand

```sh
cd infra
npm ci
npx cdk deploy "FlexGym-Dev/*" --profile flexgym-dev
# With the web app:
(cd ../web && npm ci && npm run build)
npx cdk deploy "FlexGym-Dev/*" -c deployWebAssets=true --profile flexgym-dev
```

## First deploy of a new environment (one time)

1. **Bootstrap** the account in both regions (prod and staging trust the
   pipeline account):

   ```sh
   npx cdk bootstrap aws://<account>/ap-southeast-2 aws://<account>/us-east-1 \
     --trust <pipeline-account> --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
   ```

   Bootstrap the pipeline account too (`ap-southeast-2` and `us-east-1`).
2. **Pipeline** (once): `npx cdk deploy FlexGym-Pipeline --profile flexgym-tooling`.
   After that it updates itself.
3. **DNS delegation**: the `Dns` stack prints `DelegationNameServers`. Ask the
   GoalCert team to add an `NS` record for the API zone (e.g.
   `api.gym.goalcert.example`) with those values. The API certificate and the
   SES records validate only after this.
4. **Web certificate**: while `EdgeCerts` is deploying it waits for DNS
   validation. Get the record and send it to the GoalCert team:

   ```sh
   aws acm list-certificates --region us-east-1 \
     --query "CertificateSummaryList[?DomainName=='gym.goalcert.example'].CertificateArn" --output text
   aws acm describe-certificate --region us-east-1 --certificate-arn <arn> \
     --query "Certificate.DomainValidationOptions[].ResourceRecord"
   ```

   The record also shows in the stack's CloudFormation events. The stack
   times out after about 72 hours if nobody adds it.
5. **Web DNS**: the `Web` stack's `GoalCertDnsRecord` output is the CNAME
   GoalCert adds for the web app (`gym.goalcert.example CNAME dxxxx.cloudfront.net`).
6. **Sign-in**: nothing to set by hand; the `Auth` stack creates the Cognito
   user pool and its client secret. Cognito sends invitations through SES, so
   SES must be out of the sandbox (step 7) before inviting real people.
7. **SES**: request production access (`service-quotas.md`).
8. **Alerts**: confirm the SNS email subscription if `alarmEmail` is set;
   authorise the Slack workspace in the AWS Chatbot console before setting
   `slackWorkspaceId`/`slackChannelId`.
