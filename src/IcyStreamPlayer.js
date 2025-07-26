import React, {useState, useRef, useEffect, useCallback, useMemo} from "react";
import {parseIcyResponse} from "@music-metadata/icy";
import AudioMotionAnalyzer from "audiomotion-analyzer";
import "./IcyStreamPlayer.css";
import {FLACDecoderWebWorker} from "@wasm-audio-decoders/flac";
import {parseWebStream} from "music-metadata";

// ----- STREAM LIST -----
const streams = [
    {title: "World/Eclectic Mix FLAC", url: "https://stream.radioparadise.com/eclectic-flacm"},
    {title: "Radio Paradise [FLAC]", url: "https://stream.radioparadise.com/flacm"},
    {title: "Radio Paradise - Mellow Mix [FLAC]", url: "https://stream.radioparadise.com/mellow-flacm"},
    {title: "Radio Paradise - Rock [FLAC]", url: "https://stream.radioparadise.com/rock-flacm"},
    {title: "Radio Paradise - Global Mix [FLAC]", url: "https://stream.radioparadise.com/global-flacm"},
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
          <span className="flex-1">{stream.title}</span>
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
        </div>
      ))}
    </div>
  );
}

// -------------------- MAIN COMPONENT --------------------
export default function IcyStreamPlayer() {
  // --- Refs ---
  const audioRef = useRef(null);
  const analyzerRef = useRef(null);
  const audioContextRef = useRef(null);
  const abortControllerRef = useRef(null);
  const streamReaderRef = useRef(null);
  const pumpRef = useRef(null);

  // --- State ---
  const [icyTitle, setIcyTitle] = useState(null);
  const [stats, setStats] = useState(null);
  const [playingUrl, setPlayingUrl] = useState(null);
  const [audioKey, setAudioKey] = useState(0);
  const [volume, setVolume] = useState(1);
  const [icyTags, setIcyTags] = useState(new Map());
  const [formatMetadata, setFormatMetadata] = useState(null);

  // ==== STREAM STOP LOGIC ====
  const stopCurrentStream = useCallback(async () => {
    // Abort fetches/decoding/readers
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;

    streamReaderRef.current?.cancel?.();
    streamReaderRef.current = null;

    pumpRef.current = null;

    if (analyzerRef.current) {
      analyzerRef.current.destroy();
      analyzerRef.current = null;
    }
    if (audioContextRef.current) {
      // This automatically disconnects nodes, too.
      await audioContextRef.current.close();
      audioContextRef.current = null;
    }
    setStats(null);
    setIcyTitle(null);
    setFormatMetadata(null);
    setIcyTags(new Map());
    setPlayingUrl(null);
  }, []);

  // Clear on unmount
  useEffect(() => {
    return () => {
      stopCurrentStream();
    };
    // eslint-disable-next-line
  }, []);

  // ==== STREAM START LOGIC ====
  const startStream = useCallback(
    async (stream) => {
      await stopCurrentStream();
      setAudioKey((k) => k + 1);
      setPlayingUrl(stream.url);
    },
    [stopCurrentStream]
  );

  // ==== MAIN LOGIC EFFECT ====
  useEffect(() => {
    if (!playingUrl) return;
    let cancelled = false;

    (async () => {
      setIcyTitle(null);
      setStats(null);
      setFormatMetadata(null);

      // Dual fetch
      const controller = new AbortController();
      abortControllerRef.current = controller;

      // Fetch for playback/icy/stream
      const streamPromise = fetch(playingUrl, {
        mode: 'cors',
        headers: {'Icy-MetaData': '1'},
        signal: controller.signal
      }).catch(() =>
        fetch(playingUrl, {
          mode: 'cors',
          signal: controller.signal
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
      if (cancelled) return;

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

      // ------ Setup ANALYZER and playback -----
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      audioContextRef.current = ctx;

      // Get content-type for decoding mode
      const contentType = response.headers.get('content-type') || "";
      const isFlac = contentType.includes("ogg") || contentType.includes("flac");

      // --- Analyzer setup helper
      const setupAudioMotion = (sourceNode) => {
        const visEl = document.getElementById('visualizer');
        if (!window.matchMedia("(min-width:768px)").matches) return;
        if (analyzerRef.current) {
          analyzerRef.current.setOptions({source: sourceNode, audioCtx: ctx});
        } else {
          analyzerRef.current = new AudioMotionAnalyzer(visEl, {
            source: sourceNode,
            audioCtx: ctx,
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
        }
      };

      if (isFlac) {
        // ------- FLAC Decoding Pipeline ---------
        if (!globalFlacDecoder) {
          globalFlacDecoder = new FLACDecoderWebWorker();
          await globalFlacDecoder.ready;
        }
        await globalFlacDecoder.reset();

        const reader = audioStream.getReader();
        streamReaderRef.current = reader;

        const gainNode = ctx.createGain();
        gainNode.gain.value = volume;

        const analyserNode = ctx.createAnalyser();
        gainNode.connect(analyserNode);
        analyserNode.connect(ctx.destination);
        setupAudioMotion(analyserNode);

        let playbackTime = ctx.currentTime + 0.2;
        pumpRef.current = async function pumpFlac() {
          if (cancelled) return;
          const {done, value} = await reader.read();
          if (done || cancelled) return;
          try {
            const pcmData = await globalFlacDecoder.decode(value);
            if (
              pcmData.channelData.length > 0 &&
              pcmData.channelData[0].length > 0
            ) {
              const {sampleRate, channelData} = pcmData;
              const buffer = ctx.createBuffer(channelData.length, channelData[0].length, sampleRate);
              for (let ch = 0; ch < channelData.length; ch++) {
                buffer.getChannelData(ch).set(channelData[ch]);
              }
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(gainNode);
              source.start(playbackTime);
              playbackTime += buffer.duration;
            }
            pumpRef.current && pumpRef.current();
          } catch (e) {
            console.error("FLAC decoding/chunk error", e);
            pumpRef.current && pumpRef.current();
          }
        };
        pumpRef.current();
      } else {
        // -------- NON-FLAC: HTML5 pipeline ----------
        const audio = audioRef.current;
        audio.src = playingUrl;
        audio.volume = volume;

        // Connect HTMLAudioElement to analyzer/gain/AudioContext
        const sourceNode = ctx.createMediaElementSource(audio);
        const gainNode = ctx.createGain();
        gainNode.gain.value = volume;
        sourceNode.connect(gainNode);
        gainNode.connect(ctx.destination);
        setupAudioMotion(gainNode);

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
      cancelled = true;
      stopCurrentStream();
    };
  }, [playingUrl, audioKey, volume, stopCurrentStream]);

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
      <h1>ICY Stream Player</h1>
      <div id="visualizer" className="w-full h-64 mb-4 md:block"/>
      <audio key={audioKey} ref={audioRef} className="hidden" crossOrigin="anonymous"/>

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
          onClick={stopCurrentStream}
          className="px-3 py-1 bg-red-600 text-white rounded"
          disabled={!playingUrl}
        >
          Stop
        </button>
      </div>

      {/* METADATA */}
      <div className="panel">
        <div className="panel">
          <h2>ICY Metadata</h2>
          <div>{icyTitle || "No StreamTitle yet"}</div>
        </div>
      </div>
      <div className="panel">
        <IcyRadioMetadataTable tags={icyTags}/>
      </div>

      {/* FORMAT + STATS */}
      <div className="panel-row">
        <div className="panel">
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
        <div className="panel">
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
    </div>
  );
}
