import { useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { meApi } from '../lib/client.js';
import { bytes, levelLabel } from '../lib/format.js';
import { BackIcon, FileIcon, UploadIcon } from '../lib/icons.jsx';
import { useLoader } from '../lib/useLoader.js';
import { useTitle } from '../lib/useTitle.js';
import ScaleCanvas, { lineLength } from './ScaleCanvas.jsx';
import {
  contentTypeOf,
  detectDrawing,
  loadImageSize,
  newIdempotencyKey,
  openPdf,
  renderPdfPage,
  submitDrawing,
} from './upload.js';
import './owner.css';

const STEPS = ['File', 'Set scale', 'Submit'];
const MIN_LINE_PX = 10;

const defaultLine = (w, h) => ({
  a: [Math.round(w * 0.2), Math.round(h * 0.5)],
  b: [Math.round(w * 0.8), Math.round(h * 0.5)],
});

const TYPE_NAMES = { pdf: 'PDF', dwg: 'DWG drawing', jpg: 'JPG image', png: 'PNG image' };

/**
 * Upload a plan the owner already has (UPL-01..04): choose the gym and
 * level, pick a PDF, DWG, JPG or PNG, draw one line over a known dimension
 * to set the scale, and submit. It then enters the same review pipeline as
 * a scan.
 */
export default function UploadPage() {
  useTitle('Upload a plan');
  const navigate = useNavigate();
  const { data: facilityList, error: facilityError, reload } = useLoader(meApi.facilities, 'facilities');

  const [step, setStep] = useState(0);
  const [facilityId, setFacilityId] = useState('');
  const [level, setLevel] = useState('0');
  const [ceiling, setCeiling] = useState('');
  const [file, setFile] = useState(null);
  const [type, setType] = useState(null);
  const [fileError, setFileError] = useState(null);
  const [reading, setReading] = useState(false);
  const [pdf, setPdf] = useState(null); // { doc, pageCount }
  const [page, setPage] = useState(1);
  const [image, setImage] = useState(null); // { url, width, height, blob? }
  const [line, setLine] = useState(null);
  const [lengthM, setLengthM] = useState('');
  const [progress, setProgress] = useState(null);
  const [submitError, setSubmitError] = useState(null);
  const keyRef = useRef(null);
  const urls = useRef([]);

  // Preselect the user's default gym once the list arrives.
  useEffect(() => {
    if (facilityList && !facilityId) {
      setFacilityId(facilityList.defaultFacilityId ?? facilityList.facilities[0]?.id ?? '');
    }
  }, [facilityList, facilityId]);

  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL?.(u)), []);

  function track(url) {
    urls.current.push(url);
    return url;
  }

  async function choose(f) {
    setFileError(null);
    setFile(null);
    setType(null);
    setPdf(null);
    setImage(null);
    setLine(null);
    setLengthM('');
    keyRef.current = null;
    if (!f) return;
    const found = await detectDrawing(f);
    if (found.error) {
      setFileError(found.error);
      return;
    }
    setFile(f);
    setType(found.type);
    setReading(true);
    try {
      if (found.type === 'pdf') {
        const doc = await openPdf(f);
        setPdf({ doc, pageCount: doc.numPages });
        await showPage(doc, 1);
      } else if (found.type === 'png' || found.type === 'jpg') {
        const img = await loadImageSize(f);
        track(img.url);
        setImage(img);
        setLine(defaultLine(img.width, img.height));
      }
    } catch (err) {
      setFileError(err.message || 'This file could not be read.');
      setFile(null);
      setType(null);
    } finally {
      setReading(false);
    }
  }

  async function showPage(doc, n) {
    setReading(true);
    try {
      const rendered = await renderPdfPage(doc, n);
      track(rendered.url);
      setPage(n);
      setImage(rendered);
      setLine(defaultLine(rendered.width, rendered.height));
    } finally {
      setReading(false);
    }
  }

  const levelNumber = Number(level);
  const levelOk = level !== '' && Number.isInteger(levelNumber) && levelNumber >= -5 && levelNumber <= 200;
  const ceilingNumber = ceiling === '' ? null : Number(ceiling);
  const ceilingOk = ceilingNumber === null || (ceilingNumber >= 2 && ceilingNumber <= 12);
  const needsScale = type && type !== 'dwg';
  const metres = Number(lengthM);
  const scaleOk =
    !needsScale || (line && lineLength(line.a, line.b) >= MIN_LINE_PX && metres >= 0.1 && metres <= 1000);
  const fileOk = file && type && !reading && (type === 'dwg' || image);
  const canContinue = [facilityId && levelOk && ceilingOk && fileOk, scaleOk, true][step];
  const facility = facilityList?.facilities.find((f) => f.id === facilityId);

  async function submit() {
    setSubmitError(null);
    setProgress(0);
    keyRef.current ??= newIdempotencyKey();
    const ext = type;
    const files = [{ name: `source.${ext}`, kind: 'source', blob: file, contentType: contentTypeOf(type) }];
    if (type === 'pdf') {
      files.push({ name: `page-${page}.png`, kind: 'source_image', blob: image.blob, contentType: 'image/png' });
    }
    const body = {
      facilityId,
      level: levelNumber,
      ...(ceilingNumber !== null && { ceilingHeightM: ceilingNumber }),
      inputType: type,
      originalName: file.name.slice(0, 200),
      bytes: file.size,
      ...(type === 'pdf' && { page, pageCount: pdf.pageCount }),
      ...(image && { imageWidth: image.width, imageHeight: image.height }),
      scale: needsScale ? { a: line.a, b: line.b, lengthM: metres } : null,
    };
    try {
      await submitDrawing({ body, files, idempotencyKey: keyRef.current, onProgress: setProgress });
      navigate('/plans', {
        state: {
          notice: `${facility?.name ?? 'Your gym'}, ${levelLabel(levelNumber)} was submitted. It is now waiting for review.`,
        },
      });
    } catch (err) {
      setSubmitError(err.message);
      setProgress(null);
    }
  }

  const busy = progress !== null;

  return (
    <>
      <header className="rv-header">
        <Link to="/plans" className="rv-back">
          <BackIcon size={16} />
          My plans
        </Link>
        <h1>Upload a plan</h1>
      </header>

      <div className="rv-content ow-upload">
        <ol className="ow-steps" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s} className={i === step ? 'current' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}>
              <span className="ow-step-num">{i + 1}</span>
              {s}
            </li>
          ))}
        </ol>

        {facilityError && !facilityList && (
          <div className="rv-error" role="alert">
            Your gyms could not be loaded: {facilityError.message}{' '}
            <button type="button" className="rv-button ghost" onClick={reload}>
              Try again
            </button>
          </div>
        )}

        {step === 0 && (
          <FileStep
            facilities={facilityList?.facilities ?? []}
            facilityId={facilityId}
            setFacilityId={setFacilityId}
            level={level}
            setLevel={setLevel}
            levelOk={levelOk}
            ceiling={ceiling}
            setCeiling={setCeiling}
            ceilingOk={ceilingOk}
            file={file}
            type={type}
            reading={reading}
            fileError={fileError}
            onChoose={choose}
          />
        )}

        {step === 1 && (
          <section className="rv-card" aria-labelledby="scale-heading">
            <h2 id="scale-heading" className="ow-section-title">
              Set scale
            </h2>
            {type === 'dwg' ? (
              <p className="muted">
                A DWG with embedded units skips this step. The reviewer reads its units from the drawing.
              </p>
            ) : (
              <>
                {pdf && pdf.pageCount > 1 && (
                  <label className="rv-field ow-inline-field">
                    <span>PDF page</span>
                    <select
                      value={page}
                      disabled={reading}
                      onChange={(e) => showPage(pdf.doc, Number(e.target.value))}
                    >
                      {[...Array(pdf.pageCount)].map((_, i) => (
                        <option key={i + 1} value={i + 1}>
                          {i + 1} of {pdf.pageCount}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {image && line && !reading ? (
                  <ScaleCanvas
                    src={image.url}
                    width={image.width}
                    height={image.height}
                    a={line.a}
                    b={line.b}
                    onChange={setLine}
                  />
                ) : (
                  <div className="rv-empty" role="status">
                    <span className="rv-spinner" aria-hidden="true" />
                    <p className="muted">Rendering the page…</p>
                  </div>
                )}
                <label className="rv-field ow-inline-field">
                  <span>Length of the drawn line, in metres</span>
                  <span className="ow-metres">
                    <input
                      type="number"
                      inputMode="decimal"
                      min="0.1"
                      max="1000"
                      step="0.01"
                      value={lengthM}
                      onChange={(e) => setLengthM(e.target.value)}
                      aria-describedby="scale-help"
                    />
                    <span aria-hidden="true">m</span>
                  </span>
                </label>
                <p id="scale-help" className="small muted">
                  Required for images and PDFs. A DWG with embedded units skips this step.
                </p>
              </>
            )}
          </section>
        )}

        {step === 2 && (
          <section className="rv-card" aria-labelledby="submit-heading">
            <h2 id="submit-heading" className="ow-section-title">
              Submit for review
            </h2>
            <dl className="rv-facts">
              <div>
                <dt>Facility</dt>
                <dd>{facility?.name}</dd>
              </div>
              <div>
                <dt>Level</dt>
                <dd>{levelLabel(levelNumber)}</dd>
              </div>
              {ceilingNumber !== null && (
                <div>
                  <dt>Ceiling height</dt>
                  <dd>{ceilingNumber.toFixed(2)} m</dd>
                </div>
              )}
              <div>
                <dt>File</dt>
                <dd>
                  {file.name} · {bytes(file.size)}
                </dd>
              </div>
              {pdf && (
                <div>
                  <dt>PDF page</dt>
                  <dd>
                    {page} of {pdf.pageCount}
                  </dd>
                </div>
              )}
              <div>
                <dt>Scale</dt>
                <dd>
                  {needsScale
                    ? `${metres} m over ${Math.round(lineLength(line.a, line.b))} px`
                    : 'From the DWG’s units'}
                </dd>
              </div>
            </dl>
            <p className="small muted ow-gap">
              A scanned raster reads to about ± 150 mm, a vector PDF to about ± 50 mm. Your original file is kept
              unchanged — reprocessing never overwrites it.
            </p>
            {busy && (
              <div className="ow-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label="Upload progress">
                <span style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
            )}
            {busy && <p className="small muted">Uploading… {Math.round(progress * 100)}%</p>}
            {submitError && (
              <p className="rv-error ow-gap" role="alert">
                {submitError}
              </p>
            )}
          </section>
        )}

        <div className="ow-step-actions">
          {step > 0 && (
            <button type="button" className="rv-button ghost" onClick={() => setStep(step - 1)} disabled={busy}>
              Back
            </button>
          )}
          <span className="spacer" />
          {step < 2 ? (
            <button type="button" className="rv-button primary" onClick={() => setStep(step + 1)} disabled={!canContinue}>
              Continue
            </button>
          ) : (
            <button type="button" className="rv-button primary" onClick={submit} disabled={busy}>
              <UploadIcon size={15} />
              {busy ? 'Submitting…' : 'Submit for review'}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

function FileStep({
  facilities,
  facilityId,
  setFacilityId,
  level,
  setLevel,
  levelOk,
  ceiling,
  setCeiling,
  ceilingOk,
  file,
  type,
  reading,
  fileError,
  onChoose,
}) {
  const inputId = useId();
  const [over, setOver] = useState(false);
  return (
    <section className="rv-card" aria-labelledby="file-heading">
      <h2 id="file-heading" className="ow-section-title">
        File
      </h2>
      <div className="ow-form-grid">
        <label className="rv-field">
          <span>Facility</span>
          <select value={facilityId} onChange={(e) => setFacilityId(e.target.value)} required>
            {facilities.length === 0 && <option value="">No gyms on this account</option>}
            {facilities.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <label className="rv-field">
          <span>Level {levelOk && <span className="muted">({levelLabel(Number(level))})</span>}</span>
          <input
            type="number"
            min="-5"
            max="200"
            step="1"
            value={level}
            onChange={(e) => setLevel(e.target.value)}
            aria-invalid={!levelOk}
            aria-describedby="level-help"
          />
          <span id="level-help" className="small muted">
            0 is the ground floor.
          </span>
        </label>
        <label className="rv-field">
          <span>Ceiling height, metres (optional)</span>
          <input
            type="number"
            inputMode="decimal"
            min="2"
            max="12"
            step="0.01"
            value={ceiling}
            onChange={(e) => setCeiling(e.target.value)}
            aria-invalid={!ceilingOk}
            placeholder="e.g. 3.2"
          />
          {!ceilingOk && <span className="small poor">Between 2 and 12 m.</span>}
        </label>
      </div>

      <label
        htmlFor={inputId}
        className={`ow-drop ${over ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          onChoose(e.dataTransfer.files?.[0] ?? null);
        }}
      >
        <FileIcon size={26} />
        {file ? (
          <span>
            <strong>{file.name}</strong>
            <span className="muted small ow-block">
              {bytes(file.size)} · {TYPE_NAMES[type]}
              {reading && ' · reading…'}
            </span>
          </span>
        ) : (
          <span>
            <strong>Choose a drawing</strong> or drop it here
            <span className="muted small ow-block">PDF, DWG, JPG or PNG, up to 50 MB</span>
          </span>
        )}
        <input
          id={inputId}
          type="file"
          className="sr-only"
          accept=".pdf,.dwg,.jpg,.jpeg,.png,application/pdf,image/png,image/jpeg"
          onChange={(e) => onChoose(e.target.files?.[0] ?? null)}
        />
      </label>
      {fileError && (
        <p className="rv-error ow-gap" role="alert">
          {fileError}
        </p>
      )}
    </section>
  );
}
