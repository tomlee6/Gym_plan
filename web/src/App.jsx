import { lazy, Suspense, useEffect } from 'react';

import { tokenFromPath } from './api.js';
import Disclaimer from './components/Disclaimer.jsx';
import { LoadFailed, Loading, NotReady, Unavailable } from './components/StatusScreen.jsx';
import TopBar from './components/TopBar.jsx';
import { area, date, levelLabel } from './lib/format.js';
import { useShare } from './useShare.js';

// three.js is only needed once a link has loaded.
const Walkthrough = lazy(() => import('./viewer/Walkthrough.jsx'));

/**
 * The share link viewer (VIEW-07): `/s/<token>` opens one approved
 * walkthrough, view-only, to anyone holding the link. The link always
 * shows the plan's newest approved version.
 */
export default function App({ pathname = window.location.pathname }) {
  const token = tokenFromPath(pathname);
  if (!token) {
    return (
      <Shell>
        <Unavailable />
      </Shell>
    );
  }
  return <SharePage token={token} />;
}

function SharePage({ token }) {
  const { status, share, error, retry } = useShare(token);

  useEffect(() => {
    if (share) document.title = `${share.site} · ${levelLabel(share.level)} · Flex`;
  }, [share]);

  if (status === 'loading') {
    return (
      <Shell>
        <Loading />
      </Shell>
    );
  }
  if (status === 'error') {
    return (
      <Shell>{error.notFound ? <Unavailable /> : <LoadFailed error={error} onRetry={retry} />}</Shell>
    );
  }
  if (!share.plan) {
    return (
      <Shell share={share}>
        <NotReady />
      </Shell>
    );
  }

  const meta = [
    'View only',
    `version ${share.version}`,
    share.approvedAt && `approved ${date(share.approvedAt)}`,
    area(share.areaM2),
    share.expiresAt && `link works until ${date(share.expiresAt)}`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Suspense
      fallback={
        <Shell share={share}>
          <Loading />
        </Shell>
      }
    >
      <Walkthrough
        plan={share.plan}
        modelUrl={share.generatedModel?.url ?? null}
        machineModels={share.machineModels ?? null}
        site={share.site}
        level={share.level}
        meta={meta}
      />
    </Suspense>
  );
}

function Shell({ share, children }) {
  return (
    <div className="app">
      <TopBar share={share} />
      {children}
      <Disclaimer share={share} />
    </div>
  );
}
