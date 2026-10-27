# Service quotas and manual AWS requests (M-15)

Two things cannot be done by CDK and must be requested by hand, per account,
in **ap-southeast-2**. Both can take days, so request them as soon as the
staging and prod accounts exist.

| Request | Needed by | Typical wait |
|---------|-----------|--------------|
| GPU instances: G and VT On-Demand vCPU quota (for `g5.2xlarge`) | The 3D (GPU) worker | 1 to 3 business days; can need a follow-up |
| SES production access | Mail to any address (not just verified ones) | About 1 business day |

Use the account the resources run in (staging and prod separately).

## 1. GPU quota for g5.2xlarge

EC2 quotas are counted in **vCPUs per instance family group**, not in
instances. `g5.2xlarge` is 8 vCPUs. New accounts often have 0 for G instances.

Decide the number: maximum concurrent GPU workers x 8. Example: up to 2
workers in prod = 16 vCPUs; ask for 32 to leave room for a deploy that starts
new instances before stopping old ones. Dev and staging (1 worker): ask for 16.

1. Check the current value. The quota is "Running On-Demand G and VT
   instances", code `L-DB2E81BA`:

   ```sh
   aws service-quotas get-service-quota --region ap-southeast-2 \
     --service-code ec2 --quota-code L-DB2E81BA \
     --query "Quota.{name:QuotaName,value:Value}"
   ```

2. Confirm `g5.2xlarge` is offered in the Sydney AZs the VPC uses:

   ```sh
   aws ec2 describe-instance-type-offerings --region ap-southeast-2 \
     --location-type availability-zone --filters Name=instance-type,Values=g5.2xlarge \
     --query "InstanceTypeOfferings[].Location"
   ```

   If no AZ lists it, stop and tell the 3D team: the residency rule (M-16)
   means we cannot move the GPU work to another region.

3. Request the increase (32 in prod, 16 in dev and staging):

   ```sh
   aws service-quotas request-service-quota-increase --region ap-southeast-2 \
     --service-code ec2 --quota-code L-DB2E81BA --desired-value 32
   ```

4. Track it:

   ```sh
   aws service-quotas list-requested-service-quota-change-history-by-quota --region ap-southeast-2 \
     --service-code ec2 --quota-code L-DB2E81BA \
     --query "RequestedQuotas[].{status:Status,value:DesiredValue,case:CaseId}"
   ```

   If AWS opens a support case asking for the use case, answer: "Batch 3D
   reconstruction of gym floor scans, queue-driven, up to N concurrent
   g5.2xlarge instances in ap-southeast-2; customer data must remain in
   Australia."

5. If the GPU worker runs on Spot, also request "All G and VT Spot Instance
   Requests" (`L-3819A6DF`) the same way.

## 2. SES production access

New SES accounts are in the **sandbox**: they can only send to verified
addresses and at most 200 messages a day. Do this after the `Mail` stack is
deployed and the domain identity shows as verified:

```sh
aws sesv2 get-email-identity --region ap-southeast-2 --email-identity api.gym.goalcert.example \
  --query "{verified:VerifiedForSendingStatus,dkim:DkimAttributes.Status,mailFrom:MailFromAttributes.MailFromDomainStatus}"
```

1. Request production access:

   ```sh
   aws sesv2 put-account-details --region ap-southeast-2 \
     --production-access-enabled \
     --mail-type TRANSACTIONAL \
     --website-url https://gym.goalcert.example \
     --contact-language EN \
     --use-case-description "Transactional mail for the Flex Gym Scan app used by GoalCert gym operators: sign-in and account notices, plan-ready notifications and share links. Recipients are registered users of their own organisation. No marketing mail. Bounces and complaints are published to SNS through a configuration set and the SES account suppression list is enabled; hard bounces and complaints stop further sends to that address." \
     --additional-contact-email-addresses ops@example.com
   ```

   (The same form is under SES console > Account dashboard > Request
   production access.)

2. Check the status:

   ```sh
   aws sesv2 get-account --region ap-southeast-2 \
     --query "{prod:ProductionAccessEnabled,review:Details.ReviewDetails.Status,quota:SendQuota}"
   ```

3. If AWS asks questions, answer in the support case. Typical questions: how
   addresses are collected (users sign up or are invited by their
   organisation), how bounces are handled (`ses-bounces.md`), expected volume
   (low hundreds a day).

4. Once granted, the default quota (50,000 a day, 14 a second) is plenty.

Until production access is granted in staging, verify each tester's address:

```sh
aws sesv2 create-email-identity --region ap-southeast-2 --email-identity tester@example.com
```

## Other quotas worth a glance

```sh
# Fargate On-Demand vCPUs (L-3032A538)
aws service-quotas get-service-quota --region ap-southeast-2 --service-code fargate --quota-code L-3032A538
```

Defaults are far above what this system needs at launch.
