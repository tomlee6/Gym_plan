/**
 * Amazon Cognito in Sydney as the sign-in provider (HUB_DRIVER=cognito).
 *
 * Cognito's managed sign-in page is a standard OpenID Connect provider, so
 * the code exchange and key checks are the same as for any Hub (OidcHub).
 * Cognito holds the passwords, "forgot password" and MFA; everything else
 * about a person stays in this service's own database.
 *
 * The pool is invite-only (no self sign-up), so an invite also creates the
 * person in the pool, and Cognito emails them a temporary password.
 */
import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';

import { OidcHub } from './oidc.js';

export class CognitoHub extends OidcHub {
  constructor(settings, { client, ...deps } = {}) {
    super(settings, deps);
    this.userPoolId = settings.cognito.userPoolId;
    this.client = client ?? new CognitoIdentityProviderClient({ region: settings.cognito.region });
  }

  /**
   * Makes sure `email` can sign in. New people get Cognito's invitation
   * email with a temporary password; someone invited before who never
   * finished signing up gets it again; anyone else already has a password.
   */
  async invite({ email }) {
    const user = {
      UserPoolId: this.userPoolId,
      Username: email,
      UserAttributes: [
        { Name: 'email', Value: email },
        // The invitation reaches this address, which is what verifies it.
        { Name: 'email_verified', Value: 'true' },
      ],
      DesiredDeliveryMediums: ['EMAIL'],
    };
    try {
      await this.client.send(new AdminCreateUserCommand(user));
    } catch (err) {
      if (!(err instanceof UsernameExistsException)) throw err;
      const existing = await this.client.send(
        new AdminGetUserCommand({ UserPoolId: this.userPoolId, Username: email }),
      );
      if (existing.UserStatus === 'FORCE_CHANGE_PASSWORD') {
        await this.client.send(new AdminCreateUserCommand({ ...user, MessageAction: 'RESEND' }));
      }
    }
  }
}
