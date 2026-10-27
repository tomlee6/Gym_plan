/** Invites through Amazon Cognito (HUB_DRIVER=cognito), against a stand-in Cognito client. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UsernameExistsException } from '@aws-sdk/client-cognito-identity-provider';

import { CognitoHub } from '../src/hub/cognito.js';

/** Records each command; `status` is what AdminGetUser reports for someone already in the pool. */
function fakeCognito({ exists = false, status = 'CONFIRMED' } = {}) {
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === 'AdminGetUserCommand') return { UserStatus: status };
      if (exists && !command.input.MessageAction) {
        throw new UsernameExistsException({ message: 'exists', $metadata: {} });
      }
      return {};
    },
  };
}

const hubWith = (client) =>
  new CognitoHub({ cognito: { userPoolId: 'ap-southeast-2_test', region: 'ap-southeast-2' } }, { client });

describe('Cognito invites', () => {
  it('creates a new person with a verified email, and Cognito emails the temporary password', async () => {
    const client = fakeCognito();
    await hubWith(client).invite({ email: 'new@gym.example' });
    assert.equal(client.calls.length, 1);
    const { name, input } = client.calls[0];
    assert.equal(name, 'AdminCreateUserCommand');
    assert.equal(input.UserPoolId, 'ap-southeast-2_test');
    assert.equal(input.Username, 'new@gym.example');
    assert.deepEqual(input.DesiredDeliveryMediums, ['EMAIL']);
    assert.ok(input.UserAttributes.some((a) => a.Name === 'email_verified' && a.Value === 'true'));
    assert.equal(input.MessageAction, undefined);
  });

  it('resends the invitation to someone who never finished signing up', async () => {
    const client = fakeCognito({ exists: true, status: 'FORCE_CHANGE_PASSWORD' });
    await hubWith(client).invite({ email: 'pending@gym.example' });
    assert.deepEqual(
      client.calls.map((c) => c.name),
      ['AdminCreateUserCommand', 'AdminGetUserCommand', 'AdminCreateUserCommand'],
    );
    assert.equal(client.calls[2].input.MessageAction, 'RESEND');
  });

  it('leaves someone who already has a password alone', async () => {
    const client = fakeCognito({ exists: true, status: 'CONFIRMED' });
    await hubWith(client).invite({ email: 'member@gym.example' });
    assert.deepEqual(
      client.calls.map((c) => c.name),
      ['AdminCreateUserCommand', 'AdminGetUserCommand'],
    );
  });

  it('passes any other failure on, so the invite is rolled back', async () => {
    const client = { send: async () => { throw new Error('AccessDenied'); } };
    await assert.rejects(hubWith(client).invite({ email: 'x@gym.example' }), /AccessDenied/);
  });
});
