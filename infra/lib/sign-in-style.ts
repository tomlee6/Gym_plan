/**
 * The look of Cognito's sign-in pages (sign-in, first password, reset):
 * managed login, styled like the iPhone app and the web app. A dark page,
 * a dark card with teal-edged fields and the teal button.
 *
 * Managed login takes a branding style per app client, as a JSON document
 * of colours and options: docs.aws.amazon.com/cognito/latest/developerguide/managed-login-brandingeditor.html.
 * The document below follows the full example in
 * docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_CreateManagedLoginBranding.html,
 * so every option is set rather than left to Cognito's defaults. Cognito
 * ignores keys outside its schema, so a misspelt key is silently dropped,
 * not refused; test/sign-in-style.test.ts holds the shape to that example.
 *
 * Colours are RRGGBBAA hex without a '#'. The page is always dark
 * (colorSchemeMode DARK); the light-mode values are only there so a switch
 * to LIGHT or DYNAMIC later still looks like the brand.
 *
 * Managed login needs the user pool on the Essentials (or Plus) feature
 * plan and the domain on the managed login version (auth-stack.ts).
 */

/** The brand colours (mobile/lib/theme/app_theme.dart, web/src/styles.css). */
export const BRAND = {
  ink: '#01060a',
  panel: '#04111a',
  panelEdge: '#1d444f',
  field: '#01242e',
  fieldEdge: '#3f6773',
  text: '#ffffff',
  textBody: '#c9d1d6',
  muted: '#7b8188',
  accent: '#00cab2',
  accentHover: '#00b39e',
  accentPressed: '#02798d',
  danger: '#fb485b',
  success: '#00c260',
  warning: '#ff7a1c',
};

/** '#00cab2' → '00cab2ff', the form Cognito takes. */
export function rgba(hex: string, alpha = 'ff'): string {
  return `${hex.replace('#', '').toLowerCase()}${alpha}`;
}

/** The light-mode stand-ins, used only if the page is ever not dark. */
const LIGHT = {
  page: '#f4f7f8',
  panel: '#ffffff',
  panelEdge: '#c3d0d4',
  field: '#ffffff',
  fieldEdge: '#7d8b90',
  text: '#01060a',
  textBody: '#3f4a4f',
  muted: '#6b767b',
};

const b = BRAND;

