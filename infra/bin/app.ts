#!/usr/bin/env node
/**
 * CDK app entry point.
 *
 *   FlexGym-Dev        the dev environment, deployed by hand:
 *                        npx cdk deploy "FlexGym-Dev/*"
 *   FlexGym-Pipeline   the release pipeline, which deploys staging and prod
 *                        (their stacks appear as FlexGym-Pipeline/FlexGym-Staging/...).
 *
 * Settings come from cdk.json context; see lib/config.ts and README.md.
 */
import { App } from 'aws-cdk-lib';
import { buildApp } from '../lib/app';

buildApp(new App()).synth();
