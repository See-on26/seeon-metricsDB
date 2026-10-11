// main.js·코어 클래스 안의 비공개 상수. 원본과 같은지는 test/renderer-constants.test.mjs 가 원본 글자를 읽어 확인한다.
// 행 번호는 seeon-meet origin/production 990e7a3 기준.
export const POINTING_SAMPLE_MS = 400;              // main.js:536
export const POINTING_SAMPLE_WIDTH = 480;           // main.js:537
export const POINTING_SAMPLE_HEIGHT = 270;          // main.js:538
export const POINTING_CROP_MARGIN = 0.12;           // main.js:539
export const POINTING_MOTION_DEBOUNCE_MS = 800;     // main.js:540
export const POINTING_LOCATOR_OPTION_MAP = { rowCount: 18, colCount: 32, cellChangeThreshold: 4 }; // main.js:552
export const LOCAL_EMBED_MATCH_THRESHOLD = 0.02;    // main.js:554
export const AUDIO_SPEAK_THRESHOLD = 0.02;          // main.js:920 (레벨 > 임계)
export const NARRATION_ECHO_TAIL_MS = 500;          // main.js:921
export const ANNOTATION_SNAPSHOT_MIN_INTERVAL_MS = 2000; // main.js:988
export const CAPTION_SOURCE_TRANSITION = 'page-transition'; // main.js:1171
export const GAP_SAFETY_MS = 2000;                  // main.js:1481
export const SILENCE_TICK_MS = 100;                 // main.js:1747
export const DEIXIS_FALLBACK_BEFORE_MS = 60000;     // main.js:1050
export const DEIXIS_FALLBACK_AFTER_MS = 2000;       // main.js:1050
export const VAD_SAMPLE_MS = 100;                   // core/trigger/asr-segmenter.js:4
export const ASR_VOICE_LEVEL_THRESHOLD = 0.02;      // asr-segmenter.js:5 (레벨 >= 임계)
export const ASR_MIN_VOICED_MS = 200;               // asr-segmenter.js:6
export const ASR_SILENCE_CUT_MS = 400;              // asr-segmenter.js:8
export const METER_FFT_SIZE = 512;                  // core/trigger/audio-meter.js:37
// AudioContext 기본 샘플레이트(장치 값). 제품 상수가 아니라 macOS 기본 48kHz 를 가정한다.
export const METER_SAMPLE_RATE = 48000;
export const STREAM_TIMESLICE_MS = 200;             // core/audio-renderer/stream-delay-source.js:4
export const DELAY_BUFFER_TICK_MS = 250;            // core/audio-renderer/delay-buffer.js:63
