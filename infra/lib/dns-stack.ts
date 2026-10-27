/**
 * DNS (M-08): the Route 53 zone we manage for the API and mail domains.
 *
 * GoalCert delegates this zone to us with NS records in their DNS (N-04). The
 * web app's subdomain normally stays in GoalCert's DNS; see web-stack.ts.
 *
 * Set `hostedZoneId` in cdk.json to adopt a zone that already exists instead
 * of creating one (no AWS lookup at synth time either way).
 */
import { CfnOutput, Fn, Stack, StackProps } from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { EnvConfig } from './config';

export interface DnsStackProps extends StackProps {
  config: EnvConfig;
}

export class DnsStack extends Stack {
  readonly zone: route53.IPublicHostedZone;

  constructor(scope: Construct, id: string, props: DnsStackProps) {
    super(scope, id, props);
    const { config } = props;

    if (config.hostedZoneId) {
      this.zone = route53.PublicHostedZone.fromPublicHostedZoneAttributes(this, 'Zone', {
        hostedZoneId: config.hostedZoneId,
        zoneName: config.hostedZoneName,
      });
    } else {
      const zone = new route53.PublicHostedZone(this, 'Zone', {
        zoneName: config.hostedZoneName,
        comment: `Flex Gym Scan ${config.name}: API and mail. Delegated from GoalCert DNS.`,
      });
      this.zone = zone;
      // GoalCert adds these as an NS record for hostedZoneName in their zone.
      new CfnOutput(this, 'DelegationNameServers', {
        description: `GoalCert DNS: add NS record ${config.hostedZoneName} with these values`,
        value: Fn.join(', ', zone.hostedZoneNameServers!),
      });
    }

    new CfnOutput(this, 'HostedZoneId', { value: this.zone.hostedZoneId });
  }
}
