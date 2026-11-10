import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AccountProvider } from './AccountPanel';
import { CommandProvider } from './commands';
import './style.css';
import './apple.css';
import './score-style.css';
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><CommandProvider><AccountProvider><App /></AccountProvider></CommandProvider></React.StrictMode>);

import './motion.css';
