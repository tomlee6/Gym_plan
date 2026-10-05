/**
 * Receives part uploads for the local storage driver: the development
 * stand-in for S3's presigned PUT. Mounted only when STORAGE_DRIVER=local.
 *
 * Authentication is the URL's own signature and expiry, as with S3; no
 * bearer token, because background transfers cannot refresh one.
 */
import { Router } from 'express';

import { config } from '../config.js';
import { storage } from '../storage/index.js';

export const router = Router();

// The web app (PUBLIC_WEB_URL) uploads drawings straight to these URLs and
// reads scan files from them. A cross-origin PUT is preflighted, so answer
// that too. The signature, not the origin, is what authorises a request.
router.use((req, res, next) => {
  res.vary('Origin');
  if (req.get('origin') === config.publicWebUrl) {
    res.set('Access-Control-Allow-Origin', config.publicWebUrl);
    res.set('Access-Control-Expose-Headers', 'ETag');
  }
  if (req.method === 'OPTIONS') {
    res.set({
      'Access-Control-Allow-Methods': 'GET, PUT',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
    });
    return res.status(204).end();
  }
  next();
});

/** Serves a stored object to a signed download URL (reviewers' scan files). */
router.get('/objects/:key', (req, res) => {
  const file = storage().verifyDownload(req.params.key, req.query.expires, req.query.sig);
  if (!file) {
    return res.status(403).json({ message: 'Request has expired or is not signed.' });
  }
  // The reviewer page reads scan.json with fetch(), and shows images, from
  // its own origin, whether or not the browser sent an Origin header.
  res.set('Access-Control-Allow-Origin', config.publicWebUrl);
  res.sendFile(file, (err) => {
    if (err && !res.headersSent) res.status(404).json({ message: 'Not found.' });
  });
});

router.put('/:uploadId/:partNumber', async (req, res) => {
  const { uploadId } = req.params;
  const partNumber = Number(req.params.partNumber);
  const s = storage();

  if (
    !Number.isInteger(partNumber) ||
    partNumber < 1 ||
    partNumber > 10000 ||
    !s.verify(uploadId, partNumber, req.query.expires, req.query.sig)
  ) {
    // What S3 answers for an expired or tampered URL.
    return res.status(403).json({ message: 'Request has expired or is not signed.' });
  }

  try {
    const etag = await s.putPart(uploadId, partNumber, req, {
      maxBytes: config.uploads.maxPartSize,
    });
    res.set('ETag', etag).status(200).end();
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return res.status(404).json({ message: 'This upload does not exist.' });
    }
    if (err?.message === 'Part too large') {
      return res.status(413).json({ message: 'Part too large.' });
    }
    throw err;
  }
});
