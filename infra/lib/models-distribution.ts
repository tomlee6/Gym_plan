/**
 * Models distribution (M-07). OWNED BY THE 3D TEAM: this is a hook point
 * left by the platform work so the 3D team can take it from here.
 *
 * A CloudFront distribution in front of the models bucket. Every request must
 * carry a CloudFront signed URL (or signed cookie) made with the private half
 * of the key pair whose public half is passed in. The bucket stays private:
 * CloudFront reads it through Origin Access Control.
 *
 * Edge caching is global, but the origin (the bucket) stays in Sydney; see
 * docs/residency.md.
 */
import { CfnOutput, Duration } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface ModelsDistributionProps {
  bucket: s3.IBucket;
  /** PEM-encoded RSA public key used to verify signed URLs. */
  publicKeyPem: string;
  /** Origin allowed to fetch models from the browser (the web app). */
  allowedOrigin: string;
}

export class ModelsDistribution extends Construct {
  readonly distribution: cloudfront.Distribution;
  readonly publicKey: cloudfront.PublicKey;

  constructor(scope: Construct, id: string, props: ModelsDistributionProps) {
    super(scope, id);

    this.publicKey = new cloudfront.PublicKey(this, 'SigningKey', {
      encodedKey: props.publicKeyPem,
      comment: 'Verifies signed model URLs issued by the backend',
    });
    const keyGroup = new cloudfront.KeyGroup(this, 'KeyGroup', { items: [this.publicKey] });

    const corsPolicy = new cloudfront.ResponseHeadersPolicy(this, 'Cors', {
      corsBehavior: {
        accessControlAllowOrigins: [props.allowedOrigin],
        accessControlAllowMethods: ['GET', 'HEAD'],
        accessControlAllowHeaders: ['*'],
        accessControlAllowCredentials: false,
        accessControlMaxAge: Duration.hours(1),
        originOverride: true,
      },
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Flex Gym Scan 3D models (signed URLs only)',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(props.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: corsPolicy,
        trustedKeyGroups: [keyGroup],
      },
    });

    new CfnOutput(this, 'ModelsDomainName', { value: this.distribution.distributionDomainName });
    new CfnOutput(this, 'ModelsSigningKeyId', {
      description: 'Key pair id the backend puts in signed model URLs',
      value: this.publicKey.publicKeyId,
    });
  }
}
