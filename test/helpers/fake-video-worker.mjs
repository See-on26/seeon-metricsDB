import fs from 'node:fs';
import { buildOutputPathMap } from '../../src/runner/output-paths.mjs';
import { readResultIdentity } from '../../src/runner/result-identity.mjs';
import { loadPipelineConfig } from '../../src/product/product-loader.mjs';

// video-worker.mjs 와 같은 메시지 규약으로 도는 가짜 워커. 제품 파이프라인 없이 videoId 에 든 낱말로 결과를 고른다.
// crash → 결과 없이 종료 코드 137, fail → failed 메시지 뒤 종료 1,
// stubborn → SIGTERM 을 무시하고 끝나지 않음, hang → 끝나지 않다가 SIGTERM 에 정리하고 종료 1,
// linger → hang 과 같되 SIGTERM·SIGHUP 뒤 정리에 LINGER_MS 가 걸림(정리 중에 신호가 더 오는 상황),
// slow → 영상 길이 1000ms 를 알린 뒤 500ms 지나 done, warn → 경고(VLM 시간 초과) 를 담아 done, 그 밖 → progress 뒤 mp3·JSON 을 쓰고 done.
// 반복 회차(job.repeatIndex)를 보는 낱말: flaky → 2회차만 failed, vary → 회차마다 AD 가 조금씩 다름(buildFakeAdList).
// 끝나지 않는 워커도 HANG_LIMIT_MS 뒤에는 스스로 끝내, 멈추기가 회귀해도 테스트 프로세스가 영영 남지 않게 한다.
const HANG_LIMIT_MS = 30000;
const LINGER_MS = 400;

// 실제 워커처럼 터미널 Ctrl-C 가 그룹에 보낸 SIGINT 로는 죽지 않는다. 멈춤은 부모가 SIGTERM 으로 보낸다.
process.on('SIGINT', () => console.log('[fake-worker] SIGINT 무시 — 멈춤은 부모가 SIGTERM 으로 보낸다'));

function hangUntilLimit() {
  setTimeout(() => {
    console.log('[fake-worker] 안전 상한 — 스스로 끝낸다');
    process.exit(99);
  }, HANG_LIMIT_MS);
}

const WARN_WARNING_LIST = [{ code: 'vlm_timeout', count: 4, message: 'VLM 호출 시간 초과 4/16건' }];
const FAKE_DROPPED_LIST = [{ text: '슬라이드 1', type: 'page_transition', eventMediaMs: 1000, reason: 'feature_off' }];

// 기본은 회차와 상관없이 같은 AD 2개. vary 면 2회차에만 묘사가 하나 더 나오고 3회차는 지시가 0.5초 늦게 다른 문장으로 나온다
// (3번 돌리면 AD 2·3·2개, 늘 나온 AD 2 · 가끔 나온 AD 1).
function buildFakeAdList(job) {
  const repeatIndex = job.repeatIndex ?? 1;
  const isVary = job.videoId.includes('vary');
  const adList = [
    { id: 'ad-001', type: 'deixis', text: isVary && repeatIndex === 3 ? '왼쪽 막대 그래프' : '빨간 막대 그래프', eventMediaMs: 9000, playedMediaMs: isVary && repeatIndex === 3 ? 10500 : 10000 },
    { id: 'ad-002', type: 'interpretation', text: '250은 연봉 조정 금액을 의미', eventMediaMs: 29000, playedMediaMs: 30000 },
  ];
  if (isVary && repeatIndex === 2) adList.push({ id: 'ad-003', type: 'visual_description', text: '여행 사진이 있는 페이지', eventMediaMs: 44000, playedMediaMs: 45000 });
  return adList;
}

function writeDoneOutput({ job, outDir, runConcurrency }) {
  const warningList = job.videoId.includes('warn') ? WARN_WARNING_LIST : [];
  const adList = buildFakeAdList(job);
  const pathMap = buildOutputPathMap({ outDir, outStem: job.outStem });
  fs.writeFileSync(pathMap.mp3Path, 'mp3');
  // AD 기록 JSON 과 같은 자리(video·seeonMeet·factory·repeat·config)에 작업 정보·코드 버전·결과 설정을 남긴다.
  const { versionMap, resultConfig } = readResultIdentity({ pipelineConfig: loadPipelineConfig().readPipelineConfig(process.env) });
  fs.writeFileSync(pathMap.jsonPath, JSON.stringify({
    schemaVersion: 1, isComplete: true,
    video: { videoId: job.videoId, file: job.filePath, durationMs: 60000, language: job.language }, ...versionMap,
    repeat: { index: job.repeatIndex ?? 1, count: job.repeatCount ?? 1 },
    config: { isPageTransitionIncluded: Boolean(job.isPageTransitionIncluded), resultConfig, runConcurrency },
    adList, droppedList: FAKE_DROPPED_LIST, incompleteReasonList: [], warningList,
  }));
  return {
    videoId: job.videoId, outStem: job.outStem, status: 'done', durationMs: 60000, processingMs: 1200, adCount: adList.length, droppedCount: FAKE_DROPPED_LIST.length, warningList,
    outputPathMap: { mp3: `${job.outStem}_SEEON_AD.mp3`, json: `${job.outStem}_SEEON_AD.json` },
  };
}

process.on('message', (message) => {
  if (message?.type !== 'run') return;
  const { job, outDir, runConcurrency = null } = message;
  console.log(`[fake-worker] ${job.videoId} 시작 · 언어 ${job.language} · 전환 ${job.isPageTransitionIncluded}`);
  if (job.videoId.includes('crash')) {
    setTimeout(() => process.exit(137), 10);
    return;
  }
  if (job.videoId.includes('fail') || (job.videoId.includes('flaky') && job.repeatIndex === 2)) {
    console.error(`[fake-worker] ${job.videoId} 실패`);
    process.send({ type: 'failed', message: `${job.videoId} 영상 스트림이 없다` }, () => process.exit(1));
    return;
  }
  if (job.videoId.includes('stubborn')) {
    process.on('SIGTERM', () => console.log('[fake-worker] SIGTERM 무시'));
    hangUntilLimit();
    return;
  }
  if (job.videoId.includes('linger')) {
    // 실제 워커처럼 터미널이 닫힐 때 그룹에 오는 SIGHUP 에도 정리하고 끝낸다.
    for (const signalName of ['SIGTERM', 'SIGHUP']) {
      process.on(signalName, () => {
        console.log(`[fake-worker] ${signalName} 받음 — 정리하고 끝낸다`);
        setTimeout(() => process.exit(1), LINGER_MS);
      });
    }
    hangUntilLimit();
    return;
  }
  if (job.videoId.includes('hang')) {
    process.on('SIGTERM', () => {
      console.log('[fake-worker] SIGTERM 받음 — 정리하고 끝낸다');
      process.exit(1);
    });
    hangUntilLimit();
    return;
  }
  if (job.videoId.includes('slow')) {
    process.send({ type: 'progress', videoId: job.videoId, videoTimeMs: 0, durationMs: 1000, adCount: 0 });
    setTimeout(() => process.send({ type: 'done', result: writeDoneOutput({ job, outDir, runConcurrency }) }, () => process.exit(0)), 500);
    return;
  }
  process.send({ type: 'progress', videoId: job.videoId, videoTimeMs: 10000, durationMs: 60000, adCount: 1 });
  process.send({ type: 'done', result: writeDoneOutput({ job, outDir, runConcurrency }) }, () => process.exit(0));
});
