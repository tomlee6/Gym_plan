/**
 * Web app hosting (M-06): the Vite SPA in a private S3 bucket behind
 * CloudFront (Origin Access Control), on the GoalCert subdomain.
 *
 *  - Unknown paths return /index.html with 200 so client-side routes work on
 *    reload (S3 answers 403 for a missing key behind OAC, so both 403 and 404
 *    are mapped).
 *  - Security headers on every response: CSP (webCsp in cdk.json, or the
 *    default below), HSTS, X-Frame-Options DENY, nosniff, referrer policy.
 *  - The certificate comes from EdgeCertStack in us-east-1.
 *  - DNS (M-08): if the web domain lives in GoalCert's DNS
 *    (webDnsManagedByGoalCert), the CNAME their team must add is an output;
 *    otherwise we create an alias record in our zone.
 *  - Uploading web/dist is optional: pass -c deployWebAssets=true after
 *    `npm run build` in web/. The pipeline does this for staging and prod.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { EnvConfig } from './config';

/** Where `npm run build` in web/ writes the SPA. */
export const WEB_DIST = path.resolve(__dirname, '..', '..', 'web', 'dist');

export interface WebStackProps extends StackProps {
  config: EnvConfig;
  zone: route53.IHostedZone;
  certificate: acm.ICertificate;
  /** Upload web/dist to the bucket (context flag deployWebAssets). */
  deployAssets: boolean;
}

/**
 * Default CSP: the app's own files, the API, presigned S3 URLs for drawings
 * and scans, and CloudFront for 3D models. blob: is for pdf.js and three.js
 * workers and object URLs; 'wasm-unsafe-eval' lets the viewer compile the
 * meshopt decoder for compressed models. Replace via webCsp once the app's
 * needs settle.
 */
function defaultCsp(config: EnvConfig): string {
  return [
    "default-src 'self'",
    // WebAssembly only (not eval): three.js's meshopt decoder for the 3D models (K-01).
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.amazonaws.com https://*.cloudfront.net",
    `connect-src 'self' https://${config.apiDomain} https://*.amazonaws.com https://*.cloudfront.net`,
    "worker-src 'self' blob:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export class WebStack extends Stack {
  readonly bucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);
    const { config, zone, certificate } = props;

    // Public static assets only, so SSE-S3 is enough (and keeps OAC simple).
    this.bucket = new s3.Bucket(this, 'SiteBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      // Rebuilt from source on every deploy; nothing to keep.
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const headers = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      comment: 'Flex Gym Scan web app security headers',
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: config.webCsp || defaultCsp(config), override: true },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(730),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        contentTypeOptions: { override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        xssProtection: { protection: true, modeBlock: true, override: true },
      },
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `Flex Gym Scan web app (${config.name})`,
      domainNames: [config.webDomain],
      certificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
        compress: true,
      },
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 200,
        responsePagePath: '/index.html',
        ttl: Duration.seconds(0),
      })),
    });

    if (props.deployAssets) {
      // -c webDistPath=... points at a build elsewhere (default web/dist).
      const dist = path.resolve((this.node.tryGetContext('webDistPath') as string | undefined) ?? WEB_DIST);
      if (!fs.existsSync(path.join(dist, 'index.html'))) {
        throw new Error(`deployWebAssets is on but ${path.join(dist, 'index.html')} is missing. Run npm run build in web/.`);
      }
      new s3deploy.BucketDeployment(this, 'DeploySite', {
        sources: [s3deploy.Source.asset(dist)],
        destinationBucket: this.bucket,
        distribution: this.distribution,
        distributionPaths: ['/*'],
        prune: true,
        memoryLimit: 512,
      });
    }

    if (config.webDnsManagedByGoalCert) {
      // N-04: GoalCert's DNS holds the web subdomain. Hand them this record.
      new CfnOutput(this, 'GoalCertDnsRecord', {
        description: 'GoalCert DNS: add this CNAME for the web app',
        value: `${config.webDomain} CNAME ${this.distribution.distributionDomainName}`,
      });
    } else {
      for (const [id, Record] of [
        ['WebAlias', route53.ARecord],
        ['WebAliasV6', route53.AaaaRecord],
      ] as const) {
        new Record(this, id, {
          zone,
          recordName: config.webDomain,
          target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution)),
        });
      }
    }

    new CfnOutput(this, 'WebUrl', { value: `https://${config.webDomain}` });
    new CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
    new CfnOutput(this, 'DistributionDomainName', { value: this.distribution.distributionDomainName });
    new CfnOutput(this, 'SiteBucketName', { value: this.bucket.bucketName });
  }
}
