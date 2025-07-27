import React, {useState, useRef, useEffect, useCallback, useMemo} from "react";
import {parseIcyResponse} from "@music-metadata/icy";
import AudioMotionAnalyzer from "audiomotion-analyzer";
import "./IcyStreamPlayer.css";
import {FLACDecoderWebWorker} from "@wasm-audio-decoders/flac";
import {parseWebStream} from "music-metadata";
import Footer from "./Footer";

// ----- STREAM LIST -----
const streams = [
    {title: "Radio Paradise [FLAC]", url: "https://stream.radioparadise.com/flacm"},
    {title: "Radio Paradise - Mellow Mix [FLAC]", url: "https://stream.radioparadise.com/mellow-flacm"},
    {title: "Radio Paradise - Rock [FLAC]", url: "https://stream.radioparadise.com/rock-flacm"},
    {title: "Radio Paradise - Global Mix [FLAC]", url: "https://stream.radioparadise.com/global-flacm"},
    {title: "Radio Paradise - Beyond [FLAC]", url: "https://stream.radioparadise.com/beyond-flacm"},
    {title: "Radio Paradise - 2050 [FLAC]", url: "https://stream.radioparadise.com/radio2050-flacm"},
    {title: "Radio Paradise - Serenity [AAC]", url: "https://stream.radioparadise.com/serenity"},
    {title: "Radio Mast [MP3/128kb]", url: "https://audio-edge-kef8b.ams.s.radiomast.io/ref-128k-mp3-stereo"},
    {title: "RJR", url: "https://stream.rjrradio.fr/rjr-dab.flac"}
    // { title: "Mother Earth Radio [FLAC 24-bit/96kHz]", url: "https://motherearth.streamserver24.com/listen/motherearth/motherearth.flac-lo" },
  ]
;

let globalFlacDecoder = null;

/* ---- HELPER: Pretty format bitrate ---- */
function formatBitrate(bitrate) {
  if (!bitrate) return null;
  return (bitrate / 1000).toFixed(2) + " kbps";
}

