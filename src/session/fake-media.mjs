import { readWavInfo } from '../media/wav.mjs';
import { STREAM_TIMESLICE_MS } from './renderer-constants.mjs';

// 지연 재생 <audio> 대역. currentTime 을 가상 시계·배속·멈춤으로 적분하고, 상태가 바뀔 때마다 알린다.
export class FakeMediaElement {
  constructor({ clock, getMaxMediaMs = () => Infinity, onChange = () => {} }) {
    this.clock = clock;
    this.getMaxMediaMs = getMaxMediaMs;
    this.onChange = onChange;
    this.baseMediaMs = 0;
    this.anchorElapsedMs = null;
    this.rate = 1.0;
    this.paused = true;
    this.ended = false;
    this.volume = 1.0;
    this.muted = false;
    this.style = {};
    this.endTimer = null;
  }

  readMediaMs() {
    if (this.paused || this.anchorElapsedMs === null) return this.baseMediaMs;
    const mediaMs = this.baseMediaMs + (this.clock.elapsedMs() - this.anchorElapsedMs) * this.rate;
    return Math.min(mediaMs, this.getMaxMediaMs());
  }

  get currentTime() { return this.readMediaMs() / 1000; }

  set currentTime(seconds) {
    this.rebase();
    this.baseMediaMs = seconds * 1000;
    this.scheduleEnd();
  }

  get playbackRate() { return this.rate; }

  set playbackRate(rate) {
    if (rate === this.rate) return;
    this.rebase();
    this.rate = rate;
    this.scheduleEnd();
    if (!this.paused) this.emit('rate');
  }

  // 브라우저는 끝난 요소에 play 하면 처음부터 다시 튼다. 지연 재생은 끝에서 멈춰 있어야 하므로 무시한다.
  play() {
    if (this.paused && !this.ended) {
      this.paused = false;
      this.anchorElapsedMs = this.clock.elapsedMs();
      this.scheduleEnd();
      this.emit('play');
    }
    return Promise.resolve();
  }

  pause() {
    if (this.paused) return;
    this.rebase();
    this.paused = true;
    this.anchorElapsedMs = null;
    this.clearEndTimer();
    this.emit('pause');
  }

  remove() {}

  rebase() {
    if (this.paused || this.anchorElapsedMs === null) return;
    this.baseMediaMs = this.readMediaMs();
    this.anchorElapsedMs = this.clock.elapsedMs();
  }

  clearEndTimer() {
    if (this.endTimer !== null) this.clock.clearTimeout(this.endTimer);
    this.endTimer = null;
  }

  // 배속이 0 이하면 끝에 닿지 않는다. 그대로 나누면 무한대 지연이 Node 규칙대로 1ms 로 바뀌어 바로 끝나 버린다.
  scheduleEnd() {
    this.clearEndTimer();
    const maxMediaMs = this.getMaxMediaMs();
    if (this.paused || !Number.isFinite(maxMediaMs) || this.rate <= 0) return;
    const remainingMs = Math.max(0, (maxMediaMs - this.readMediaMs()) / this.rate);
    this.endTimer = this.clock.setTimeout(() => this.handleEnd(), remainingMs);
  }

  handleEnd() {
    this.endTimer = null;
    this.baseMediaMs = this.getMaxMediaMs();
    this.paused = true;
    this.anchorElapsedMs = null;
    this.ended = true;
    this.emit('ended');
  }

  emit(kind) {
    this.onChange({ kind, atElapsedMs: this.clock.elapsedMs(), mediaMs: this.readMediaMs(), rate: this.rate });
  }
}

// StreamDelaySource(stream-delay-source.js:25-171) 대역. MSE 버퍼 끝 대신 영상 시각을 200ms timeslice 로 내린 값을 라이브 끝으로 쓴다.
// 영상이 끝나면 꼬리 모드로 라이브 끝을 영상 길이에 묶지 않고 가상 시각대로 계속 흘린다. 실험실은 끝난 플레이어를 계속 캡처해
// 라이브 끝이 계속 자라므로 밀린 원음이 1배속으로 이어진다. 끝 순간 초과 지연이 뛰면 끝 직후 캡션이 버려지고 끝 구간이 빨라진다.
// 지연 재생 요소는 원음이 끝나는 영상 길이에서 끝난다. 끝난 뒤에는 라이브 끝을 그 순간 값으로 묶는다. 실험실 지연 재생은 끝 뒤
// 캡처분을 이어 틀어 초과 지연이 그대로인데, 공장 요소는 멈춰 있어 라이브 끝만 흐르면 초과 지연이 끝없이 커지고 끝 구간 캡션이
// 조금만 늦어도 excess_delay 로 버려진다(실험실은 튼다).
export class FakeDelaySource {
  constructor({ clock, getVideoTimeMs, mediaDurationMs, targetDelayMs, timesliceMs = STREAM_TIMESLICE_MS, onElementChange = () => {} }) {
    this.clock = clock;
    this.getVideoTimeMs = getVideoTimeMs;
    this.mediaDurationMs = mediaDurationMs;
    this.targetDelayMs = targetDelayMs;
    this.timesliceMs = timesliceMs;
    this.onElementChange = onElementChange;
    this.element = null;
    this.recorderStartVideoTimeMs = 0;
    this.isTailMode = false;
    this.endedLiveTimeMs = null;
  }

