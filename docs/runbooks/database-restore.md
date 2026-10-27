# Restore the database

RDS MySQL 8.4, instance `flexgym-<env>` in ap-southeast-2. Automated backups
are kept 30 days in prod and 7 days elsewhere, which allows point-in-time
recovery (PITR) to any second in that window (usually up to about 5 minutes
ago). The instance is encrypted with the `alias/flexgym-<env>-data` KMS key,
and so are its snapshots.

**A restore always creates a new instance.** The original keeps running
until you switch the app over, so you can compare and copy data first.

## 0. Decide what you need

| Situation | Do this |
|-----------|---------|
| A few rows deleted or damaged | Restore to a new instance, copy the rows back (section 3). The app stays on the original. |
| Whole database bad, need it as of a time | PITR (section 1), then switch the app (section 4). |
| Need it as of a named snapshot | Snapshot restore (section 2), then switch. |

Stop the worker first if it could make things worse (it writes plans and
sends mail):

```sh
aws ecs update-service --region ap-southeast-2 --cluster flexgym-prod --service flexgym-prod-worker --desired-count 0
```

## Values you will need

```sh
aws rds describe-db-instances --region ap-southeast-2 --db-instance-identifier flexgym-prod \
  --query "DBInstances[0].{class:DBInstanceClass,subnets:DBSubnetGroup.DBSubnetGroupName,sg:VpcSecurityGroups[0].VpcSecurityGroupId,params:DBParameterGroups[0].DBParameterGroupName,multiAz:MultiAZ}"
aws rds describe-db-instance-automated-backups --region ap-southeast-2 --db-instance-identifier flexgym-prod \
  --query "DBInstanceAutomatedBackups[0].RestoreWindow"
```

## 1. Point-in-time restore

```sh
aws rds restore-db-instance-to-point-in-time --region ap-southeast-2 \
  --source-db-instance-identifier flexgym-prod \
  --target-db-instance-identifier flexgym-prod-restore-$(date +%Y%m%d%H%M) \
  --restore-time 2026-10-09T03:15:00Z \
  --db-instance-class <class> \
  --db-subnet-group-name <subnets> \
  --vpc-security-group-ids <sg> \
  --db-parameter-group-name <params> \
  --multi-az \
  --no-publicly-accessible
```

Times are UTC (the database runs in UTC). Use `--use-latest-restorable-time`
instead of `--restore-time` for "as late as possible". Drop `--multi-az`
outside prod.

## 2. Restore from a snapshot

```sh
aws rds describe-db-snapshots --region ap-southeast-2 --db-instance-identifier flexgym-prod \
  --query "reverse(sort_by(DBSnapshots,&SnapshotCreateTime))[:5].[DBSnapshotIdentifier,SnapshotCreateTime]" --output table

aws rds restore-db-instance-from-db-snapshot --region ap-southeast-2 \
  --db-snapshot-identifier <snapshot-id> \
  --db-instance-identifier flexgym-prod-restore-$(date +%Y%m%d%H%M) \
  --db-instance-class <class> --db-subnet-group-name <subnets> \
  --vpc-security-group-ids <sg> --db-parameter-group-name <params> \
  --multi-az --no-publicly-accessible
```

A deleted dev or staging stack leaves a final snapshot; prod's instance is
retained and has deletion protection.

Wait for it:

```sh
aws rds wait db-instance-available --region ap-southeast-2 --db-instance-identifier <new-id>
```

## 3. Copy data back (partial restore)

The restored instance is in the isolated subnets, so connect from inside the
VPC: run a one-off task from the worker task definition with a shell, or a
temporary bastion with Session Manager. The user and password are the same as
the source (secret `flexgym-prod/database`).

```sh
mysqldump --ssl-mode=REQUIRED -h <restored-endpoint> -u gymplan -p gymplan <table> \
  --where="id IN (...)" --no-create-info > rows.sql
mysql --ssl-mode=REQUIRED -h <live-endpoint> -u gymplan -p gymplan < rows.sql
```

Delete the restored instance when done (section 5).

## 4. Switch the app to the restored instance

The app reads `DB_HOST` from the task definition, which CDK sets from the
stack. The clean switch is to rename instances so the endpoint name moves:

```sh
aws rds modify-db-instance --region ap-southeast-2 --db-instance-identifier flexgym-prod \
  --new-db-instance-identifier flexgym-prod-old --apply-immediately
aws rds wait db-instance-available --region ap-southeast-2 --db-instance-identifier flexgym-prod-old
aws rds modify-db-instance --region ap-southeast-2 --db-instance-identifier <new-id> \
  --new-db-instance-identifier flexgym-prod --apply-immediately
aws rds wait db-instance-available --region ap-southeast-2 --db-instance-identifier flexgym-prod
```

Then restart both services so they reconnect:

```sh
aws ecs update-service --region ap-southeast-2 --cluster flexgym-prod --service flexgym-prod-api --force-new-deployment
aws ecs update-service --region ap-southeast-2 --cluster flexgym-prod --service flexgym-prod-worker --force-new-deployment --desired-count <normal>
```

Afterwards: CloudFormation tracks the instance by its identifier, so the
stack now manages the restored instance. Run drift detection on
`FlexGym-Prod-Data` and fix any setting that differs (backup retention,
monitoring, log exports, deletion protection) before the next deploy:

```sh
aws cloudformation detect-stack-drift --region ap-southeast-2 --stack-name FlexGym-Prod-Data
aws cloudformation describe-stack-resource-drifts --region ap-southeast-2 --stack-name FlexGym-Prod-Data \
  --stack-resource-drift-status-filters MODIFIED
```

`flexgym-prod-old` is no longer managed by any stack; keep it for a few days,
then delete it (section 5). Enable deletion protection on the new instance:

```sh
aws rds modify-db-instance --region ap-southeast-2 --db-instance-identifier flexgym-prod --deletion-protection --apply-immediately
```

## 5. Clean up

```sh
aws rds delete-db-instance --region ap-southeast-2 --db-instance-identifier <id> \
  --final-db-snapshot-identifier <id>-final
```

## Test it

Do a PITR into staging once a quarter and note the time it took; restores of
the prod size take tens of minutes.
