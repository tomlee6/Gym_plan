/**
 * Builds the whole CDK app: the dev stage and the pipeline (which holds the
 * staging and prod stages). Shared by bin/app.ts and the tests.
 */
import { App } from 'aws-cdk-lib';
import { contextFlag, loadEnvConfig, loadPipelineConfig } from './config';
import { PipelineStack } from './pipeline-stack';
import { FlexGymStage } from './stage';

export function buildApp(app: App): App {
  // Off by default so synth works without web/dist. The pipeline builds
  // web/dist and synthesizes with -c deployWebAssets=true.
  const deployWebAssets = contextFlag(app.node, 'deployWebAssets');

  new FlexGymStage(app, 'FlexGym-Dev', { config: loadEnvConfig(app.node, 'dev'), deployWebAssets });

  const pipeline = loadPipelineConfig(app.node);
  new PipelineStack(app, 'FlexGym-Pipeline', {
    env: { account: pipeline.account, region: pipeline.region },
    description: 'Flex Gym Scan release pipeline (staging and prod)',
    pipeline,
    staging: loadEnvConfig(app.node, 'staging'),
    prod: loadEnvConfig(app.node, 'prod'),
    deployWebAssets,
  });
  return app;
}