  start() {
    this.recorderStartVideoTimeMs = this.getVideoTimeMs();
    this.endedLiveTimeMs = null;
    this.element = new FakeMediaElement({
      clock: this.clock,
      getMaxMediaMs: () => this.mediaDurationMs - this.recorderStartVideoTimeMs,
      onChange: (event) => {
        if (event.kind === 'ended') this.endedLiveTimeMs = this.getLiveTimeMs();
        this.onElementChange({ ...event, mediaMs: event.mediaMs + this.recorderStartVideoTimeMs });
      },
    });
    return this.element;
  }

  getElement() { return this.element; }

  getLiveTimeMs() {
    if (this.endedLiveTimeMs !== null) return this.endedLiveTimeMs;
    const capturedMs = this.isTailMode ? this.getVideoTimeMs() : Math.min(this.getVideoTimeMs(), this.mediaDurationMs);
    const recordedMs = Math.max(0, capturedMs - this.recorderStartVideoTimeMs);
    return Math.floor(recordedMs / this.timesliceMs) * this.timesliceMs + this.recorderStartVideoTimeMs;
  }

  getPlayheadMs() {
    if (!this.element) return this.recorderStartVideoTimeMs;
    return this.element.currentTime * 1000 + this.recorderStartVideoTimeMs;
  }

  isReady() { return Boolean(this.element); }

  getDriftMs() { return 0; }

  enterTailMode() { this.isTailMode = true; }

  stop() {
    this.element?.pause();
    this.element = null;
  }
}

const createFakeNode = () => ({ connect() {}, disconnect() {} });

class FakeBufferSource {
  constructor({ context }) {
    this.context = context;
    this.buffer = null;
    this.onended = null;
    this.timer = null;
    this.startedAtElapsedMs = null;
  }

  connect() {}

  disconnect() {}

  // 제품은 currentTime + 20ms 에 시작을 예약한다(caption-narrator.js:136-137). 그 시각에 시작·길이만큼 뒤에 끝을 알린다.
  start(whenSec = 0) {
    const { clock } = this.context;
    const startDelayMs = Math.max(0, (whenSec - this.context.currentTime) * 1000);
    const durationMs = (this.buffer?.duration || 0) * 1000;
    this.timer = clock.setTimeout(() => {
      this.startedAtElapsedMs = clock.elapsedMs();
      this.context.onSourceStart({ atElapsedMs: this.startedAtElapsedMs, durationMs });
      this.timer = clock.setTimeout(() => {
        this.timer = null;
        this.context.onSourceStop({ atElapsedMs: clock.elapsedMs(), isEnded: true });
        this.onended?.();
      }, durationMs);
    }, startDelayMs);
  }

  // 소리가 나는 중에 멈춘 것만 끝을 알린다. 시작 전(20ms 앞당김 사이)이나 이미 끝난 뒤의 stop 은 출력에 남는 것이 없다.
  stop() {
    const isSounding = this.startedAtElapsedMs !== null && this.timer !== null;
    if (this.timer !== null) this.context.clock.clearTimeout(this.timer);
    this.timer = null;
    if (isSounding) this.context.onSourceStop({ atElapsedMs: this.context.clock.elapsedMs(), isEnded: false });
  }
}

// CaptionNarrator 에 createAudioContext 로 주입하는 AudioContext 대역. 소리 대신 재생 시작·끝 시각을 알린다.
export class FakeAudioContext {
  constructor({ clock, onSourceStart = () => {}, onSourceStop = () => {} }) {
    this.clock = clock;
    this.onSourceStart = onSourceStart;
    this.onSourceStop = onSourceStop;
    this.createdAtElapsedMs = clock.elapsedMs();
    this.state = 'running';
    this.destination = createFakeNode();
  }

  get currentTime() { return (this.clock.elapsedMs() - this.createdAtElapsedMs) / 1000; }

  resume() { this.state = 'running'; return Promise.resolve(); }

  close() { this.state = 'closed'; return Promise.resolve(); }

  createAnalyser() { return { ...createFakeNode(), fftSize: 2048 }; }

  createGain() { return { ...createFakeNode(), gain: { value: 1 } }; }

  createPanner() {
    return { ...createFakeNode(), panningModel: '', distanceModel: '', positionX: { value: 0 }, positionY: { value: 0 }, positionZ: { value: 0 } };
  }

  createMediaStreamSource() { return createFakeNode(); }

  createBufferSource() { return new FakeBufferSource({ context: this }); }

  async decodeAudioData(arrayBuffer) {
    const info = readWavInfo(new Uint8Array(arrayBuffer));
    if (!info) throw new Error('WAV 가 아니라 길이를 읽지 못했다');
    return { duration: info.durationMs / 1000 };
  }
}

// 캡처 스트림 대역. 오디오 트랙이 없으니 CaptionNarrator 는 파형 탭을 만들지 않는다(caption-narrator.js:58-65).
export function createFakeCaptureStream() {
  return { getAudioTracks: () => [], getVideoTracks: () => [] };
}
