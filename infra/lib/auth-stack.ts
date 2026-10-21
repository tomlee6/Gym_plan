/**
 * Sign-in (B-01): an Amazon Cognito user pool in Sydney and its managed
 * sign-in page.
 *
 * Cognito holds only what signing in needs: email, password and MFA.
 * Everything else about a person (name, gym accounts, roles, invites,
 * sessions) stays in the RDS database, matched on the Cognito `sub`.
 *
 * The pool is invite-only: the backend creates a person when an admin
 * invites them, and Cognito emails a temporary password that is changed at
 * the first sign-in. "Forgot password" and MFA are Cognito's own pages.
 */
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { EnvConfig, HOME_REGION, resourcePrefix } from './config';
import { MailStack } from './mail-stack';

export interface AuthStackProps extends StackProps {
  config: EnvConfig;
  mail: MailStack;
}

export class AuthStack extends Stack {
  readonly userPool: cognito.UserPool;
  readonly client: cognito.UserPoolClient;
  /** https://<prefix>.auth.ap-southeast-2.amazoncognito.com */
  readonly domainUrl: string;
  /** The app client's secret, which only the backend holds. */
  readonly clientSecret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);
    const { config, mail } = props;
    const prefix = resourcePrefix(config);

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: prefix,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
        fullname: { required: false, mutable: true },
      },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
        // As long as an invite lasts (INVITE_TTL_DAYS).
        tempPasswordValidity: Duration.days(14),
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // Invitations and password resets go out through our own SES identity
      // in Sydney, not Cognito's capped default sender.
      email: cognito.UserPoolEmail.withSES({
        fromEmail: mail.fromAddress,
        fromName: 'Flex Gym Scan',
        sesRegion: HOME_REGION,
        sesVerifiedDomain: config.mailDomain,
        configurationSetName: mail.configurationSet.configurationSetName,
      }),
      userInvitation: {
        emailSubject: 'Your Flex Gym Scan sign-in',
        emailBody:
          'You have been invited to Flex Gym Scan.<br><br>' +
          'Sign in with this email address, {username}, and the temporary password {####}<br>' +
          `at https://${config.webDomain}/login or in the Flex Gym Scan iPhone app.<br><br>` +
          'You will choose your own password the first time you sign in.',
      },
      deletionProtection: config.name === 'prod',
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const domain = this.userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: prefix },
    });
    this.domainUrl = domain.baseUrl();

    this.client = this.userPool.addClient('AppClient', {
      userPoolClientName: `${prefix}-backend`,
      // The backend swaps the code with this secret; the web app and the
      // iPhone app only ever see the one-time code.
      generateSecret: true,
      authFlows: {},
      preventUserExistenceErrors: true,
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [config.hub.webRedirectUri, config.hub.iosRedirectUri],
        logoutUrls: [`https://${config.webDomain}/login`],
      },
      // Only the ID token is used, once, at sign-in; Flex issues its own tokens.
      idTokenValidity: Duration.minutes(10),
      accessTokenValidity: Duration.minutes(10),
      refreshTokenValidity: Duration.hours(1),
      enableTokenRevocation: true,
    });

    this.clientSecret = new secretsmanager.Secret(this, 'ClientSecret', {
      secretName: `${prefix}/COGNITO_CLIENT_SECRET`,
      description: 'Cognito app client secret, copied from the user pool client.',
      secretStringValue: this.client.userPoolClientSecret,
    });

    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: this.client.userPoolClientId });
    new CfnOutput(this, 'SignInDomain', { value: this.domainUrl });
  }
}
