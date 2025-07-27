import React from 'react';
import './IcyStreamPlayer.css'; // Keep if styles are scoped here

function Footer() {
  return (
    <footer
      style={{
        borderTop: '1px solid var(--color-muted)',
        paddingTop: '1rem',
        marginTop: '2rem',
        textAlign: 'center',
        fontSize: '0.85rem',
        color: 'var(--color-muted)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        gap: '0.5rem',
        flexWrap: 'wrap',
      }}
    >
      <a
        href="https://github.com/Borewit/icy-radio-stream-player"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.3rem',
          color: 'var(--color-text)',
          textDecoration: 'none',
        }}
      >
        <img
          src="/github-logo.svg"
          alt="GitHub logo"
          style={{ width: '18px', height: '18px', filter: 'invert(1)'}}
        />
        <span>Icy Radio Stream Player</span>
      </a>
    </footer>
  );
}

export default Footer;
