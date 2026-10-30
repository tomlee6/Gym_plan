/**
 * Cognito's sign-in pages in the Flex Gym Scan colours (sign-in-style.ts):
 * managed login with a branding style.
 *
 * Cognito ignores keys outside its schema rather than refusing them, so a
 * misspelt key would deploy cleanly and do nothing. Every key path is held
 * here to those of the full example in
 * docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_CreateManagedLoginBranding.html.
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
import { BRAND, MANAGED_LOGIN_SETTINGS, rgba } from '../lib/sign-in-style';

/**
 * The parent paths of AWS's example, each with the keys allowed under it.
 * `*Mode` blocks and state blocks (defaults, hover, ...) are expanded from
 * the example's own nesting.
 */
const MODES = ['darkMode', 'lightMode'];
const KEYS: Record<string, string[]> = {
  '': ['categories', 'componentClasses', 'components'],
  categories: ['auth', 'form', 'global', 'signUp'],
  'categories.auth': ['authMethodOrder', 'federation'],
  'categories.auth.federation': ['interfaceStyle', 'order'],
  'categories.form': ['displayGraphics', 'instructions', 'languageSelector', 'location', 'sessionTimerDisplay'],
  'categories.form.instructions': ['enabled'],
  'categories.form.languageSelector': ['enabled'],
  'categories.form.location': ['horizontal', 'vertical'],
  'categories.global': ['colorSchemeMode', 'pageFooter', 'pageHeader', 'spacingDensity'],
  'categories.global.pageFooter': ['enabled'],
  'categories.global.pageHeader': ['enabled'],
  'categories.signUp': ['acceptanceElements'],
  componentClasses: [
    'buttons', 'divider', 'dropDown', 'focusState', 'idpButtons', 'input',
    'inputDescription', 'inputLabel', 'link', 'optionControls', 'statusIndicator',
  ],
  'componentClasses.buttons': ['borderRadius'],
  'componentClasses.divider': MODES,
  'componentClasses.divider.*': ['borderColor'],
  'componentClasses.dropDown': ['borderRadius', ...MODES],
  'componentClasses.dropDown.*': ['defaults', 'hover', 'match'],
  'componentClasses.dropDown.*.defaults': ['itemBackgroundColor'],
  'componentClasses.dropDown.*.hover': ['itemBackgroundColor', 'itemBorderColor', 'itemTextColor'],
  'componentClasses.dropDown.*.match': ['itemBackgroundColor', 'itemTextColor'],
  'componentClasses.focusState': MODES,
  'componentClasses.focusState.*': ['borderColor'],
  'componentClasses.idpButtons': ['icons'],
  'componentClasses.idpButtons.icons': ['enabled'],
  'componentClasses.input': ['borderRadius', ...MODES],
  'componentClasses.input.*': ['defaults', 'placeholderColor'],
  'componentClasses.input.*.defaults': ['backgroundColor', 'borderColor'],
  'componentClasses.inputDescription': MODES,
  'componentClasses.inputDescription.*': ['textColor'],
  'componentClasses.inputLabel': MODES,
  'componentClasses.inputLabel.*': ['textColor'],
  'componentClasses.link': MODES,
  'componentClasses.link.*': ['defaults', 'hover'],
  'componentClasses.link.*.defaults': ['textColor'],
  'componentClasses.link.*.hover': ['textColor'],
  'componentClasses.optionControls': MODES,
  'componentClasses.optionControls.*': ['defaults', 'selected'],
  'componentClasses.optionControls.*.defaults': ['backgroundColor', 'borderColor'],
  'componentClasses.optionControls.*.selected': ['backgroundColor', 'foregroundColor'],
  'componentClasses.statusIndicator': MODES,
  'componentClasses.statusIndicator.*': ['error', 'pending', 'success', 'warning'],
  'componentClasses.statusIndicator.*.error': ['backgroundColor', 'borderColor', 'indicatorColor'],
  'componentClasses.statusIndicator.*.pending': ['indicatorColor'],
  'componentClasses.statusIndicator.*.success': ['backgroundColor', 'borderColor', 'indicatorColor'],
  'componentClasses.statusIndicator.*.warning': ['backgroundColor', 'borderColor', 'indicatorColor'],
  components: [
    'alert', 'favicon', 'form', 'idpButton', 'pageBackground', 'pageFooter', 'pageHeader',
    'pageText', 'phoneNumberSelector', 'primaryButton', 'secondaryButton',
  ],
  'components.alert': ['borderRadius', ...MODES],
  'components.alert.*': ['error'],
  'components.alert.*.error': ['backgroundColor', 'borderColor'],
  'components.favicon': ['enabledTypes'],
  'components.form': ['backgroundImage', 'borderRadius', 'logo', ...MODES],
  'components.form.backgroundImage': ['enabled'],
  'components.form.*': ['backgroundColor', 'borderColor'],
  'components.form.logo': ['enabled', 'formInclusion', 'location', 'position'],
  'components.idpButton': ['custom', 'standard'],
  'components.idpButton.custom': [],
  'components.idpButton.standard': MODES,
  'components.idpButton.standard.*': ['active', 'defaults', 'hover'],
  'components.idpButton.standard.*.active': ['backgroundColor', 'borderColor', 'textColor'],
  'components.idpButton.standard.*.defaults': ['backgroundColor', 'borderColor', 'textColor'],
  'components.idpButton.standard.*.hover': ['backgroundColor', 'borderColor', 'textColor'],
  'components.pageBackground': ['image', ...MODES],
  'components.pageBackground.image': ['enabled'],
  'components.pageBackground.*': ['color'],
  'components.pageFooter': ['backgroundImage', 'logo', ...MODES],
  'components.pageFooter.backgroundImage': ['enabled'],
  'components.pageFooter.logo': ['enabled', 'location'],
  'components.pageFooter.*': ['background', 'borderColor'],
  'components.pageFooter.*.background': ['color'],
  'components.pageHeader': ['backgroundImage', 'logo', ...MODES],
  'components.pageHeader.backgroundImage': ['enabled'],
  'components.pageHeader.logo': ['enabled', 'location'],
  'components.pageHeader.*': ['background', 'borderColor'],
  'components.pageHeader.*.background': ['color'],
  'components.pageText': MODES,
  'components.pageText.*': ['bodyColor', 'descriptionColor', 'headingColor'],
  'components.phoneNumberSelector': ['displayType'],
  'components.primaryButton': MODES,
  'components.primaryButton.*': ['active', 'defaults', 'disabled', 'hover'],
  'components.primaryButton.*.active': ['backgroundColor', 'textColor'],
  'components.primaryButton.*.defaults': ['backgroundColor', 'textColor'],
  'components.primaryButton.*.disabled': ['backgroundColor', 'borderColor'],
  'components.primaryButton.*.hover': ['backgroundColor', 'textColor'],
  'components.secondaryButton': MODES,
  'components.secondaryButton.*': ['active', 'defaults', 'hover'],
  'components.secondaryButton.*.active': ['backgroundColor', 'borderColor', 'textColor'],
  'components.secondaryButton.*.defaults': ['backgroundColor', 'borderColor', 'textColor'],
  'components.secondaryButton.*.hover': ['backgroundColor', 'borderColor', 'textColor'],
};

