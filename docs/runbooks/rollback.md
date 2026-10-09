# Roll back

Pick the smallest step that fixes the problem. Examples use prod; replace
`prod` with `staging` or `dev` as needed. Region is always `ap-southeast-2`.

## 1. A bad deploy is still rolling out

The ECS deployment circuit breaker rolls back by itself when new tasks fail
their health checks (`/health` for the API, `node src/healthcheck.js` for
both). Check:

```sh
aws ecs describe-services --region ap-southeast-2 --cluster flexgym-prod \
  --services flexgym-prod-api flexgym-prod-worker \
  --query "services[].deployments[].{status:status,rollout:rolloutState,reason:rolloutStateReason,taskDef:taskDefinition}"
```

## 2. The app is up but behaves wrongly: go back to the previous task definition

Fastest fix; it does not touch the infrastructure.

```sh
# Find the previous revision
aws ecs list-task-definitions --region ap-southeast-2 --family-prefix flexgym-prod-api --sort DESC --max-items 3

aws ecs update-service --region ap-southeast-2 --cluster flexgym-prod \
  --service flexgym-prod-api --task-definition flexgym-prod-api:<previous-revision>
aws ecs update-service --region ap-southeast-2 --cluster flexgym-prod \
  --service flexgym-prod-worker --task-definition flexgym-prod-worker:<previous-revision>

aws ecs wait services-stable --region ap-southeast-2 --cluster flexgym-prod \
  --services flexgym-prod-api flexgym-prod-worker
```

The next pipeline run puts the template's task definition back, so follow up
with step 3.

## 3. Revert the commit (the durable fix)

```sh
git revert <bad-commit>
git push origin main
```

The pipeline deploys the revert to staging; approve it into prod as usual.
To skip waiting on staging in an emergency, the release can still only reach
prod through the approval step; approve it as soon as staging is green.

## 4. A web app release is broken

The web app is redeployed by the pipeline (step 3). For an immediate fix,
upload the previous build and invalidate the cache:

```sh
aws s3 sync ./previous-dist s3://<SiteBucketName> --delete
aws cloudfront create-invalidation --distribution-id <DistributionId> --paths "/*"
```

`SiteBucketName` and `DistributionId` are outputs of `FlexGym-Prod-Web`.

## 5. An infrastructure change failed

CloudFormation rolls a failed stack update back by itself. If a stack is stuck
in `UPDATE_ROLLBACK_FAILED`:

```sh
aws cloudformation continue-update-rollback --region ap-southeast-2 --stack-name FlexGym-Prod-Api
```

## Things a rollback does not undo

- **Database migrations.** Rolling the code back does not reverse a schema
  change. Migrations should be backwards compatible with the previous release
  (add first, remove a release later). If data was damaged, see
  `database-restore.md`.
- **Secrets.** A rotated `JWT_SECRET` stays rotated.
- **Messages already queued.** Jobs created by the bad version stay in the
  queue; check the DLQ (`ses-bounces.md` covers mail, the dashboard covers
  jobs).
