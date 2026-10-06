import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveProductPath } from '../src/product/product-paths.mjs';
import * as rendererConstantMap from '../src/session/renderer-constants.mjs';

const readProduct = (relativePath) => fs.readFileSync(resolveProductPath(relativePath), 'utf8');
const MAIN_JS = readProduct('src/renderer/app/main.js');
const SEGMENTER_JS = readProduct('src/renderer/core/trigger/asr-segmenter.js');
const METER_JS = readProduct('src/renderer/core/trigger/audio-meter.js');
const STREAM_DELAY_JS = readProduct('src/renderer/core/audio-renderer/stream-delay-source.js');
const DELAY_BUFFER_JS = readProduct('src/renderer/core/audio-renderer/delay-buffer.js');

const CHECK_LIST = [
  ['POINTING_SAMPLE_MS', MAIN_JS, /const POINTING_SAMPLE_MS = (\d+);/],
  ['POINTING_SAMPLE_WIDTH', MAIN_JS, /const POINTING_SAMPLE_WIDTH = (\d+);/],
  ['POINTING_SAMPLE_HEIGHT', MAIN_JS, /const POINTING_SAMPLE_HEIGHT = (\d+);/],
  ['POINTING_CROP_MARGIN', MAIN_JS, /const POINTING_CROP_MARGIN = ([\d.]+);/],
  ['POINTING_MOTION_DEBOUNCE_MS', MAIN_JS, /const POINTING_MOTION_DEBOUNCE_MS = (\d+);/],
  ['LOCAL_EMBED_MATCH_THRESHOLD', MAIN_JS, /const LOCAL_EMBED_MATCH_THRESHOLD = ([\d.]+);/],
  ['AUDIO_SPEAK_THRESHOLD', MAIN_JS, /const AUDIO_SPEAK_THRESHOLD = ([\d.]+);/],
  ['NARRATION_ECHO_TAIL_MS', MAIN_JS, /const NARRATION_ECHO_TAIL_MS = (\d+);/],
  ['ANNOTATION_SNAPSHOT_MIN_INTERVAL_MS', MAIN_JS, /const ANNOTATION_SNAPSHOT_MIN_INTERVAL_MS = (\d+);/],
  ['GAP_SAFETY_MS', MAIN_JS, /const GAP_SAFETY_MS = (\d+);/],
  ['SILENCE_TICK_MS', MAIN_JS, /\}, (\d+)\);\s*\n\s*\nasync function handleSilenceTrigger/],
  ['VAD_SAMPLE_MS', SEGMENTER_JS, /const VAD_SAMPLE_MS = (\d+);/],
  ['ASR_VOICE_LEVEL_THRESHOLD', SEGMENTER_JS, /const DEFAULT_VOICE_LEVEL_THRESHOLD = ([\d.]+);/],
  ['ASR_MIN_VOICED_MS', SEGMENTER_JS, /const DEFAULT_MIN_VOICED_MS = (\d+);/],
  ['ASR_SILENCE_CUT_MS', SEGMENTER_JS, /const DEFAULT_SILENCE_CUT_MS = (\d+);/],
  ['METER_FFT_SIZE', METER_JS, /fftSize = (\d+);/],
  ['STREAM_TIMESLICE_MS', STREAM_DELAY_JS, /const DEFAULT_TIMESLICE_MS = (\d+);/],
  ['DELAY_BUFFER_TICK_MS', DELAY_BUFFER_JS, /this\.setTimer\(\(\) => this\.tick\(\), (\d+)\)/],
];

for (const [name, source, pattern] of CHECK_LIST) {
  test(`${name} 는 제품 원본과 같다`, () => {
    const matched = source.match(pattern);
    assert.ok(matched, `${name} 을 원본에서 찾지 못했다 — 제품이 바뀌었으면 renderer-constants.mjs 와 대응표를 함께 고친다`);
    assert.equal(rendererConstantMap[name], Number(matched[1]));
  });
}

test('포인팅 로컬라이저 설정·전환 고지 source·deixis 기본 창·비교 연산자가 원본과 같다', () => {
  const matched = MAIN_JS.match(/new PointingLocator\(\{ rowCount: (\d+), colCount: (\d+), cellChangeThreshold: (\d+) \}\)/);
  assert.deepEqual(rendererConstantMap.POINTING_LOCATOR_OPTION_MAP,
    { rowCount: Number(matched[1]), colCount: Number(matched[2]), cellChangeThreshold: Number(matched[3]) });
  assert.match(MAIN_JS, new RegExp(`const CAPTION_SOURCE_TRANSITION = '${rendererConstantMap.CAPTION_SOURCE_TRANSITION}';`));
  const deixisMatched = MAIN_JS.match(/beforeMs: beforeMs \?\? (\d+), afterMs: afterMs \?\? (\d+),/);
  assert.ok(deixisMatched, 'deixis 기본 창을 원본에서 찾지 못했다');
  assert.deepEqual([rendererConstantMap.DEIXIS_FALLBACK_BEFORE_MS, rendererConstantMap.DEIXIS_FALLBACK_AFTER_MS],
    [Number(deixisMatched[1]), Number(deixisMatched[2])]);
  assert.match(MAIN_JS, /audioMeter\.getLevel\(\) > AUDIO_SPEAK_THRESHOLD/, '침묵 판정은 초과(>)');
  assert.match(SEGMENTER_JS, /this\.getVoiceLevel\(\) >= this\.voiceThreshold/, '조각 VAD 는 이상(>=)');
});
