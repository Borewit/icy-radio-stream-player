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
    {title: "RJR", url: "https://stream.rjrradio.fr/rjr-dab.flac"},
    {title: "Haarlem Shuffle", url: "https://stream.tbmp.nl:8000/haarlemshuffle.flac"},
    {title: "Mother Earth Radio [FLAC 24-bit/96kHz]", url: "https://motherearth.streamserver24.com/listen/motherearth/motherearth.flac-lo"},
    {title: "Radio Mast [MP3/128kb]", url: "https://audio-edge-kef8b.ams.s.radiomast.io/ref-128k-mp3-stereo"},
    {title: "Iowa Statewide Interoperability Communications System (ISICS)", url: "https://dsmrad.io/stream/isics-all"},
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
  // Define keys to prioritize and their order
  const priorityKeys = ["name", "description", "genre", "url"];

  // Prepare sorted entries: first priority keys (if present), then remaining keys
  const sortedEntries = (() => {
    if (!tags || tags.size === 0) return [];

    // Filter out unwanted keys first
    const filteredEntries = [...tags.entries()].filter(
      ([key]) => !["metaint", "br"].includes(key)
    );

    // Extract priority entries in order, if present
    const priorityEntries = [];
    for (const pkey of priorityKeys) {
      const foundIndex = filteredEntries.findIndex(([key]) => key === pkey);
      if (foundIndex !== -1) {
        priorityEntries.push(filteredEntries.splice(foundIndex, 1)[0]);
      }
    }

    // Remaining entries stay in their original order (or you could sort alphabetically if you want)
    return [...priorityEntries, ...filteredEntries];
  })();

  return (
    <div>
      <h2>ICY Radio Metadata</h2>
      {tags && tags.size > 0 ? (
        <table className="info-table">
          <tbody>
          {sortedEntries.map(([key, value]) => (
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
      ) : (
        <div>No ICY Radio Metadata available.</div>
      )}
    </div>
  );
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

  const audioRef = useRef(null);

  const analyzerRef = useRef({
    analyzer: null,
    audioCtx: null,
    gainNode: null,
    splitterNode: null
  });

  /**
   * Object use for the currently played radio stream
   */
  const currentStreamRef = useRef({
    cancel: true,
    abortController: null,
    streamReader: null,
    audioStream: null,
    bufferSources: [], // Track *all* PCM source nodes
    pumpTask: null
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

    if (analyzerRef.current.audioCtx) {
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
      gradient: "prism",
      channelLayout: "single",
      fftSize: 8192,
      fillAlpha: 0.5,
      frequencyScale: "log",
      lineWidth: 2,
      height: 250,
      smoothing: 0.1,
      mode: 10,
      peakLine: false,
      peakHoldTime: 0,
      maxDecibels: -20,
      showScaleX: true,
      showScaleY: true,
      showPeaks: false
    });
    audioMotion.connectInput(splitterNode);

    analyzerRef.current = {
      audioCtx,
      audioMotion,
      gainNode,
      splitterNode
    };
  }, );

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

    for (const sourceNode of currentStream.bufferSources) {
      console.log('Stop source node');
      try {
        if (sourceNode.stop) {
          sourceNode.stop();
        }
      } finally {
        sourceNode.disconnect();
        sourceNode.onended = null; // cleanup memory reference
      }
    }
    currentStream.bufferSources = [];

    if (currentStream.streamReader) {
      console.log('Cancel audio stream reader...');
      // Will also cancel the stream it is reading from
      const streamReader = currentStream.streamReader;
      await streamReader.cancel();
      streamReader.releaseLock();
      currentStream.streamReader = null;
      console.log('Cancelled audio stream reader.');
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

  // Add current stream index to state (null means no stream playing)
  const [currentStreamIndex, setCurrentStreamIndex] = useState(null);

  // Helper to start stream by index in your streams list
  const startStreamByIndex = useCallback(
    async (index) => {
      if (index < 0 || index >= streams.length) {
        console.warn("StartStreamByIndex: index out of bounds", index);
        return;
      }
      console.log('Start stream by index, cancelling previous...');
      await cancelCurrentStream();
      setCurrentStreamIndex(index);
      setPlayingUrl(streams[index].url);
    },
    [cancelCurrentStream]
  );

  // Override startStream to accept either stream or index for backward compatibility
  const startStream = useCallback(
    (streamOrIndex) => {
      if (typeof streamOrIndex === "number") {
        return startStreamByIndex(streamOrIndex);
      } else if (typeof streamOrIndex === "object" && streamOrIndex.url) {
        const index = streams.findIndex((s) => s.url === streamOrIndex.url);
        if (index !== -1) {
          return startStreamByIndex(index);
        }
      }
      console.warn("startStream: invalid argument", streamOrIndex);
    },
    [startStreamByIndex]
  );

  // Handlers for previous and next buttons
  const playPrevious = useCallback(() => {
    if (currentStreamIndex === null) {
      startStreamByIndex(0);
    } else {
      const newIndex = currentStreamIndex === 0 ? streams.length - 1 : currentStreamIndex - 1;
      startStreamByIndex(newIndex);
    }
  }, [currentStreamIndex, startStreamByIndex]);

  const playNext = useCallback(() => {
    if (currentStreamIndex === null) {
      startStreamByIndex(0);
    } else {
      const newIndex = currentStreamIndex === streams.length - 1 ? 0 : currentStreamIndex + 1;
      startStreamByIndex(newIndex);
    }
  }, [currentStreamIndex, startStreamByIndex]);

  // ==== MAIN LOGIC EFFECT ====
  useEffect(() => {
    if (!playingUrl) return;

    (async () => {
      setIcyTitle(null);
      setStats(null);
      setFormatMetadata(null);

      const currentStream = currentStreamRef.current;
      if (!currentStream.cancel) {
        throw new Error('Cannot play new stream while previous still playing');
      }

      currentStream.cancel = false;
      console.log(`Initialize new stream ${playingUrl}`);

      const abortController = new AbortController();
      currentStream.abortController = abortController;

      console.log('Fetch audio-stream response...');
      const icyAudioResponse = await fetch(playingUrl, {
        mode: 'cors',
        headers: { 'Icy-MetaData': '1' },
        signal: abortController.signal
      }).catch(() =>
        fetch(playingUrl, { mode: 'cors', signal: abortController.signal })
      );
      if (currentStream.cancel) return;

      const metaResponse = await fetch(playingUrl, { mode: 'cors', signal: abortController.signal });
      if (currentStream.cancel) return;

      const icyTags = new Map();
      for (const [key, value] of icyAudioResponse.headers.entries()) {
        if (key.startsWith('icy-')) icyTags.set(key.substring(4), value);
      }
      setIcyTags(icyTags);

      const audioStream = parseIcyResponse(icyAudioResponse, ({ metadata, stats }) => {
        if (metadata?.StreamTitle) setIcyTitle(metadata.StreamTitle);
        setStats(stats);
      });
      currentStream.audioStream = audioStream;

      const contentType = icyAudioResponse.headers.get('content-type') || "";
      const isFlac = contentType.includes("ogg") || contentType.includes("flac");

      const ctx = analyzerRef.current.audioCtx;

      if (ctx.state === "suspended") {
        console.debug('AudioContext suspended, resuming...');
        await ctx.resume();
      }

      if (isFlac) {
        if (!globalFlacDecoder) {
          globalFlacDecoder = new FLACDecoderWebWorker();
          await globalFlacDecoder.ready;
        }
        await globalFlacDecoder.reset();

        const reader = audioStream.getReader();
        currentStream.streamReader = reader;

        let playbackTime = ctx.currentTime + 0.3;

        const pump = async () => {
          if (currentStream.cancel) return;
          const { done, value } = await reader.read();
          if (done || currentStream.cancel) return;
          try {
            const pcmData = await globalFlacDecoder.decode(value);
            if (currentStream.cancel) return;
            if (
              pcmData.channelData.length > 0 &&
              pcmData.channelData[0].length > 0
            ) {
              const { sampleRate, channelData } = pcmData;
              if (!ctx || ctx.state === 'closed') {
                console.warn('AudioContext is closed. Skipping buffer processing.');
                return;
              }
              const buffer = ctx.createBuffer(channelData.length, channelData[0].length, sampleRate);
              for (let ch = 0; ch < channelData.length; ch++) {
                buffer.getChannelData(ch).set(channelData[ch]);
              }
              const source = ctx.createBufferSource();
              source.onended = () => {
                const idx = currentStream.bufferSources.indexOf(source);
                if (idx !== -1) currentStream.bufferSources.splice(idx, 1);
                source.onended = null; // cleanup memory reference
              };
              currentStream.bufferSources.push(source);
              source.buffer = buffer;
              source.connect(analyzerRef.current.splitterNode);

              playbackTime = Math.max(playbackTime, ctx.currentTime + 0.2);

              source.start(playbackTime);
              playbackTime += buffer.duration;
            }
          } catch (e) {
            console.error("FLAC decoding/chunk error", e);
          } finally {
            if (!currentStream.cancel) {
              await pump();
            } else {
              console.log('Pump exiting, stream ended');
            }
          }
        };
        currentStream.pumpTask = pump();
      } else {
        const audio = audioRef.current;
        audio.src = playingUrl;

        const analyzer = analyzerRef.current;
        const sourceNode = analyzer.audioCtx.createMediaElementSource(audio);
        currentStream.bufferSources.push(sourceNode);
        sourceNode.connect(analyzer.splitterNode);

        audio.play().catch(console.error);
      }

      parseWebStream(metaResponse.body)
        .then(({ format }) => {
          setFormatMetadata({
            container: format.container,
            codec: format.codec,
            sampleRate: format.sampleRate,
            bitsPerSample: format.bitsPerSample,
            bitrate: format.bitrate
          });
        })
        .catch(() => setFormatMetadata(null));

    })();

    return () => {
      return cancelCurrentStream();
    };
  }, [playingUrl, cancelCurrentStream]);

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

  // For toggle, derive playing state from playingUrl (or add isPlaying state)
  const isPlaying = Boolean(playingUrl);

  // Toggle play/pause (start first or stop current)
  const togglePlayStop = useCallback(async () => {
    if (isPlaying) {
      // Stop current stream
      await cancelCurrentStream();
    } else {
      // Start playing first stream in list
      if (streams.length > 0) {
        await startStream(streams[0]);
      }
    }
  }, [isPlaying, cancelCurrentStream, startStream]);

  // ------- RENDER -------
  return (
    <div className="container">
      <h1>ICY Radio Stream Player</h1>
      <div id="visualizer"/>
      <audio ref={audioRef} className="hidden" crossOrigin="anonymous"/>

      {/* Controls: Generic Play, Previous, Next */}
      <div className="controls">

        <button
          onClick={playPrevious}
          disabled={currentStreamIndex === null}
          aria-label="Play previous stream"
        >⏮
        </button>

        <button
          onClick={togglePlayStop}
          aria-label={isPlaying ? "Stop playback" : "Play first stream"}
        >{isPlaying ? "■" : "▶"}</button>

        <button
          onClick={playNext}
          disabled={currentStreamIndex === null}
          aria-label="Play next stream"
        >⏭
        </button>

        {/* Volume and stop controls */}
        <label htmlFor="vol-slider" className="font-medium mr-2 ml-6">
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
        <div className="volume-value">{(volume * 100).toFixed(0)}</div>
      </div>

      {/* METADATA */}

      <div className="panel display-mono">
        <h2>ICY Stream Metadata</h2>

        <table className="info-table">
          <tbody>
          <tr>
            <td>Title</td>
            <td>{icyTitle || "No StreamTitle yet"}</td>
          </tr>
          </tbody>
        </table>
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
              {formatMetadata.bitsPerSample && (
                <tr>
                  <td>Bits per sample</td>
                  <td>{formatMetadata.bitsPerSample}</td>
                </tr>
              )}
              {formatMetadata.bitrate && (
                <tr>
                  <td>Bitrate</td>
                  <td>{formatBitrate(formatMetadata.bitrate)}</td>
                </tr>
              )}
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
