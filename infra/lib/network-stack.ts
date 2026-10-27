/**
 * Network (M-02): one VPC per environment with three subnet tiers.
 *
 *   public            ALB and NAT gateways only.
 *   private (egress)  ECS tasks. Outbound internet through NAT for the Hub
 *                     (OIDC), SES API and anything without a VPC endpoint.
 *   isolated          RDS. No route to the internet at all.
 *
 * VPC endpoints keep AWS API traffic (S3, SQS, ECR pulls, logs, secrets, KMS)
 * on the AWS network and off the NAT bill.
 */
import { Stack, StackProps, Validations } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { EnvConfig, resourcePrefix } from './config';

export interface NetworkStackProps extends StackProps {
  config: EnvConfig;
}

/** Sydney's three AZs, fixed so synth never needs an AWS lookup. */
const AVAILABILITY_ZONES = ['ap-southeast-2a', 'ap-southeast-2b', 'ap-southeast-2c'];

export class NetworkStack extends Stack {
  readonly vpc: ec2.Vpc;

  override get availabilityZones(): string[] {
    return AVAILABILITY_ZONES;
  }

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const { config } = props;

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: resourcePrefix(config),
      ipAddresses: ec2.IpAddresses.cidr('10.40.0.0/16'),
      maxAzs: 3,
      natGateways: config.natGateways,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 20 },
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      flowLogs: {
        rejected: {
          destination: ec2.FlowLogDestination.toCloudWatchLogs(
            new logs.LogGroup(this, 'FlowLogs', { retention: config.logRetentionDays as logs.RetentionDays }),
          ),
          trafficType: ec2.FlowLogTrafficType.REJECT,
        },
      },
    });

    // The fixed AZ list above is deliberate (no lookups, stable subnets).
    Validations.of(this.vpc).acknowledge({ id: 'CloudFormation-Validate::W3010', reason: 'AZs are pinned on purpose' });

    // Gateway endpoint: free, and carries the bulk of the traffic (scan uploads
    // are presigned and go straight from the phone, but the worker reads them).
    this.vpc.addGatewayEndpoint('S3', { service: ec2.GatewayVpcEndpointAwsService.S3 });

    // Interface endpoints, placed in the private subnets the tasks run in.
    // SES's API (sesv2 SendEmail) has no interface endpoint, only SMTP does
    // (email-smtp), and the backend uses the API, so mail goes out via NAT.
    const interfaceEndpoints: Record<string, ec2.InterfaceVpcEndpointAwsService> = {
      Sqs: ec2.InterfaceVpcEndpointAwsService.SQS,
      SecretsManager: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      EcrApi: ec2.InterfaceVpcEndpointAwsService.ECR,
      EcrDocker: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      Logs: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      Monitoring: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_MONITORING,
      Kms: ec2.InterfaceVpcEndpointAwsService.KMS,
    };
    for (const [name, service] of Object.entries(interfaceEndpoints)) {
      this.vpc.addInterfaceEndpoint(name, {
        service,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        privateDnsEnabled: true,
      });
    }
  }
}
