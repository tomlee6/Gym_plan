/**
 * Email sending (M-09) with SES in ap-southeast-2.
 *
 *  - Domain identity with Easy DKIM (2048-bit keys).
 *  - Custom MAIL FROM domain bounce.<mailDomain>, so SPF aligns with our
 *    domain instead of amazonses.com. Its SPF record is
 *    "v=spf1 include:amazonses.com ~all".
 *  - DMARC at _dmarc.<mailDomain> with p=quarantine.
 *  - A configuration set that sends bounce and complaint events to an SNS
 *    topic, and keeps SES's account suppression list in use for both.
 *
 * Because the mail domain sits in our own Route 53 zone, CDK writes the DKIM,
 * MAIL FROM (MX + SPF) and DMARC records itself.
 *
 * A new SES account is in the sandbox (it can only send to verified
 * addresses). Production access is a manual request; see
 * docs/runbooks/service-quotas.md (M-15).
 */
import { CfnOutput, Duration, Stack, StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { EnvConfig, resourcePrefix } from './config';

export interface MailStackProps extends StackProps {
  config: EnvConfig;
  zone: route53.IPublicHostedZone;
}

export class MailStack extends Stack {
  readonly identity: ses.EmailIdentity;
  readonly configurationSet: ses.ConfigurationSet;
  readonly eventsTopic: sns.Topic;
  /** Address the backend sends from (MAIL_FROM). */
  readonly fromAddress: string;

  constructor(scope: Construct, id: string, props: MailStackProps) {
    super(scope, id, props);
    const { config, zone } = props;
    const prefix = resourcePrefix(config);
    const mailFromDomain = `bounce.${config.mailDomain}`;
    this.fromAddress = `${config.mailFromLocalPart}@${config.mailDomain}`;

    // Bounce and complaint events carry recipient addresses, so the topic is
    // encrypted. SES needs to use the key to publish.
    const eventsKey = new kms.Key(this, 'EventsKey', {
      alias: `alias/${prefix}-mail-events`,
      enableKeyRotation: true,
      description: 'Encrypts SES bounce and complaint notifications',
    });
    eventsKey.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
        actions: ['kms:GenerateDataKey*', 'kms:Decrypt'],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    );
    this.eventsTopic = new sns.Topic(this, 'MailEvents', {
      topicName: `${prefix}-mail-events`,
      displayName: 'Flex Gym Scan SES bounces and complaints',
      masterKey: eventsKey,
      enforceSSL: true,
    });
    if (config.alarmEmail) {
      this.eventsTopic.addSubscription(new subscriptions.EmailSubscription(config.alarmEmail));
    }

    this.configurationSet = new ses.ConfigurationSet(this, 'ConfigurationSet', {
      configurationSetName: `${prefix}-mail`,
      reputationMetrics: true,
      sendingEnabled: true,
      tlsPolicy: ses.ConfigurationSetTlsPolicy.REQUIRE,
      suppressionReasons: ses.SuppressionReasons.BOUNCES_AND_COMPLAINTS,
    });
    this.configurationSet.addEventDestination('BouncesAndComplaints', {
      destination: ses.EventDestination.snsTopic(this.eventsTopic),
      events: [
        ses.EmailSendingEvent.BOUNCE,
        ses.EmailSendingEvent.COMPLAINT,
        ses.EmailSendingEvent.REJECT,
        ses.EmailSendingEvent.DELIVERY_DELAY,
      ],
    });

    // Identity.publicHostedZone makes CDK write the three DKIM CNAMEs and the
    // MAIL FROM MX + SPF records into our zone.
    this.identity = new ses.EmailIdentity(this, 'Identity', {
      identity:
        config.mailDomain === config.hostedZoneName
          ? ses.Identity.publicHostedZone(zone)
          : ses.Identity.domain(config.mailDomain),
      dkimSigning: true,
      dkimIdentity: ses.DkimIdentity.easyDkim(ses.EasyDkimSigningKeyLength.RSA_2048_BIT),
      mailFromDomain,
      mailFromBehaviorOnMxFailure: ses.MailFromBehaviorOnMxFailure.USE_DEFAULT_VALUE,
      configurationSet: this.configurationSet,
      feedbackForwarding: false,
    });

    // When the mail domain is a subdomain of the zone (not its apex), the
    // identity above is a plain domain identity, so write its records here.
    if (config.mailDomain !== config.hostedZoneName) {
      this.identity.dkimRecords.forEach((record, i) => {
        new route53.CnameRecord(this, `Dkim${i}`, {
          zone,
          recordName: record.name,
          domainName: record.value,
          ttl: Duration.hours(1),
        });
      });
      new route53.MxRecord(this, 'MailFromMx', {
        zone,
        recordName: mailFromDomain,
        values: [{ priority: 10, hostName: `feedback-smtp.${this.region}.amazonses.com` }],
      });
      new route53.TxtRecord(this, 'MailFromSpf', {
        zone,
        recordName: mailFromDomain,
        values: ['v=spf1 include:amazonses.com ~all'],
      });
    }

    // DMARC. Start at quarantine; reports go to the rua address once the team
    // has a mailbox for them (add "rua=mailto:...").
    new route53.TxtRecord(this, 'Dmarc', {
      zone,
      recordName: `_dmarc.${config.mailDomain}`,
      values: ['v=DMARC1; p=quarantine; adkim=r; aspf=r; pct=100'],
      ttl: Duration.hours(1),
    });

    new CfnOutput(this, 'MailFrom', { value: this.fromAddress });
    new CfnOutput(this, 'ConfigurationSetName', { value: this.configurationSet.configurationSetName });
    new CfnOutput(this, 'MailEventsTopicArn', { value: this.eventsTopic.topicArn });
    new CfnOutput(this, 'SpfRecord', {
      description: 'TXT record on the MAIL FROM domain (created in our zone)',
      value: `${mailFromDomain} TXT "v=spf1 include:amazonses.com ~all"`,
    });
    new CfnOutput(this, 'DmarcRecord', {
      description: 'TXT record for DMARC (created in our zone)',
      value: `_dmarc.${config.mailDomain} TXT "v=DMARC1; p=quarantine; adkim=r; aspf=r; pct=100"`,
    });
  }
}
