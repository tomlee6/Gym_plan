/**
 * The look of Cognito's sign-in pages (sign-in, first password, reset), in
 * the colours of the web app and the iPhone app: a dark brand strip over a
 * light form and the teal button.
 *
 * Cognito's classic pages take CSS for a fixed list of classes and
 * properties only, and refuse anything else (no @media, @import or
 * JavaScript, at most 3 KB): docs.aws.amazon.com/cognito/latest/developerguide/hosted-ui-classic-branding.html.
 * test/sign-in-style.test.ts holds the CSS to that list.
 *
 * CloudFormation sets the CSS only; a logo needs the SetUICustomization API.
 */

/** The brand colours (mobile/lib/theme/app_theme.dart, web/src/styles.css). */
export const BRAND = {
  ink: '#01060a',
  accent: '#00cab2',
  accentHover: '#00b39e',
  muted: '#3f4a4f',
  field: '#f4f7f8',
  fieldEdge: '#c3d0d4',
  danger: '#fb485b',
};

const rules: Record<string, Record<string, string>> = {
  'background-customizable': { 'background-color': '#ffffff' },
  'banner-customizable': { padding: '22px 0px 22px 0px', 'background-color': BRAND.ink },
  'textDescription-customizable': {
    'padding-top': '10px',
    'padding-bottom': '10px',
    display: 'block',
    'font-size': '16px',
    color: BRAND.ink,
  },
  'label-customizable': { 'font-weight': '600', color: BRAND.muted },
  'inputField-customizable': {
    width: '100%',
    height: '40px',
    color: BRAND.ink,
    'background-color': BRAND.field,
    border: `1px solid ${BRAND.fieldEdge}`,
  },
  'inputField-customizable:focus': { 'border-color': BRAND.accent },
  'submitButton-customizable': {
    'font-size': '15px',
    'font-weight': 'bold',
    margin: '20px 0px 0px 0px',
    width: '100%',
    height: '44px',
    color: BRAND.ink,
    'background-color': BRAND.accent,
  },
  'submitButton-customizable:hover': { color: BRAND.ink, 'background-color': BRAND.accentHover },
  'errorMessage-customizable': {
    padding: '10px',
    'font-size': '13px',
    width: '100%',
    background: '#fdecee',
    border: `1px solid ${BRAND.danger}`,
    color: '#b3132a',
  },
  'passwordCheck-notValid-customizable': { color: '#d6283d' },
  'passwordCheck-valid-customizable': { color: '#00995a' },
};

/** The CSS Cognito is given, one rule a line. */
export const SIGN_IN_CSS = Object.entries(rules)
  .map(([cls, props]) => `.${cls} { ${Object.entries(props).map(([k, v]) => `${k}: ${v};`).join(' ')} }`)
  .join('\n');
