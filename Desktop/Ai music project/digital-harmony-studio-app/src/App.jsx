import React from 'react';
import { BrowserRouter as Router, Routes, Route, Link } from 'react-router-dom';
import AudioWorkstation from './components/AudioWorkstation';

function App() {
  return (
    <Router>
      <nav style={{ padding: '16px', background: '#181818', color: '#D4AF37' }}>
        <Link to="/studio" style={{ color: '#D4AF37', textDecoration: 'none', fontWeight: 'bold', fontSize: '1.2rem' }}>
          Audio Workstation
        </Link>
      </nav>
      <Routes>
        <Route path="/studio" element={<AudioWorkstation />} />
        <Route path="*" element={<div style={{ padding: 32 }}>Welcome to Digital Harmony Studio! Go to <Link to="/studio">Audio Workstation</Link>.</div>} />
      </Routes>
    </Router>
  );
}

export default App;
