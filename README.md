# @music-metadata/icy demo


## Demo

[![icy-radio-stream-player.png](images/icy-radio-stream-player.png)](https://icy-radio-stream-player.netlify.app/)

## Architecture

```mermaid
flowchart TD
A[FLAC ICY Stream via fetch] --> B["ICY Metadata Parser<br/>(@music-metadata/icy)"]
B --> C["FLAC Stream Data<br/>(Without ICY blocks)"]
B --> M[Stream Metadata<br/>Artist, Title, Stats]

C --> D["FLAC Decoder in JS flac.js"]
D --> E["PCM Frames<br/>(Float32Array per channel)"]

E --> F[AudioBufferSourceNode]
F --> G[AudioContext]
G --> H[AudioMotionAnalyzer]
G --> I[Speakers / Output]

M -.-> J[Update UI<br/>with song title, bitrate, etc.]

style A fill:#dff,stroke:#339,stroke-width:1px
style B fill:#cfc,stroke:#393,stroke-width:1px
style D fill:#ffd,stroke:#996,stroke-width:1px
style G fill:#eef,stroke:#00c,stroke-width:1px
style H fill:#eef,stroke:#09c,stroke-width:1px
style I fill:#eee,stroke:#aaa
```

### Components used

- [music-metadata](https://github.com/Borewit/music-metadata)
- [@music-metadata/icy](https://github.com/Borewit/music-metadata-icy)
- [audiomotion-analyser](https://github.com/hvianna/audioMotion-analyzer)
- [@wasm-audio-decoders/flac](https://github.com/eshaz/wasm-audio-decoders)

## Available Scripts

In the project directory, you can run:

### `npm start`

Runs the app in the development mode.\
Open [http://localhost:3000](http://localhost:3000) to view it in your browser.

The page will reload when you make changes.\
You may also see any lint errors in the console.

### `npm test`

Launches the test runner in the interactive watch mode.\
See the section about [running tests](https://facebook.github.io/create-react-app/docs/running-tests) for more information.

### `npm run build`

Builds the app for production to the `build` folder.\
It correctly bundles React in production mode and optimizes the build for the best performance.

The build is minified and the filenames include the hashes.\
Your app is ready to be deployed!

See the section about [deployment](https://facebook.github.io/create-react-app/docs/deployment) for more information.

#