/* ---- SUBCOMPONENT: ICY Metadata Table ---- */
function IcyRadioMetadataTable({tags}) {
  if (tags && tags.size > 0) {
    return (
      <div>
        <h2>ICY Radio Metadata</h2>
        <table className="info-table">
          <tbody>
          {[...tags.entries()]
            .filter(([key]) => !["metaint", "br"].includes(key))
            .map(([key, value]) => (
              <tr key={key}>
                <td>{key}</td>
                <td>
                  {key === "url" ? (
                    <a href={value} target="_blank" rel="noopener noreferrer">
                      {value}
                    </a>
                  ) : (
                    value
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return <div>No ICY Radio Metadata available.</div>;
}

/* ---- SUBCOMPONENT: Stream List ---- */
function StreamList({streams, onSelect, playingUrl}) {
  return (
    <div className="stream-list">
      <h2>Radio Stations</h2>
      {streams.map((stream) => (
        <div key={stream.url} className="stream-item flex items-center">
          <button
            aria-label={`Play ${stream.title}`}
            onClick={() => onSelect(stream)}
            disabled={playingUrl === stream.url}
            className={`px-3 py-1 rounded border ml-2 ${
              playingUrl === stream.url ? "bg-gray-300" : "bg-blue-600 text-white"
            }`}
          >
            {playingUrl === stream.url ? "Playing" : "Play"}
          </button>
          <span className="flex-1">{stream.title}</span>
        </div>
      ))}
    </div>
  );
}

// -------------------- MAIN COMPONENT --------------------
export default function IcyStreamPlayer() {
  // --- Refs ---

  const audioRef =   useRef(null);

  const analyzerRef = useRef({
    analyzer: null,
    audioCtx: null,
    gainNode: null,
    splitterNode: null,
  });

  /**
   * Object use for the currently played radio stream
   */
  const currentStreamRef = useRef({
    token: 0,
    cancel: true,
    abortController: null,
    streamReader: null,
    audioStream: null,
    sourceNode: null,
    pumpTask: null,

    // NEW: lock to sequence stream operations
    lock: Promise.resolve(),
  });

  // --- State ---
  const [icyTitle, setIcyTitle] = useState(null);
  const [stats, setStats] = useState(null);
  const [playingUrl, setPlayingUrl] = useState(null);
  const [volume, setVolume] = useState(1);
  const [icyTags, setIcyTags] = useState(new Map());
  const [formatMetadata, setFormatMetadata] = useState(null);


  // 🎧 Setup audio context & analyser ONCE
  useEffect(() => {

    if(analyzerRef.current.audioCtx) {
      return;
    }

    console.log('Setup audio context & analyser ONCE');

    const audioCtx = new AudioContext();

    // Create a splitter so we can send to both gain and analyzer
    const splitterNode = audioCtx.createChannelSplitter();

    const gainNode = audioCtx.createGain();
    splitterNode.connect(gainNode);
    // Connect gain to output (speaker)
    gainNode.connect(audioCtx.destination);

    const visEl = document.getElementById('visualizer');

    const audioMotion = new AudioMotionAnalyzer(visEl, {
      audioCtx: audioCtx,
      connectSpeakers: false,
      gradient: "steelblue",
      channelLayout: "dual-combined",
      fillAlpha: 0.1,
      frequencyScale: "bark",
      lineWidth: 2,
      height: 200,
      smoothing: 0.4,
      mode: 10,
      peakLine: false,
      peakHoldTime: 0,
      maxDecibels: -20
    });
    audioMotion.connectInput(splitterNode);

    analyzerRef.current = {
      audioCtx,
      audioMotion,
      gainNode,
      splitterNode
    };
  });

  // 🎧 Control volume
  useEffect(() => {
    if (analyzerRef.current?.gainNode) {
      analyzerRef.current.gainNode.gain.value = volume;
    }
    if (audioRef.current) {
      audioRef.current.volume = volume;
    }
  }, [volume]);

  // ==== STREAM STOP LOGIC ====
  const cancelCurrentStream = useCallback(async () => {

    const currentStream = currentStreamRef.current;
    currentStream.cancel = true;

    console.log('Cancel current radio stream...');

    if (currentStream.sourceNode) {
      console.log('Stop source node');
      try {
        currentStream.sourceNode.stop();
      } catch (e) {
        console.warn('Error stopping sourceNode:', e);
      }
      currentStream.sourceNode.disconnect();
      currentStream.sourceNode = null;
    }

    if (currentStream.streamReader) {
      console.log('Cancel audio stream reader...');
      try {
        // Will also cancel the stream it is reading from
        await currentStream.streamReader.cancel();
      } finally {
        console.log('Release audio stream lock.');
        currentStream.streamReader.releaseLock();
        currentStream.streamReader = null;
        console.log('Cancelled audio stream reader.');
      }
    }

    if (currentStream.abortController) {
      const abortController = currentStream.abortController;
      currentStream.abortController = null; // Avoid closing twice
      console.log('Abort fetches/decoding/readers controller...');
      await abortController.abort();
      console.log('Aborted fetches/decoding/readers controller.');
    }

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current.load(); // Unloads the stream
    }

    // Clear display outputs
    setStats(null);
    setIcyTitle(null);
    setFormatMetadata(null);
    setIcyTags(new Map());
    setPlayingUrl(null);

    if (currentStream.pumpTask) {
      console.log('Waiting for pump-task to completed...');
      await currentStream.pumpTask;
      currentStream.pumpTask = null;
      console.log('pump-task completed.');
    }
    console.log('Cancelled current radio stream completed.');
  }, []);

  // Clear on unmount
  useEffect(() => {
    return () => {
      cancelCurrentStream();
    };
  }, [cancelCurrentStream]);

  // ==== STREAM START LOGIC ====
  const startStream = useCallback(    async (stream) => {
      console.log('Start stream, cancelling previous...');
      await cancelCurrentStream();
      console.log(`setPlayingUrl ${stream.url}`);
      setPlayingUrl(stream.url);
    },
    [cancelCurrentStream]
  );

  // ==== MAIN LOGIC EFFECT ====
  useEffect(() => {
    if (!playingUrl) return;

    (async () => {
      setIcyTitle(null);
      setStats(null);
      setFormatMetadata(null);

      const currentStream = currentStreamRef.current;
      // Increase stream id, used to eliminate race conditions
      const token = ++currentStream.token;
      if (!currentStream.cancel) {
        throw new Error('Can not play a new radio-stream when the previous radio-stream is still playing');
      }
      currentStream.cancel = false;
      console.log(`Initialize new stream ${playingUrl} token=${token}`);

      // Dual fetch
      const abortController = new AbortController();
      currentStream.abortController = abortController;

      // Fetch for playback/icy/stream
      const streamPromise = fetch(playingUrl, {
        mode: 'cors',
        headers: {'Icy-MetaData': '1'},
        signal: abortController.signal
      }).catch(() =>
        fetch(playingUrl, {
          mode: 'cors',
          signal: abortController.signal
        })
      );

      // Fetch for metadata only (no headers)
      const metaPromise = fetch(playingUrl, {mode: 'cors'});

      // Await in parallel
      let response, metaResponse;
      try {
        [response, metaResponse] = await Promise.all([streamPromise, metaPromise]);
      } catch (err) {
        if (err.name === "AbortError") {
          // Fetch was aborted – do nothing
          return;
        } else {
          console.error("Error fetching stream:", err);
          return;
        }
      }
      if (currentStream.cancel) return;

      // ------ Parse ICY headers ------
      const icyTags = new Map();
      for (const [key, value] of response.headers.entries()) {
        if (key.startsWith('icy-')) icyTags.set(key.substring(4), value);
      }
      setIcyTags(icyTags);

      // ----- Parse & process the audio -----
      const audioStream = parseIcyResponse(response, ({metadata, stats}) => {
        if (metadata?.StreamTitle) setIcyTitle(metadata.StreamTitle);
        setStats(stats);
      });
      currentStream.audioStream = audioStream;

      // Get content-type for decoding mode
      const contentType = response.headers.get('content-type') || "";
      const isFlac = contentType.includes("ogg") || contentType.includes("flac");

      if (isFlac) {
        console.log('Start playing FLAC stream...');
        // ------- FLAC Decoding Pipeline ---------
        if (!globalFlacDecoder) {
          globalFlacDecoder = new FLACDecoderWebWorker();
          await globalFlacDecoder.ready;
        }
        await globalFlacDecoder.reset();

        const reader = audioStream.getReader();
        currentStream.streamReader = reader;
        analyzerRef.current.gainNode.gain.value = volume;

        const ctx = analyzerRef.current.audioCtx;

        let playbackTime = ctx.currentTime + 0.2;
        const pump = async () =>  {
          if (currentStream.cancel) return;
          console.log('pump...');
          const {done, value} = await reader.read();
          if (done || currentStream.token !== token || currentStream.cancel) return;
          try {
            try {
              const pcmData = await globalFlacDecoder.decode(value);
              if (currentStream.token !== token || currentStream.cancel) return;
              if (
                pcmData.channelData.length > 0 &&
                pcmData.channelData[0].length > 0
              ) {
                const {sampleRate, channelData} = pcmData;
                if (!ctx || ctx.state === 'closed') {
                  console.warn('AudioContext is closed. Skipping buffer processing.');
                  return;
                }
                const buffer = ctx.createBuffer(channelData.length, channelData[0].length, sampleRate);
                for (let ch = 0; ch < channelData.length; ch++) {
                  buffer.getChannelData(ch).set(channelData[ch]);
                }
                const source = ctx.createBufferSource();
                currentStream.sourceNode = source;
                source.buffer = buffer;
                source.connect(analyzerRef.current.splitterNode);
                source.start(playbackTime);
                playbackTime += buffer.duration;
              }
            } catch (e) {
              console.error("FLAC decoding/chunk error", e);
            }
          } finally {
            if (currentStream.token === token && !currentStream.cancel) {
              await pump();
            } else {
              console.log('Pump exiting, stream ended');
            }
          }
        };
        currentStream.pumpTask = pump(); // Start pump
      } else {
        // -------- NON-FLAC: HTML5 pipeline ----------
        const audio = audioRef.current;
        audio.src = playingUrl;
        audio.volume = volume;

        // Connect HTMLAudioElement to analyzer/gain/AudioContext
        const analyzer = analyzerRef.current;
        const sourceNode = analyzer.audioCtx.createMediaElementSource(audio);
        currentStream.sourceNode = sourceNode;
        const gainNode = analyzerRef.current.gainNode;
        gainNode.gain.value = volume;
        sourceNode.connect(analyzerRef.current.splitterNode);

        // Play!
        audio.play().catch(console.error);
      }

      // ---- Parse metadata from metaResponse (in parallel, doesn't block) -----
      parseWebStream(metaResponse.body)
        .then(({format}) => {
          setFormatMetadata({
            container: format.container,
            codec: format.codec,
            sampleRate: format.sampleRate,
            bitrate: format.bitrate
          });
        })
        .catch(() => setFormatMetadata(null));

    })();

    return () => {
      return cancelCurrentStream();
    };
  }, [playingUrl, volume, cancelCurrentStream]);

  // Memoized stats calculation
  const bitrate = useMemo(() => {
    if (!stats) return 0;
    const now = Date.now();
    const elapsedSec = stats.startTime
      ? (now - stats.startTime) / 1000
      : stats.audioBytesRead
        ? stats.audioBytesRead / (stats.bitrate || 128000)
        : 1;
    if (!elapsedSec || elapsedSec < 0.1) return 0;
    return ((stats.audioBytesRead * 8) / elapsedSec / 1000).toFixed(2);
  }, [stats]);

  // ------- RENDER -------
  return (
    <div className="container">
      <h1>ICY Radio Stream Player</h1>
      <div id="visualizer" className="w-full h-64 mb-4 md:block"/>
      <audio ref={audioRef} className="hidden" crossOrigin="anonymous"/>

      {/* VOLUME + STOP */}
      <div className="flex items-center mb-2">
        <label htmlFor="vol-slider" className="font-medium mr-2">
          Volume
        </label>
        <input
          id="vol-slider"
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          className="mr-4"
        />
        <button
          onClick={cancelCurrentStream}
          className="px-3 py-1 bg-red-600 text-white rounded"
          disabled={!playingUrl}
        >
          Stop
        </button>
      </div>

      {/* METADATA */}
      <div className="panel">
        <div className="panel display-mono">
          <h2>ICY Metadata</h2>
          <div>{icyTitle || "No StreamTitle yet"}</div>
        </div>
      </div>
      <div className="panel">
        <IcyRadioMetadataTable tags={icyTags}/>
      </div>

      {/* FORMAT + STATS */}
      <div className="panel-row">
        <div className="panel display-mono">
          <h2>Stream Format Info</h2>
          {formatMetadata ? (
            <table className="info-table">
              <tbody>
              <tr>
                <td>Container</td>
                <td>{formatMetadata.container}</td>
              </tr>
              <tr>
                <td>Codec</td>
                <td>{formatMetadata.codec}</td>
              </tr>
              <tr>
                <td>Sample Rate</td>
                <td>{formatMetadata.sampleRate} Hz</td>
              </tr>
              <tr>
                <td>Bitrate</td>
                <td>{formatBitrate(formatMetadata.bitrate)}</td>
              </tr>
              </tbody>
            </table>
          ) : (
            <p>Loading stream format info...</p>
          )}
        </div>
        <div className="panel display-mono">
          <h2>Stream Statistics</h2>
          {stats ? (
            <table className="info-table">
              <tbody>
              <tr>
                <td>Total Bytes Read:</td>
                <td>{stats.totalBytesRead}</td>
              </tr>
              <tr>
                <td>Audio Bytes Read:</td>
                <td>{stats.audioBytesRead}</td>
              </tr>
              <tr>
                <td>ICY Bytes Read:</td>
                <td>{stats.icyBytesRead}</td>
              </tr>
              <tr>
                <td>Bitrate (kbps):</td>
                <td>{bitrate}</td>
              </tr>
              </tbody>
            </table>
          ) : (
            <p>No stream statistics available.</p>
          )}
        </div>
      </div>

      {/* STATION LIST */}
      <StreamList streams={streams} onSelect={startStream} playingUrl={playingUrl}/>

      {/* Footer */}
      <Footer/>
    </div>
  );
}
