import React from 'react';
import { createRoot } from 'react-dom/client';
import AppPanel from './AppPanel.js';

const rootElement = document.getElementById('root');

if (rootElement !== null) {
  const root = createRoot(rootElement);

  root.render(
    <AppPanel isLoggedIn={true} serverId="local-preview" />
  );
}
