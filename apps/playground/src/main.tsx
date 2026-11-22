import '@software-factory/design-system/styles.css';
import './playground.css';
import { ToastProvider } from '@software-factory/design-system';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';

createRoot(document.getElementById('root')!).render(<StrictMode><ToastProvider><App /></ToastProvider></StrictMode>);
