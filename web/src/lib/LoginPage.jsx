import { useState } from 'react';
import { Navigate, useLocation } from 'react-router';

import { homeFor, useAuth } from './auth.jsx';
import { t } from './i18n.js';
import { ArrowRightIcon, CubeIcon, PhoneIcon, ShieldCheckIcon } from './icons.jsx';
import { useTitle } from './useTitle.js';

/** The FLEX · GYM SCAN mark the sign-in pages share. */
export function Brand() {
  return (
    <div className="rv-brand">
      <div className="rv-wordmark">FLEX</div>
      <div className="rv-product">GYM SCAN</div>
    </div>
  );
}

/**
 * A gym level as the plan canvas draws it: the outline, rooms, rows of
 * machines and a walker looking along the floor. Decoration only.
 */
function PlanSketch() {
  const treadmills = [0, 1, 2, 3, 4].map((i) => <rect key={`t${i}`} x={44 + i * 30} y={42} width={18} height={44} rx={3} />);
  const bikes = [0, 1, 2].map((i) => <rect key={`b${i}`} x={44 + i * 30} y={112} width={18} height={28} rx={3} />);
  const racks = [0, 1, 2].map((i) => <rect key={`r${i}`} x={318} y={128 + i * 34} width={44} height={20} rx={3} />);
  const mats = [0, 1, 2].map((i) => <rect key={`m${i}`} x={226 + i * 24} y={36} width={16} height={42} rx={3} />);
  return (
    <svg className="si-sketch" viewBox="0 0 400 260" role="presentation" aria-hidden="true" focusable="false">
      <defs>
        <pattern id="si-grid" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M20 0H0V20" fill="none" stroke="#0f1f25" strokeWidth="1" />
        </pattern>
        <radialGradient id="si-cone" cx="0" cy="1" r="1">
          <stop offset="0" stopColor="#00cab2" stopOpacity="0.55" />
          <stop offset="1" stopColor="#00cab2" stopOpacity="0" />
        </radialGradient>
      </defs>
      <path d="M20 20H300V110H380V240H20Z" fill="#000e15" />
      <path d="M20 20H300V110H380V240H20Z" fill="url(#si-grid)" />
      <path d="M210 20H300V110H210Z" fill="#03141b" />
      <g fill="#0c1d25" stroke="#1d444f" strokeWidth="1.2">
        {treadmills}
        {bikes}
        {racks}
        {mats}
        <rect x="120" y="176" width="64" height="18" rx="3" />
      </g>
      <g fill="none" stroke="#3f6773" strokeWidth="2.4" strokeLinecap="round">
        <path d="M210 20V66M210 90V110H262M286 110H300" />
        <path d="M300 168V196M300 220V240" />
      </g>
      <path
        d="M60 228C110 228 120 214 150 208"
        fill="none"
        stroke="#00cab2"
        strokeOpacity="0.55"
        strokeWidth="1.6"
        strokeDasharray="3 5"
        strokeLinecap="round"
      />
      <path d="M156 206L236 150A90 90 0 0 1 250 196Z" fill="url(#si-cone)" />
      <circle cx="156" cy="206" r="11" fill="#00cab2" fillOpacity="0.18" />
      <circle cx="156" cy="206" r="5" fill="#00cab2" />
      <path d="M20 20H300V110H380V240H20Z" fill="none" stroke="#00cab2" strokeOpacity="0.9" strokeWidth="2.4" strokeLinejoin="round" />
    </svg>
  );
}

const STEPS = [
  { key: 'scan', Icon: PhoneIcon },
  { key: 'review', Icon: ShieldCheckIcon },
  { key: 'walk', Icon: CubeIcon },
];

/**
 * Every sign-in page (sign-in, the Hub's return, a link from the app): what
 * Flex Gym Scan does on one side, the page's own card on the other. On a
 * phone the two stack, with the card straight under the name.
 */
export function SignInFrame({ children }) {
  return (
    <main className="si">
      <section className="si-showcase">
        <Brand />
        <div className="si-pitch">
          <p className="si-eyebrow">{t('auth.showcase.eyebrow')}</p>
          <p className="si-title">{t('auth.showcase.title')}</p>
          <p className="si-lead">{t('auth.showcase.lead')}</p>
        </div>
        <PlanSketch />
        <ol className="si-steps">
          {STEPS.map(({ key, Icon }) => (
            <li key={key} className="si-step">
              <span className="si-step-icon">
                <Icon size={16} />
              </span>
              <strong>{t(`auth.showcase.steps.${key}.title`)}</strong>
              <span>{t(`auth.showcase.steps.${key}.body`)}</span>
            </li>
          ))}
        </ol>
      </section>
      <section className="si-panel">
        <div className="si-card">{children}</div>
        <p className="si-foot">{t('auth.footer')}</p>
      </section>
    </main>
  );
}

/**
 * Sign-in for every role (B-07). There is no password here: the button
 * sends the page to the sign-in provider (Cognito, or the GoalCert Hub),
 * which brings the browser back to /auth/callback. Where the person was
 * heading is carried through it in this tab's sessionStorage.
 */
export default function LoginPage() {
  useTitle(t('auth.title'));
  const { status, user, signIn } = useAuth();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const from = location.state?.from ?? null;

  if (status === 'signedIn') return <Navigate to={from ?? homeFor(user)} replace />;

  async function go() {
    setBusy(true);
    setError(null);
    try {
      await signIn(from);
      // The page is navigating away; stay busy until it does.
    } catch (err) {
      setError(t('auth.errors.config', { detail: err.message }));
      setBusy(false);
    }
  }

  return (
    <SignInFrame>
      <h1>{t('auth.title')}</h1>
      <p className="muted">{t('auth.lead')}</p>
      <div aria-live="assertive">
        {error && (
          <p className="rv-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <button type="button" className="rv-button primary wide" onClick={go} disabled={busy || status === 'checking'}>
        {busy ? t('auth.redirecting') : t('auth.button')}
        {!busy && <ArrowRightIcon size={16} />}
      </button>
      <p className="si-note">{t('auth.note')}</p>
    </SignInFrame>
  );
}
