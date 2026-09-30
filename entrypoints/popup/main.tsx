import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './style.css';

// The same page runs as the toolbar popup (fixed width) and as a full tab for opening files.
if (new URLSearchParams(window.location.search).get('view') === 'page') {
  document.body.classList.add('is-page');
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
