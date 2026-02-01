'use client';

/**
 * Error Boundary - catches client-side errors and displays them.
 * Helps diagnose "Application error" when running in Electron (no browser DevTools).
 */

import React from 'react';

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info);
  }

  render() {
    if (this.state.error) {
      const err = this.state.error;
      return (
        <div
          style={{
            padding: 24,
            fontFamily: 'monospace',
            fontSize: 12,
            background: '#0f172a',
            color: '#e2e8f0',
            minHeight: '100vh',
            overflow: 'auto',
          }}
        >
          <h2 style={{ color: '#ef4444', marginBottom: 16 }}>Application Error</h2>
          <p style={{ color: '#fbbf24', marginBottom: 8 }}>{err.message}</p>
          {err.stack && (
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                color: '#94a3b8',
              }}
            >
              {err.stack}
            </pre>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}
