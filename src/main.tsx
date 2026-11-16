import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/archivo-black/400.css';
import '@fontsource/space-grotesk/400.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/700.css';
import '@fontsource/jetbrains-mono/700.css';
import '@fontsource/jetbrains-mono/800.css';
import './index.css';
import { ErrorBoundary } from './ErrorBoundary';
import PublicCountdownDisplay from './display/PublicCountdownDisplay';
import OrganizerDashboard from './admin/OrganizerDashboard';
import { initStore } from './lib/store';

const isAdmin = location.pathname.replace(/\/+$/, '').endsWith('/admin');
const isPreview = new URLSearchParams(location.search).has('preview');
initStore(isAdmin ? 'admin' : isPreview ? 'preview' : 'display');
document.title = isAdmin ? 'Organizer Panel · STEM FOR IMPACT 2026' : 'STEM FOR IMPACT 2026 · Live Countdown';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>{isAdmin ? <OrganizerDashboard /> : <PublicCountdownDisplay />}</ErrorBoundary>
  </React.StrictMode>,
);
