import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Minimal error boundary: a render throw inside a panel shows a recoverable
 * message instead of blanking the whole app to white. Wrap the panels region
 * (not the shell), so the header + reload survive a panel crash.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ui] render error:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (error) {
      return (
        <div className="panel" role="alert" style={{ margin: 12 }}>
          <div className="panel-title" style={{ color: 'var(--error-fg)' }}>Something broke</div>
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12, margin: '8px 0' }}>{error.message}</pre>
          <button className="text-button" onClick={() => location.reload()}>Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}
