import '@software-factory/design-system/styles.css';
import './web.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
