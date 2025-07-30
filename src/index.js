import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import IcyStreamPlayer from './IcyStreamPlayer';
import reportWebVitals from './reportWebVitals';

//localStorage.debug = '*';
localStorage.debug = 'music-metadata:*,icy-stream-player:*,-music-metadata:icy:*'

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <IcyStreamPlayer/>
  </React.StrictMode>
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
