import React, { useEffect, useState } from 'react';
import { AdapterDiagnostics, generateDiagnosticReport } from '../../src/core/diagnostics/diagnostics';

interface DiagnosticsProps {
  diagnostics: AdapterDiagnostics;
  onClose: () => void;
  onCopied: (ok: boolean) => void;
}

const FAILED_PROBE_OUTCOMES = [
  'no_network_or_dom_signal',
  'probe_error',
  'element_not_connected',
  'probe_not_invoked',
  'probe_in_progress',
];

export default function Diagnostics({ diagnostics, onClose, onCopied }: DiagnosticsProps) {
  const [tab, setTab] = useState<'debug' | 'json'>('debug');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const report = generateDiagnosticReport(diagnostics);
  const d = diagnostics;
  const resolutions = d.fileCardResolutions ?? [];

  return (
    <div className="overlay">
      <div className="modal modal-lg" role="dialog" aria-modal="true" aria-labelledby="diag-title">
        <div className="modal-head">
          <h2 id="diag-title" className="modal-title">
            Diagnostics
          </h2>
          <div className="tabs" role="tablist" aria-label="Diagnostics view">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'debug'}
              className="tab"
              onClick={() => setTab('debug')}
            >
              Overview
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'json'}
              className="tab"
              onClick={() => setTab('json')}
            >
              Report
            </button>
          </div>
        </div>
        <p className="hint">Sanitized: no message text, no file contents.</p>

        {tab === 'debug' ? (
          <div className="diag-body">
            <div className="tags">
              <span className="tag">Platform: {d.adapterId}</span>
              <span className="tag">Termination: {d.crawlerTerminationReason}</span>
              <span className="tag">Scroll attempts: {d.crawlerScrollAttempts}</span>
              <span className="tag">Captured: {d.capturedMessageCount ?? d.detectedMessagesCount}</span>
              <span className={`tag ${d.beginningReached ? 'ok' : 'bad'}`}>
                Beginning reached: {String(d.beginningReached ?? false)}
              </span>
              {d.fileCardsDetected !== undefined && (
                <span className={`tag ${d.fileCardsUnresolved ? 'bad' : 'ok'}`}>
                  File cards: {d.fileCardsDetected} (resolved {d.fileCardsResolved ?? 0}, unresolved{' '}
                  {d.fileCardsUnresolved ?? 0})
                </span>
              )}
              {(d.resourceCardProbeAttempts !== undefined || (d.fileCardsDetected ?? 0) > 0) && (
                <span className="tag">
                  Probe attempts: {d.resourceCardProbeAttempts ?? 0} (completed {d.resourceCardProbeSuccesses ?? 0},
                  failed {d.resourceCardProbeFailures ?? 0})
                </span>
              )}
              {d.attachmentsExcludedByUser && <span className="tag">Files excluded by user</span>}
              {d.missingFilesAllowedByUser && <span className="tag warn">Missing files skipped by user</span>}
              {d.fileCaptureMethod && <span className="tag">File capture: {d.fileCaptureMethod}</span>}
              {d.scrollContainerVisible === false && <span className="tag bad">Scroll container hidden</span>}
              {d.unitTurnGaps && d.unitTurnGaps.length > 0 && (
                <span className="tag warn">Turn number gaps: {d.unitTurnGaps.slice(0, 5).join(', ')}</span>
              )}
              {d.crawlerError && <span className="tag bad">Crawler error: {d.crawlerError}</span>}
            </div>

            {resolutions.length > 0 && (
              <section>
                <h3 className="diag-title">
                  File capture ({resolutions.filter((r) => r.status === 'resolved').length} of {resolutions.length})
                </h3>
                <div className="diag-list">
                  {resolutions.map((r, idx) => (
                    <div key={idx} className="diag-card">
                      <div className="diag-card-head">
                        <span className="break">{r.filename}</span>
                        <span className={r.status === 'resolved' ? 'ok-text' : 'bad-text'}>{r.status}</span>
                      </div>
                      <div className="tags">
                        {r.method && <span className="tag">via {r.method}</span>}
                        {r.replaySource && <span className="tag">replay {r.replaySource}</span>}
                        {r.latePass && <span className="tag">late pass</span>}
                        {r.unrelatedContentIgnored ? (
                          <span className="tag">ignored {r.unrelatedContentIgnored} unrelated download(s)</span>
                        ) : null}
                        {r.attemptNumber !== undefined && <span className="tag">attempt {r.attemptNumber}</span>}
                        {r.byteSize !== undefined && <span className="tag">{r.byteSize} B</span>}
                        {r.mimeType && <span className="tag">{r.mimeType}</span>}
                        {r.reason && <span className="tag bad">reason: {r.reason}</span>}
                        {r.panelsStillOpen ? <span className="tag warn">preview left open</span> : null}
                        {r.durationMs !== undefined && <span className="tag">{r.durationMs} ms</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {d.resourceCardProbes && d.resourceCardProbes.length > 0 && (
              <section>
                <h3 className="diag-title">Resource card probes ({d.resourceCardProbes.length})</h3>
                <div className="diag-list">
                  {d.resourceCardProbes.map((probe, idx) => (
                    <div key={idx} className="diag-card">
                      <div className="diag-card-head">
                        <span className="break">{probe.filename}</span>
                        <span className={FAILED_PROBE_OUTCOMES.includes(probe.outcome || '') ? 'bad-text' : 'ok-text'}>
                          {probe.outcome}
                        </span>
                      </div>
                      <div className="tags">
                        <span className="tag">turn {probe.turnKey}</span>
                        <span className="tag">attempted {String(probe.attempted)}</span>
                        <span className="tag">completed {String(probe.completed ?? false)}</span>
                        {probe.stage && <span className="tag">stage {probe.stage}</span>}
                        {probe.notInvokedReason && (
                          <span className="tag warn">not invoked: {probe.notInvokedReason}</span>
                        )}
                        <span className="tag">connected {String(probe.elementWasConnected)}</span>
                        {probe.probeDurationMs !== undefined && <span className="tag">{probe.probeDurationMs} ms</span>}
                        {probe.mainWorld && (
                          <span className="tag">
                            main world: {probe.mainWorld.ready ? probe.mainWorld.method : 'not ready'} (
                            {probe.mainWorld.eventsReceived} events)
                          </span>
                        )}
                        <span className="tag">dialogs {probe.newModalsOrDialogs?.length ?? 0}</span>
                        <span className="tag">blob URLs {probe.blobUrlsCreated?.length ?? 0}</span>
                        <span className="tag">observed URLs {probe.observedUrls?.length ?? 0}</span>
                        {probe.restore && (
                          <span className="tag">
                            restore:{' '}
                            {probe.restore.dialogsStillOpen === 0
                              ? 'ui ok'
                              : `${probe.restore.dialogsStillOpen} dialog(s) still open`}
                            , scroll {probe.restore.scrollRestored ? 'ok' : 'off'}
                          </span>
                        )}
                        {probe.error && <span className="tag bad">error: {probe.error}</span>}
                      </div>
                      {probe.signals && probe.signals.length > 0 && (
                        <p className="diag-line">signals: {probe.signals.join(', ')}</p>
                      )}
                      {probe.mainWorld && probe.mainWorld.attempts.some((a) => !a.ok) && (
                        <p className="diag-line warn-text">
                          {probe.mainWorld.attempts.map((a) => `${a.method}: ${a.ok ? 'ok' : a.error}`).join(' | ')}
                        </p>
                      )}
                      {probe.observedUrls && probe.observedUrls.length > 0 && (
                        <div className="diag-urls">
                          {probe.observedUrls.map((u, uIdx) => (
                            <p key={uIdx} className="diag-line break">
                              <span className={u.fileRelated ? 'ok-text' : ''}>[{u.kind}]</span>{' '}
                              {u.method ? `${u.method} ` : ''}
                              {u.urlPattern || u.sanitizedUrl}
                              {u.status ? ` (${u.status})` : ''}
                              {u.contentType ? ` ${u.contentType}` : ''}
                              {u.contentDisposition ? ` CD: ${u.contentDisposition}` : ''}
                              {u.suppressed ? ' [suppressed]' : ''}
                              {u.offsetMs !== undefined ? ` +${u.offsetMs}ms` : ''}
                            </p>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section>
              <h3 className="diag-title">Scroll candidates ({d.crawlerCandidates?.length ?? 0})</h3>
              {d.crawlerCandidates && d.crawlerCandidates.length > 0 ? (
                <div className="diag-list">
                  {d.crawlerCandidates.map((c) => (
                    <div key={c.index} className="diag-card">
                      <div className="diag-card-head">
                        <span>
                          #{c.index} &lt;{c.tagName}
                          {c.id ? `#${c.id}` : ''}&gt;
                        </span>
                        <span>score {c.probeScore ?? 0}</span>
                      </div>
                      {c.className && <p className="diag-line break">class: {c.className}</p>}
                      <div className="tags">
                        <span className="tag">
                          scroll {c.scrollHeight}x{c.clientHeight}
                        </span>
                        <span className="tag">scrollTop {c.scrollTop}</span>
                        <span className="tag">overflowY {c.computedOverflowY || 'default'}</span>
                        <span className="tag">position {c.computedPosition || 'static'}</span>
                        <span className="tag">hasTurnKey {String(c.containsTurnKey)}</span>
                        <span className="tag">hasVirtual {String(c.containsVirtualizedContent)}</span>
                      </div>
                      {c.stableAttributes && Object.keys(c.stableAttributes).length > 0 && (
                        <div className="tags">
                          {Object.entries(c.stableAttributes).map(([k, v]) => (
                            <span key={k} className="tag">
                              {k}={v}
                            </span>
                          ))}
                        </div>
                      )}
                      {c.probeResult && <p className="diag-line">probe: {c.probeResult}</p>}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="hint">No candidates recorded.</p>
              )}
            </section>

            <section>
              <h3 className="diag-title">Scroll iterations ({d.iterationLogs?.length ?? 0})</h3>
              {d.iterationLogs && d.iterationLogs.length > 0 ? (
                <div className="diag-list">
                  {d.iterationLogs.map((it) => (
                    <div key={it.iteration} className="diag-card">
                      <div className="diag-card-head">
                        <span>
                          Iteration {it.iteration} (candidate {it.selectedCandidateIndex})
                        </span>
                        <span className={(it.newMessagesDiscovered ?? 0) > 0 ? 'ok-text' : 'bad-text'}>
                          +{it.newMessagesDiscovered ?? 0} msgs
                        </span>
                      </div>
                      <div className="tags">
                        <span className="tag">
                          scrollTop {it.scrollTopBefore} to {it.requestedScrollTop} (immediate{' '}
                          {it.scrollTopImmediatelyAfter}, settled {it.scrollTopAfterSettling})
                        </span>
                        <span className="tag">
                          scrollHeight {it.scrollHeightBefore} to {it.scrollHeightAfter} (client {it.clientHeight})
                        </span>
                        <span className="tag">mutations {it.mutationCountObserved}</span>
                        <span className="tag">stalls {it.stallCount}</span>
                      </div>
                      <p className="diag-line break">turnKeys before: [{it.visibleTurnKeysBefore.join(', ')}]</p>
                      <p className="diag-line break">turnKeys after: [{it.visibleTurnKeysAfter.join(', ')}]</p>
                      {it.visibleUnitKeysBefore && it.visibleUnitKeysBefore.length > 0 && (
                        <>
                          <p className="diag-line break">unitKeys before: [{it.visibleUnitKeysBefore.join(', ')}]</p>
                          <p className="diag-line break">unitKeys after: [{it.visibleUnitKeysAfter?.join(', ') || ''}]</p>
                        </>
                      )}
                      {it.candidateSwitchReason && (
                        <p className="diag-line warn-text">switch: {it.candidateSwitchReason}</p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="hint">No iterations recorded.</p>
              )}
            </section>
          </div>
        ) : (
          <pre className="diag-pre">{report}</pre>
        )}

        <div className="modal-actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              navigator.clipboard.writeText(report).then(
                () => onCopied(true),
                () => onCopied(false)
              );
            }}
          >
            Copy report
          </button>
          <button type="button" className="btn primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
