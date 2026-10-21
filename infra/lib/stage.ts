/**
 * One complete environment (M-01). The same stage is used for dev (deployed
 * by hand with `cdk deploy`) and for staging and prod (deployed by the
 * pipeline). Differences between environments come only from EnvConfig.
 *
 * Stacks, in dependency order:
 *   Network     VPC and endpoints
 *   Dns         Route 53 zone for the API and mail domains
 *   EdgeCerts   us-east-1: the web app's CloudFront certificate
 *   Data        KMS, RDS MySQL, S3, SQS, Secrets Manager
 *   Mail        SES identity, configuration set, bounce topic
 *   Api         ECS cluster, API service + ALB + WAF, worker service
 *   Web         SPA bucket and CloudFront
 *   Monitoring  dashboard, alarms, Slack
 */
import { Stage, StageProps, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ApiStack } from './api-stack';
import { EDGE_CERT_REGION, EnvConfig } from './config';
import { DataStack } from './data-stack';
import { DnsStack } from './dns-stack';
import { EdgeCertStack } from './edge-cert-stack';
import { GpuStack } from './gpu-stack';
import { MailStack } from './mail-stack';
import { MonitoringStack } from './monitoring-stack';
import { NetworkStack } from './network-stack';
import { WebStack } from './web-stack';

export interface FlexGymStageProps extends StageProps {
  config: EnvConfig;
  /** Upload web/dist with the Web stack. */
  deployWebAssets: boolean;
}

export class FlexGymStage extends Stage {
  readonly network: NetworkStack;
  readonly dns: DnsStack;
  readonly edgeCerts: EdgeCertStack;
  readonly data: DataStack;
  /** Only when the environment names an approved TRELLIS.2 image (L-10). */
  readonly gpu?: GpuStack;
  readonly mail: MailStack;
  readonly api: ApiStack;
  readonly web: WebStack;
  readonly monitoring: MonitoringStack;

  constructor(scope: Construct, id: string, props: FlexGymStageProps) {
    super(scope, id, props);
    const { config } = props;
    const env = { account: config.account, region: config.region };
    const description = (what: string) => `Flex Gym Scan ${config.name}: ${what}`;

    this.network = new NetworkStack(this, 'Network', { env, config, description: description('network') });
    this.dns = new DnsStack(this, 'Dns', {
      env,
      config,
      description: description('DNS zone'),
      crossRegionReferences: true,
    });
    this.edgeCerts = new EdgeCertStack(this, 'EdgeCerts', {
      env: { account: config.account, region: EDGE_CERT_REGION },
      config,
      zone: this.dns.zone,
      description: description('CloudFront certificate (us-east-1, no customer data)'),
      crossRegionReferences: true,
    });
    this.data = new DataStack(this, 'Data', {
      env,
      config,
      vpc: this.network.vpc,
      description: description('database, buckets, queues, secrets'),
    });
    if (config.trellis2Image) {
      this.gpu = new GpuStack(this, 'Gpu', {
        env,
        config,
        vpc: this.network.vpc,
        data: this.data,
        description: description('GPU jobs for machine models (AWS Batch)'),
      });
    }
    this.mail = new MailStack(this, 'Mail', { env, config, zone: this.dns.zone, description: description('SES') });
    this.api = new ApiStack(this, 'Api', {
      env,
      config,
      vpc: this.network.vpc,
      zone: this.dns.zone,
      data: this.data,
      mail: this.mail,
      gpu: this.gpu,
      description: description('API and worker on ECS Fargate'),
    });
    this.web = new WebStack(this, 'Web', {
      env,
      config,
      zone: this.dns.zone,
      certificate: this.edgeCerts.webCertificate,
      deployAssets: props.deployWebAssets,
      description: description('web app hosting'),
      crossRegionReferences: true,
    });
    this.monitoring = new MonitoringStack(this, 'Monitoring', {
      env,
      config,
      data: this.data,
      api: this.api,
      description: description('dashboard and alarms'),
    });

    Tags.of(this).add('project', 'flex-gym-scan');
    Tags.of(this).add('environment', config.name);
    Tags.of(this).add('data-residency', 'ap-southeast-2');
  }
}
