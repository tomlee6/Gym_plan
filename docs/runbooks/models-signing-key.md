# Models signing key (M-07)

The 3D models (generated levels, and later machine models) sit in the private models bucket in Sydney. Browsers fetch them only through the models CloudFront distribution, and only with a signed URL the API issues for one file at a time. CloudFront checks each URL against the public half of a key pair; the API signs with the private half.

- Public half: cdk.json context, `environments.<env>.modelsSigningPublicKeyPem`. While it is empty, there is no models distribution, the 3D generator stays off (`GENERATOR_DRIVER` is not set) and the viewer builds levels in the browser as before.
- Private half: the Secrets Manager secret `<prefix>/MODELS_SIGNING_PRIVATE_KEY`, read by the API and worker as `MODELS_SIGNING_PRIVATE_KEY`.
- Key id: set by CDK from the distribution's public key (`MODELS_SIGNING_KEY_ID`). Nothing to copy by hand.

Each environment has its own key pair. Never reuse one across environments, and never commit a private key.

## Turning models on for an environment

1. Make a key pair on a trusted machine (2048-bit RSA, which CloudFront requires):

   ```sh
   openssl genrsa -out models-signing-<env>.pem 2048
   openssl rsa -pubout -in models-signing-<env>.pem -out models-signing-<env>.pub.pem
   ```

2. Put the public key in cdk.json for that environment, as one string with `\n` for line breaks:

   ```sh
   awk 'NF {printf "%s\\n", $0}' models-signing-<env>.pub.pem
   ```

3. Deploy (merge to `main`; see deploy.md). This creates the distribution, its key group, the `MODELS_SIGNING_PRIVATE_KEY` secret with a random placeholder value, and turns the generator on (`GENERATOR_DRIVER=glb`).

   Until step 4, the API cannot sign model links: it logs `Could not sign a model link` and returns no link, and the viewer keeps building levels in the browser. Nothing breaks for users.

4. Set the secret to the private key, then restart the services so they read it:

   ```sh
   aws secretsmanager put-secret-value --region ap-southeast-2 \
     --secret-id <prefix>/MODELS_SIGNING_PRIVATE_KEY \
     --secret-string file://models-signing-<env>.pem
   aws ecs update-service --region ap-southeast-2 --cluster <prefix> --service <prefix>-api --force-new-deployment
   aws ecs update-service --region ap-southeast-2 --cluster <prefix> --service <prefix>-worker --force-new-deployment
   ```

5. Check: open an approved walkthrough. `GET /v1/plans/<planId>/model` returns `generatedModel.url` on the `cloudfront.net` domain once that plan's level has been generated, and the URL downloads the GLB. Re-approve (or regenerate) existing plans to build their levels.

6. Delete the local private key file once the secret is set.

## Rotating the key

CloudFront accepts a URL signed by any key in the distribution's key group. Signed URLs live for an hour (up to 15 minutes more), so a rotation needs only a short overlap:

1. Make a new key pair (step 1 above).
2. Put the new public key in cdk.json in place of the old and deploy. CDK replaces the public key, so the key id the API uses changes in the same deploy.
3. Straight after the deploy, set the secret to the new private key and restart the services (step 4 above). In between, new model links cannot be signed and the viewer falls back to building in the browser; links issued before still work until they expire.

## If the private key leaks

Rotate at once (above). Anyone holding the old key could sign links to any model until its public half leaves the key group, which happens when the deploy in step 2 finishes.
