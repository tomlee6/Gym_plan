/**
 * The web app's certificate (M-06, M-08). CloudFront only accepts ACM
 * certificates from us-east-1, so this is the one stack outside Sydney. It
 * holds a public certificate and nothing else: no customer data (M-16).
 *
 * Validation:
 *  - webDnsManagedByGoalCert = true: ACM waits for the GoalCert team to add
 *    the validation CNAME, and the deploy pauses until they do. Stack outputs
 *    only appear after that, so the record is read from the CloudFormation
 *    events or ACM directly; see docs/runbooks/deploy.md.
 *  - false: we write the validation record into our own zone.
 */
import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { EDGE_CERT_REGION, EnvConfig } from './config';

export interface EdgeCertStackProps extends StackProps {
  config: EnvConfig;
  /** Our zone; used only when the web domain is not in GoalCert's DNS. */
  zone: route53.IHostedZone;
}

export class EdgeCertStack extends Stack {
  readonly webCertificate: acm.ICertificate;

  constructor(scope: Construct, id: string, props: EdgeCertStackProps) {
    super(scope, id, props);
    const { config } = props;
    if (this.region !== EDGE_CERT_REGION) {
      throw new Error(`EdgeCertStack must be deployed to ${EDGE_CERT_REGION}`);
    }

    this.webCertificate = new acm.Certificate(this, 'WebCertificate', {
      domainName: config.webDomain,
      validation: config.webDnsManagedByGoalCert
        ? acm.CertificateValidation.fromDns()
        : acm.CertificateValidation.fromDns(props.zone),
    });

    new CfnOutput(this, 'WebCertificateArn', { value: this.webCertificate.certificateArn });
  }
}