/** The managed login branding style, as Cognito's `Settings` document. */
export const MANAGED_LOGIN_SETTINGS = {
  categories: {
    auth: {
      authMethodOrder: [[{ display: 'INPUT', type: 'USERNAME_PASSWORD' }]],
      federation: { interfaceStyle: 'BUTTON_LIST', order: [] },
    },
    form: {
      displayGraphics: true,
      instructions: { enabled: false },
      languageSelector: { enabled: false },
      location: { horizontal: 'CENTER', vertical: 'CENTER' },
      sessionTimerDisplay: 'NONE',
    },
    global: {
      colorSchemeMode: 'DARK',
      pageFooter: { enabled: false },
      pageHeader: { enabled: false },
      spacingDensity: 'REGULAR',
    },
    signUp: { acceptanceElements: [{ enforcement: 'NONE', textKey: 'en' }] },
  },
  componentClasses: {
    buttons: { borderRadius: 12.0 },
    divider: {
      darkMode: { borderColor: rgba(b.panelEdge) },
      lightMode: { borderColor: rgba(LIGHT.panelEdge) },
    },
    dropDown: {
      borderRadius: 12.0,
      darkMode: {
        defaults: { itemBackgroundColor: rgba(b.field) },
        hover: {
          itemBackgroundColor: rgba(b.panel),
          itemBorderColor: rgba(b.accent),
          itemTextColor: rgba(b.text),
        },
        match: { itemBackgroundColor: rgba(b.panelEdge), itemTextColor: rgba(b.accent) },
      },
      lightMode: {
        defaults: { itemBackgroundColor: rgba(LIGHT.field) },
        hover: {
          itemBackgroundColor: rgba(LIGHT.page),
          itemBorderColor: rgba(b.accentPressed),
          itemTextColor: rgba(LIGHT.text),
        },
        match: { itemBackgroundColor: rgba(LIGHT.panelEdge), itemTextColor: rgba(b.accentPressed) },
      },
    },
    focusState: {
      darkMode: { borderColor: rgba(b.accent) },
      lightMode: { borderColor: rgba(b.accentPressed) },
    },
    idpButtons: { icons: { enabled: true } },
    input: {
      borderRadius: 12.0,
      darkMode: {
        defaults: { backgroundColor: rgba(b.field), borderColor: rgba(b.fieldEdge) },
        placeholderColor: rgba(b.muted),
      },
      lightMode: {
        defaults: { backgroundColor: rgba(LIGHT.field), borderColor: rgba(LIGHT.fieldEdge) },
        placeholderColor: rgba(LIGHT.muted),
      },
    },
    inputDescription: {
      darkMode: { textColor: rgba(b.muted) },
      lightMode: { textColor: rgba(LIGHT.muted) },
    },
    inputLabel: {
      darkMode: { textColor: rgba(b.textBody) },
      lightMode: { textColor: rgba(LIGHT.textBody) },
    },
    link: {
      darkMode: { defaults: { textColor: rgba(b.accent) }, hover: { textColor: rgba(b.accentHover) } },
      lightMode: {
        defaults: { textColor: rgba(b.accentPressed) },
        hover: { textColor: rgba(LIGHT.text) },
      },
    },
    optionControls: {
      darkMode: {
        defaults: { backgroundColor: rgba(b.field), borderColor: rgba(b.fieldEdge) },
        selected: { backgroundColor: rgba(b.accent), foregroundColor: rgba(b.ink) },
      },
      lightMode: {
        defaults: { backgroundColor: rgba(LIGHT.field), borderColor: rgba(LIGHT.fieldEdge) },
        selected: { backgroundColor: rgba(b.accentPressed), foregroundColor: rgba('#ffffff') },
      },
    },
    statusIndicator: {
      darkMode: {
        error: {
          backgroundColor: rgba('#1a0306'),
          borderColor: rgba(b.danger),
          indicatorColor: rgba(b.danger),
        },
        pending: { indicatorColor: rgba(b.muted) },
        success: {
          backgroundColor: rgba('#001a0d'),
          borderColor: rgba(b.success),
          indicatorColor: rgba(b.success),
        },
        warning: {
          backgroundColor: rgba('#1d1006'),
          borderColor: rgba(b.warning),
          indicatorColor: rgba(b.warning),
        },
      },
      lightMode: {
        error: {
          backgroundColor: rgba('#fdecee'),
          borderColor: rgba('#d6283d'),
          indicatorColor: rgba('#d6283d'),
        },
        pending: { indicatorColor: rgba(LIGHT.muted) },
        success: {
          backgroundColor: rgba('#eafaf1'),
          borderColor: rgba('#00995a'),
          indicatorColor: rgba('#00995a'),
        },
        warning: {
          backgroundColor: rgba('#fff4ea'),
          borderColor: rgba('#c25400'),
          indicatorColor: rgba('#c25400'),
        },
      },
    },
  },
  components: {
    alert: {
      borderRadius: 12.0,
      darkMode: { error: { backgroundColor: rgba('#1a0306'), borderColor: rgba(b.danger) } },
      lightMode: { error: { backgroundColor: rgba('#fdecee'), borderColor: rgba('#d6283d') } },
    },
    favicon: { enabledTypes: ['ICO', 'SVG'] },
    form: {
      backgroundImage: { enabled: false },
      borderRadius: 20.0,
      darkMode: { backgroundColor: rgba(b.panel), borderColor: rgba(b.panelEdge) },
      lightMode: { backgroundColor: rgba(LIGHT.panel), borderColor: rgba(LIGHT.panelEdge) },
      // Turned on once a FORM_LOGO asset is added (deployment guide).
      logo: { enabled: false, formInclusion: 'IN', location: 'CENTER', position: 'TOP' },
    },
    idpButton: {
      custom: {},
      standard: {
        darkMode: {
          active: {
            backgroundColor: rgba(b.panelEdge),
            borderColor: rgba(b.accent),
            textColor: rgba(b.accent),
          },
          defaults: {
            backgroundColor: rgba(b.field),
            borderColor: rgba(b.fieldEdge),
            textColor: rgba(b.text),
          },
          hover: {
            backgroundColor: rgba(b.panel),
            borderColor: rgba(b.accent),
            textColor: rgba(b.accent),
          },
        },
        lightMode: {
          active: {
            backgroundColor: rgba(LIGHT.page),
            borderColor: rgba(b.accentPressed),
            textColor: rgba(b.accentPressed),
          },
          defaults: {
            backgroundColor: rgba(LIGHT.field),
            borderColor: rgba(LIGHT.fieldEdge),
            textColor: rgba(LIGHT.text),
          },
          hover: {
            backgroundColor: rgba(LIGHT.page),
            borderColor: rgba(b.accentPressed),
            textColor: rgba(b.accentPressed),
          },
        },
      },
    },
    pageBackground: {
      darkMode: { color: rgba(b.ink) },
      // Turned on once a PAGE_BACKGROUND asset is added.
      image: { enabled: false },
      lightMode: { color: rgba(LIGHT.page) },
    },
    pageFooter: {
      backgroundImage: { enabled: false },
      darkMode: { background: { color: rgba(b.ink) }, borderColor: rgba(b.panelEdge) },
      lightMode: { background: { color: rgba(LIGHT.page) }, borderColor: rgba(LIGHT.panelEdge) },
      logo: { enabled: false, location: 'START' },
    },
    pageHeader: {
      backgroundImage: { enabled: false },
      darkMode: { background: { color: rgba(b.ink) }, borderColor: rgba(b.panelEdge) },
      lightMode: { background: { color: rgba(LIGHT.page) }, borderColor: rgba(LIGHT.panelEdge) },
      logo: { enabled: false, location: 'START' },
    },
    pageText: {
      darkMode: {
        bodyColor: rgba(b.textBody),
        descriptionColor: rgba(b.muted),
        headingColor: rgba(b.text),
      },
      lightMode: {
        bodyColor: rgba(LIGHT.textBody),
        descriptionColor: rgba(LIGHT.muted),
        headingColor: rgba(LIGHT.text),
      },
    },
    phoneNumberSelector: { displayType: 'TEXT' },
    primaryButton: {
      darkMode: {
        active: { backgroundColor: rgba(b.accentPressed), textColor: rgba(b.text) },
        defaults: { backgroundColor: rgba(b.accent), textColor: rgba(b.ink) },
        disabled: { backgroundColor: rgba(b.panelEdge), borderColor: rgba(b.panelEdge) },
        hover: { backgroundColor: rgba(b.accentHover), textColor: rgba(b.ink) },
      },
      lightMode: {
        active: { backgroundColor: rgba(b.accentPressed), textColor: rgba('#ffffff') },
        defaults: { backgroundColor: rgba(b.accent), textColor: rgba(b.ink) },
        disabled: { backgroundColor: rgba(LIGHT.panelEdge), borderColor: rgba(LIGHT.panelEdge) },
        hover: { backgroundColor: rgba(b.accentHover), textColor: rgba(b.ink) },
      },
    },
    secondaryButton: {
      darkMode: {
        active: {
          backgroundColor: rgba(b.panelEdge),
          borderColor: rgba(b.accent),
          textColor: rgba(b.accent),
        },
        defaults: {
          backgroundColor: rgba(b.panel),
          borderColor: rgba(b.accent),
          textColor: rgba(b.accent),
        },
        hover: {
          backgroundColor: rgba(b.field),
          borderColor: rgba(b.accentHover),
          textColor: rgba(b.accentHover),
        },
      },
      lightMode: {
        active: {
          backgroundColor: rgba(LIGHT.page),
          borderColor: rgba(b.accentPressed),
          textColor: rgba(b.accentPressed),
        },
        defaults: {
          backgroundColor: rgba(LIGHT.panel),
          borderColor: rgba(b.accentPressed),
          textColor: rgba(b.accentPressed),
        },
        hover: {
          backgroundColor: rgba(LIGHT.page),
          borderColor: rgba(LIGHT.text),
          textColor: rgba(LIGHT.text),
        },
      },
    },
  },
};
