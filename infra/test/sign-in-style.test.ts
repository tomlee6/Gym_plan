/**
 * Cognito's sign-in pages in the Flex Gym Scan colours (sign-in-style.ts).
 * Cognito refuses CSS outside its list of classes and properties, and a
 * refusal fails the Auth stack's deployment, so the list is held here, as
 * docs.aws.amazon.com/cognito/latest/developerguide/hosted-ui-classic-branding.html
 * gives it.
 *
 * Run: npm test
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { buildApp } from '../lib/app';
import { BRAND, SIGN_IN_CSS } from '../lib/sign-in-style';

/** Each class Cognito takes, and the properties it takes on it. */
const ALLOWED: Record<string, string[]> = {
  'background-customizable': ['background-color'],
  'banner-customizable': ['padding', 'background-color'],
  'errorMessage-customizable': ['margin', 'padding', 'font-size', 'width', 'background', 'border', 'color', 'box-sizing'],
  'idpButton-customizable': ['height', 'width', 'text-align', 'margin-bottom', 'color', 'background-color', 'border-color'],
  'idpButton-customizable:hover': ['color', 'background-color'],
  'idpDescription-customizable': ['padding-top', 'padding-bottom', 'display', 'font-size', 'color'],
  'inputField-customizable': ['width', 'height', 'color', 'background-color', 'border'],
  'inputField-customizable:focus': ['border-color', 'outline'],
  'label-customizable': ['font-weight', 'color'],
  'legalText-customizable': ['color', 'font-size'],
  'logo-customizable': ['max-width', 'max-height', 'background-color'],
  'passwordCheck-notValid-customizable': ['color'],
  'passwordCheck-valid-customizable': ['color'],
  'socialButton-customizable': ['height', 'text-align', 'width', 'margin-bottom'],
  'submitButton-customizable': ['font-size', 'font-weight', 'margin', 'width', 'height', 'color', 'background-color'],
  'submitButton-customizable:hover': ['color', 'background-color'],
  'textDescription-customizable': ['padding-top', 'padding-bottom', 'display', 'font-size', 'color'],
};

/** `.class { prop: value; ... }` lines as [class, [[prop, value]]]. */
function parse(css: string): [string, [string, string][]][] {
  return css.split('\n').map((line) => {
    const m = line.match(/^\.([\w:-]+) \{ (.*) \}$/);
    assert.ok(m, `not one rule: ${line}`);
    const props = m[2]
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => d.split(':').map((s) => s.trim()) as [string, string]);
    return [m[1], props];
  });
}

test('uses only the classes and properties Cognito takes, within its limits', () => {
  assert.ok(Buffer.byteLength(SIGN_IN_CSS) <= 3 * 1024, 'at most 3 KB');
  assert.doesNotMatch(SIGN_IN_CSS, /@(import|supports|page|media)|javascript|<|url\(/i);
  for (const [cls, props] of parse(SIGN_IN_CSS)) {
    assert.ok(ALLOWED[cls], `Cognito does not take .${cls}`);
    for (const [prop, value] of props) {
      assert.ok(ALLOWED[cls].includes(prop), `Cognito does not take ${prop} on .${cls}`);
      if (prop === 'height') assert.match(value, /^\d+px$/, `.${cls} height in px`);
      if (prop === 'width') assert.match(value, /^\d+%$/, `.${cls} width in percent`);
      if (prop === 'border') assert.match(value, /^\d+px (solid|none) #[0-9a-f]{6}$/, `.${cls} border`);
      if ((cls === 'banner-customizable' && prop === 'padding') || (cls === 'submitButton-customizable' && prop === 'margin')) {
        assert.match(value, /^(\d+px ){3}\d+px$/, `.${cls} ${prop} takes four values`);
      }
      if (cls === 'submitButton-customizable' && prop === 'font-weight') assert.match(value, /^(bold|italic|normal)$/);
      if (cls === 'label-customizable' && prop === 'font-weight') assert.match(value, /^[1-9]00$/);
    }
  }
});

test('in the brand colours: the dark strip and the teal button', () => {
  const rules = new Map(parse(SIGN_IN_CSS).map(([cls, props]) => [cls, new Map(props)]));
  assert.equal(rules.get('banner-customizable')!.get('background-color'), BRAND.ink);
  assert.equal(rules.get('submitButton-customizable')!.get('background-color'), BRAND.accent);
  assert.equal(rules.get('inputField-customizable:focus')!.get('border-color'), BRAND.accent);
});

test('the Auth stack gives it to every app client, once the domain exists', () => {
  const cdkJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8'));
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'flexgym-auth-'));
  const app = new App({ context: { ...cdkJson.context, deployWebAssets: false }, outdir });
  const auth = buildApp(app)
    .synth()
    .stacksRecursively.find((s) => s.hierarchicalId === 'FlexGym-Dev/Auth')!;
  const resources = Object.entries<any>(auth.template.Resources);
  const [, style] = resources.find(([, r]) => r.Type === 'AWS::Cognito::UserPoolUICustomizationAttachment')!;
  const [domainId] = resources.find(([, r]) => r.Type === 'AWS::Cognito::UserPoolDomain')!;
  assert.equal(style.Properties.ClientId, 'ALL');
  assert.equal(style.Properties.CSS, SIGN_IN_CSS);
  assert.ok([style.DependsOn].flat().includes(domainId), 'after the domain');
});
