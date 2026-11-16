import { Component, type ReactNode } from 'react';

/** Last-resort guard: never leave a blank projector. Reloads (state is persisted) after 5 s. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  componentDidCatch(err: Error) {
    console.error(err);
    setTimeout(() => location.reload(), 5000);
  }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="flex h-full items-center justify-center bg-night text-center">
        <div>
          <div className="font-display text-4xl">STEM FOR IMPACT 2026</div>
          <div className="mt-3 text-white/60">Recovering display… reloading in a few seconds.</div>
        </div>
      </div>
    );
  }
}
