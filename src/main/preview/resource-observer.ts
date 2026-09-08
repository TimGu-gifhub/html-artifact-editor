import type { WebContents } from 'electron';
import type { ResourceKind } from '../../contracts/resources.ts';
import { resourceKind, resourceTarget } from '../protocol/resource-diagnostics.ts';
import type { ResourceDiagnosticsCollector } from '../protocol/resource-diagnostics.ts';

// Read-only observation on the existing security debugger. CSP-blocked requests
// may never reach webRequest/protocol, so listen before loading user content.
export async function observeResourceFailures(contents: WebContents, sessionId: string, collector: ResourceDiagnosticsCollector) {
  const requests = new Map<string, Readonly<{ target: string; type: ResourceKind }>>();
  const debug = contents.debugger;
  const onMessage = (_event: unknown, method: string, value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const data = value as Record<string, unknown>;
    if (method === 'Audits.issueAdded') {
      const issue = data.issue as Record<string, unknown> | undefined;
      const details = issue?.details as Record<string, unknown> | undefined;
      const violation = details?.contentSecurityPolicyIssueDetails as Record<string, unknown> | undefined;
      if (issue?.code !== 'ContentSecurityPolicyIssue' || !violation || violation.isReportOnly !== false
        || typeof violation.violatedDirective !== 'string') return;
      const directive = violation.violatedDirective.split(' ')[0] ?? '';
      let kind: ResourceKind = directive.startsWith('script-') ? 'script' : directive.startsWith('style-') ? 'stylesheet'
        : directive === 'img-src' ? 'image' : directive === 'font-src' ? 'font' : directive === 'connect-src' ? 'fetch'
          : ['frame-src', 'child-src', 'frame-ancestors'].includes(directive) ? 'frame' : directive === 'media-src' ? 'media' : 'other';
      if (violation.contentSecurityPolicyViolationType === 'kURLViolation' && typeof violation.blockedURL === 'string') {
        if (/^wss?:/u.test(violation.blockedURL)) kind = 'websocket';
        collector.report(violation.blockedURL, kind, 'CSP_BLOCKED');
      } else if (['kInlineViolation', 'kEvalViolation', 'kWasmEvalViolation'].includes(violation.contentSecurityPolicyViolationType as string)) {
        collector.reportTarget(violation.contentSecurityPolicyViolationType === 'kInlineViolation' ? '[inline]' : '[eval]', kind, 'CSP_BLOCKED');
      }
      return;
    }
    const id = typeof data.requestId === 'string' && data.requestId.length <= 128 ? data.requestId : null;
    if (!id) return;
    if (method === 'Network.requestWillBeSent') {
      const request = data.request as Record<string, unknown> | undefined;
      if (!request || typeof request.url !== 'string') return;
      if (requests.size >= 256 && !requests.has(id)) { collector.truncate(); return; }
      let kind: ResourceKind;
      try { kind = resourceKind(data.type, request.url); } catch { kind = 'other'; }
      requests.set(id, { target: resourceTarget(request.url, sessionId), type: kind });
    } else if (method === 'Network.loadingFailed') {
      const request = requests.get(id); requests.delete(id);
      if (!request || data.canceled === true) return;
      const reason = data.blockedReason === 'csp' ? 'CSP_BLOCKED'
        : data.blockedReason || data.errorText === 'net::ERR_BLOCKED_BY_CLIENT' ? 'RESOURCE_BLOCKED' : 'RESOURCE_LOAD_FAILED';
      collector.reportTarget(request.target, request.type, reason);
    } else if (method === 'Network.loadingFinished') requests.delete(id);
  };
  const close = (): void => { debug.removeListener('message', onMessage); requests.clear(); contents.removeListener('destroyed', close); };
  debug.on('message', onMessage); contents.once('destroyed', close);
  try {
    await debug.sendCommand('Network.enable', { maxTotalBufferSize: 1024, maxResourceBufferSize: 1024, maxPostDataSize: 0 });
    await debug.sendCommand('Audits.enable');
    return close;
  } catch { close(); throw new Error('RESOURCE_DIAGNOSTICS_UNAVAILABLE'); }
}
