# SES bounces and complaints

Mail is sent from `no-reply@<mailDomain>` through SES in ap-southeast-2 with
configuration set `flexgym-<env>-mail`. That configuration set:

- publishes **bounce, complaint, reject and delivery-delay** events to the
  SNS topic `flexgym-<env>-mail-events` (KMS-encrypted; recipients'
  addresses are in the messages);
- keeps SES's **account-level suppression list** on for bounces and
  complaints, so SES stops sending to an address that hard-bounced or
  complained, without any code on our side.

## Why it matters

SES watches the account's bounce rate (keep it under 5%) and complaint rate
(keep it under 0.1%). Past those it puts the account under review, and can
pause sending, which stops password-reset and share mails for everyone.

```sh
aws cloudwatch get-metric-statistics --region ap-southeast-2 --namespace AWS/SES \
  --metric-name Reputation.BounceRate --statistics Maximum --period 3600 \
  --start-time $(date -u -d '-7 days' +%FT%TZ) --end-time $(date -u +%FT%TZ)
aws sesv2 get-account --region ap-southeast-2 --query "{status:EnforcementStatus,prod:ProductionAccessEnabled,sending:SendingEnabled}"
```

(Use `Reputation.ComplaintRate` for complaints.)

## Look at recent events

Subscribe yourself to the topic (an email subscription is created when
`alarmEmail` is set in `cdk.json`), or attach a temporary SQS queue:

```sh
aws sns subscribe --region ap-southeast-2 \
  --topic-arn arn:aws:sns:ap-southeast-2:<account>:flexgym-prod-mail-events \
  --protocol email --notification-endpoint you@example.com
```

Each message has `eventType` (`Bounce`, `Complaint`, ...), and for bounces
`bounce.bounceType`:

| bounceType | Meaning | Action |
|------------|---------|--------|
| `Permanent` | Address does not exist or blocks us | Already on the suppression list. Fix the user's address in the app. |
| `Transient` | Mailbox full, server busy | Nothing; SES retried. Repeated transients for one address: treat as permanent. |
| `Undetermined` | Unknown | Watch; act if it repeats. |

A **complaint** means the recipient marked our mail as spam. Check what we
sent them; product mail must stay transactional (sign-in, share links, plan
ready).

## Suppression list

```sh
# Is an address suppressed?
aws sesv2 get-suppressed-destination --region ap-southeast-2 --email-address user@example.com

# Recent entries
aws sesv2 list-suppressed-destinations --region ap-southeast-2 --reasons BOUNCE COMPLAINT \
  --start-date $(date -u -d '-7 days' +%FT%TZ)

# Remove one, only after the user confirmed the address now works
aws sesv2 delete-suppressed-destination --region ap-southeast-2 --email-address user@example.com
```

Never remove a complaint entry without the person asking for mail again.

## When the bounce rate climbs

1. List recent bounces (above) and look for a pattern: one customer
   organisation, one domain, a bulk import with bad addresses.
2. If it is a bad import, fix or remove those users' addresses before the next
   send.
3. If SES has put the account **under review**, reply to the case in the
   AWS Support Center with what happened and what was changed.
4. In an emergency, pause sending for the configuration set (mail jobs will
   fail and land in the jobs DLQ, which alerts):

   ```sh
   aws sesv2 put-configuration-set-sending-options --region ap-southeast-2 \
     --configuration-set-name flexgym-prod-mail --no-sending-enabled
   ```

   Re-enable with `--sending-enabled`.

## Sandbox

A new SES account is in the sandbox and only delivers to verified addresses.
Production access is a manual request: see `service-quotas.md`.
