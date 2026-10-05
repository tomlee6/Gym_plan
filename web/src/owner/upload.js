/**
 * Uploading a drawing (UPL-01..04): recognising the file, rendering a PDF
 * page to trace over, and sending the files through the same signed-URL
 * multipart contract the app uses (mobile/docs/upload-api.md).
 */
import { capturesApi } from '../lib/client.js';

export const MAX_BYTES = 50 * 1024 * 1024;
export const PART_SIZE = 8 * 1024 * 1024;
/** Longest side of a rendered PDF page, in pixels. */
const MAX_RENDER_PX = 4000;

const TYPES = {
  pdf: { contentType: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  png: { contentType: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
  jpg: { contentType: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  dwg: { contentType: 'application/acad', magic: [0x41, 0x43, 0x31] }, // "AC1" + release
};

export function contentTypeOf(type) {
  return TYPES[type].contentType;
}

/**
 * What kind of drawing a file is, checked by extension and by its first
 * bytes, or an error message for the owner.
 */
export async function detectDrawing(file) {
  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  const type = ext === 'jpeg' ? 'jpg' : ext;
  if (!TYPES[type]) return { error: 'Choose a PDF, DWG, JPG or PNG file.' };
  if (file.size === 0) return { error: 'This file is empty.' };
  if (file.size > MAX_BYTES) return { error: 'Drawings can be up to 50 MB. This file is larger.' };
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const ok = TYPES[type].magic.every((b, i) => head[i] === b);
  if (!ok) return { error: `This file is not a readable ${type.toUpperCase()}.` };
  return { type };
}

/** The natural size of an image file. */
export function loadImageSize(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight, url });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This image could not be read.'));
    };
    img.src = url;
  });
}

let pdfjs = null;

/** pdf.js, loaded only when a PDF is chosen. */
async function loadPdfjs() {
  if (!pdfjs) {
    const [lib, worker] = await Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]);
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    pdfjs = lib;
  }
  return pdfjs;
}

export async function openPdf(file) {
  const lib = await loadPdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  return doc;
}

/** Renders one page of a PDF to a PNG blob, sharp enough to trace. */
export async function renderPdfPage(doc, pageNumber) {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(MAX_RENDER_PX / Math.max(base.width, base.height), 4);
  const viewport = page.getViewport({ scale: Math.max(scale, 1) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport }).promise;
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The page could not be rendered.'))), 'image/png'),
  );
  return { blob, width: canvas.width, height: canvas.height, url: URL.createObjectURL(blob) };
}

/** PUTs one part to its signed URL. The URL is the credential: no auth header. */
async function putPart(url, body) {
  let res;
  try {
    res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body });
  } catch {
    return false;
  }
  return res.ok;
}

function slicePart(blob, number) {
  return blob.slice((number - 1) * PART_SIZE, number * PART_SIZE);
}

/**
 * Registers the drawing and uploads its files. `files` is
 * `[{ name, kind, blob, contentType }]`; `onProgress(fraction)` reports
 * bytes sent. Resends parts the platform reports missing, and parts whose
 * URL had expired, before giving up.
 */
export async function submitDrawing({ body, files, idempotencyKey, onProgress = () => {} }) {
  const { captureId } = await capturesApi.registerDrawing(body, idempotencyKey);
  const opened = await capturesApi.openUploads(captureId, {
    partSize: PART_SIZE,
    files: files.map((f) => ({ name: f.name, kind: f.kind, bytes: f.blob.size, contentType: f.contentType })),
  });

  const total = files.reduce((s, f) => s + f.blob.size, 0) || 1;
  let sent = 0;
  const byId = new Map();
  for (const target of opened.files) {
    const file = files.find((f) => f.name === target.name);
    byId.set(target.fileId, file);
  }

  /** Sends the given targets; returns the parts that failed, by file id. */
  async function send(targets) {
    const failed = {};
    for (const target of targets) {
      const file = byId.get(target.fileId) ?? files.find((f) => f.name === target.name);
      for (const part of target.parts) {
        const chunk = slicePart(file.blob, part.number);
        if (await putPart(part.url, chunk)) {
          sent += chunk.size;
          onProgress(Math.min(sent / total, 1));
        } else {
          (failed[target.fileId] ??= []).push(part.number);
        }
      }
    }
    return failed;
  }

  let failed = await send(opened.files);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (Object.keys(failed).length) {
      const fresh = await capturesApi.refreshParts(captureId, {
        files: Object.entries(failed).map(([fileId, parts]) => ({ fileId, parts })),
      });
      failed = await send(fresh.files);
      continue;
    }
    const result = await capturesApi.complete(captureId);
    if (result.status === 'received') {
      onProgress(1);
      return { captureId };
    }
    failed = Object.fromEntries((result.missing ?? []).map((m) => [m.fileId, m.parts]));
  }
  throw new Error('Some of the drawing did not arrive. Check your connection and submit again.');
}

export function newIdempotencyKey() {
  return globalThis.crypto?.randomUUID?.() ?? `up-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