/** Every [path, value] pair under plain objects; arrays are leaves. */
function walk(node: unknown, at: string[] = []): [string[], unknown][] {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return [[at, node]];
  const out: [string[], unknown][] = [[at, node]];
  for (const [k, v] of Object.entries(node)) out.push(...walk(v, [...at, k]));
  return out;
}

/** 'components.form.darkMode' → 'components.form.*'. */
const pattern = (at: string[]) => at.map((k) => (MODES.includes(k) ? '*' : k)).join('.');

test('every key is one Cognito knows, in the place it expects it', () => {
  for (const [at, value] of walk(MANAGED_LOGIN_SETTINGS)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const allowed = KEYS[pattern(at)];
    assert.ok(allowed, `no such block in Cognito's schema: ${at.join('.') || '(top)'}`);
    for (const key of Object.keys(value)) {
      assert.ok(allowed.includes(key), `Cognito does not take ${key} under ${at.join('.') || '(top)'}`);
    }
  }
});

test('colours are RRGGBBAA hex without a #', () => {
  for (const [at, value] of walk(MANAGED_LOGIN_SETTINGS)) {
    const key = at[at.length - 1] ?? '';
    if (/colou?r$/i.test(key)) assert.match(String(value), /^[0-9a-f]{8}$/, at.join('.'));
  }
  assert.equal(rgba('#00CAB2'), '00cab2ff');
});

test('a dark page in the brand colours, with the teal button', () => {
  const s = MANAGED_LOGIN_SETTINGS;
  assert.equal(s.categories.global.colorSchemeMode, 'DARK');
  assert.equal(s.components.pageBackground.darkMode.color, rgba(BRAND.ink));
  assert.equal(s.components.primaryButton.darkMode.defaults.backgroundColor, rgba(BRAND.accent));
  assert.equal(s.componentClasses.focusState.darkMode.borderColor, rgba(BRAND.accent));
  // Sign-in is email and password only: no social buttons.
  assert.deepEqual(s.categories.auth.authMethodOrder, [[{ display: 'INPUT', type: 'USERNAME_PASSWORD' }]]);
});

test('the Auth stack turns on managed login and styles the app client', () => {
  const cdkJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8'));
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'flexgym-auth-'));
  const app = new App({ context: { ...cdkJson.context, deployWebAssets: false }, outdir });
  const auth = buildApp(app)
    .synth()
    .stacksRecursively.find((s) => s.hierarchicalId === 'FlexGym-Dev/Auth')!;
  const resources = Object.entries<any>(auth.template.Resources);
  const find = (type: string) => resources.find(([, r]) => r.Type === type)!;

  const [, pool] = find('AWS::Cognito::UserPool');
  assert.equal(pool.Properties.UserPoolTier, 'ESSENTIALS');

  const [domainId, domain] = find('AWS::Cognito::UserPoolDomain');
  assert.equal(domain.Properties.ManagedLoginVersion, 2);

  const [clientId] = find('AWS::Cognito::UserPoolClient');
  const [, style] = find('AWS::Cognito::ManagedLoginBranding');
  assert.deepEqual(style.Properties.ClientId, { Ref: clientId });
  assert.equal(style.Properties.UseCognitoProvidedValues, false);
  assert.deepEqual(style.Properties.Settings, MANAGED_LOGIN_SETTINGS);
  assert.ok([style.DependsOn].flat().includes(domainId), 'after the domain');

  // The classic hosted UI's CSS does not apply to managed login.
  assert.equal(resources.filter(([, r]) => r.Type === 'AWS::Cognito::UserPoolUICustomizationAttachment').length, 0);
});
