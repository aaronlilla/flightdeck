import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import favicon from '../../brand/flightdeck-favicon.png';

// Set from here rather than a <link> in index.html: Vite writes an HTML-referenced
// icon to disk as a file, and the servers read every static file as text.
const icon = document.createElement('link');
icon.rel = 'icon';
icon.type = 'image/png';
icon.href = favicon;
document.head.append(icon);

const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing #root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
