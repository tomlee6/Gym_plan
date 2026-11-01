import { useState } from 'react';

import { objectsApi } from '../lib/client.js';
import { bytes, stamp } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import { CubeIcon, DownloadIcon, RefreshIcon, TrashIcon } from '../lib/icons.jsx';
import Modal from '../lib/Modal.jsx';
import { useLoader } from '../lib/useLoader.js';
import { useTitle } from '../lib/useTitle.js';
import './owner.css';

const loadObjects = () => objectsApi.list().then((r) => r.objects);

/**
 * The account's 3D objects: single things scanned with the app's 3D Object
 * mode (Apple Object Capture), each a photo-textured USDZ.
 *
 * Browsers cannot draw a USDZ, so each one is offered as a download, and
 * as Apple's AR Quick Look link, which an iPhone or iPad opens in place.
 * The download links are signed and short-lived, so each is fetched when
 * it is clicked rather than with the list.
 */
export default function ObjectsPage() {
  useTitle(t('owner.objects.title'));
  const { data, error, loading, reload } = useLoader(loadObjects, 'objects');
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  async function open(object, { ar = false } = {}) {
    try {
      const { downloadUrl } = await objectsApi.get(object.objectId);
      const a = document.createElement('a');
      a.href = downloadUrl;
      if (ar) {
        // AR Quick Look only opens a link marked rel="ar" with an image in it.
        a.rel = 'ar';
        a.appendChild(document.createElement('img'));
      } else {
        a.download = `${object.name}.usdz`;
      }
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      setNotice(t('owner.objects.failed', { message: err.message }));
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await objectsApi.remove(removing.objectId);
      setNotice(t('owner.objects.removed', { name: removing.name }));
      setRemoving(null);
      reload();
    } catch (err) {
      setNotice(t('owner.objects.failed', { message: err.message }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="rv-header">
        <h1>{t('owner.objects.title')}</h1>
        <span className="spacer" />
        <button type="button" className="rv-button ghost" onClick={reload} disabled={loading}>
          <RefreshIcon size={15} />
          {loading ? t('common.refreshing') : t('common.refresh')}
        </button>
      </header>

      <div className="rv-content">
        <p className="muted">{t('owner.objects.lead')}</p>
        {notice && (
          <p className="rv-notice" role="status">
            {notice}
          </p>
        )}
        {!data && error ? (
          <div className="rv-empty" role="alert">
            <h2>{t('owner.objects.loadFailed')}</h2>
            <p className="muted">{error.message}</p>
            <button type="button" className="rv-button primary" onClick={reload}>
              {t('common.tryAgain')}
            </button>
          </div>
        ) : !data ? (
          <div className="rv-empty" role="status" aria-live="polite">
            <span className="rv-spinner" aria-hidden="true" />
            <p className="muted">{t('owner.objects.loading')}</p>
          </div>
        ) : data.length === 0 ? (
          <div className="rv-empty">
            <h2>{t('owner.objects.none')}</h2>
            <p className="muted">{t('owner.objects.noneBody')}</p>
          </div>
        ) : (
          <>
            <ul className="ow-objects" aria-label={t('owner.objects.title')}>
              {data.map((o) => (
                <li key={o.objectId} className="rv-card ow-object">
                  <div className="ow-object-icon" aria-hidden="true">
                    <CubeIcon size={26} />
                  </div>
                  <div className="ow-object-main">
                    <h2 className="ow-object-name">{o.name}</h2>
                    <span className="muted small">
                      {o.facility?.name ?? t('owner.objects.noFacility')} · {stamp(o.scannedAt ?? o.createdAt)}
                    </span>
                    <span className="muted small">
                      {[
                        o.photoCount != null && t('owner.objects.photos', { count: o.photoCount }),
                        bytes(o.bytes),
                        o.scannedBy && t('owner.objects.by', { name: o.scannedBy }),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </div>
                  <div className="ow-object-actions">
                    <button type="button" className="rv-button primary" onClick={() => open(o, { ar: true })}>
                      <CubeIcon size={15} />
                      {t('owner.objects.ar')}
                    </button>
                    <button type="button" className="rv-button ghost" onClick={() => open(o)}>
                      <DownloadIcon size={15} />
                      {t('owner.objects.download')}
                    </button>
                    <button
                      type="button"
                      className="rv-button ghost"
                      onClick={() => setRemoving(o)}
                      aria-label={`${t('owner.objects.remove')}, ${o.name}`}
                    >
                      <TrashIcon size={15} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <p className="muted small">{t('owner.objects.arHint')}</p>
          </>
        )}
      </div>

      {removing && (
        <Modal
          title={t('owner.objects.removeTitle', { name: removing.name })}
          onClose={() => setRemoving(null)}
          busy={busy}
          footer={
            <>
              <button type="button" className="rv-button ghost" onClick={() => setRemoving(null)} disabled={busy}>
                {t('owner.objects.cancel')}
              </button>
              <button type="button" className="rv-button danger" onClick={remove} disabled={busy}>
                {busy ? t('owner.objects.removing') : t('owner.objects.remove')}
              </button>
            </>
          }
        >
          <p>{t('owner.objects.removeBody')}</p>
        </Modal>
      )}
    </>
  );
}
