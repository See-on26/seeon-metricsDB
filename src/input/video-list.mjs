// src/input/video-list.mjs
import fs from 'node:fs';
import path from 'node:path';
import { loadPipelineConfig } from '../product/product-loader.mjs';

export const VIDEO_EXTENSION_LIST = ['.mp4', '.mov', '.mkv', '.webm'];

// 실행 기록(manifest.json·summary.txt·repeat-summary.json, 그 임시 파일) 이름과 겹치지 않게 앞에 video- 를 붙일 이름.
// 점으로 시작하는 이름도 붙인다. 숨김 파일이 되고 실행 잠금(.factory.lock, 그 임시 파일)과 겹칠 수 있다.
const RESERVED_STEM_LIST = ['manifest', 'summary', 'repeat-summary'];
// 영상마다 <이름>.log·<이름>_SEEON_AD.mp3·<이름>_SEEON_AD.json 파일과 <이름>/ 작업 폴더가 생긴다.
// 이 끝말로 끝나는 이름을 그대로 쓰면 그 작업 폴더가 다른 영상의 출력 파일과 같은 경로가 되므로 끝말의 점을 _ 로 바꾼다.
const OUTPUT_SUFFIX_PATTERN = /(\.log|_SEEON_AD\.mp3|_SEEON_AD\.json)$/i;

// 출력 파일·작업 폴더 이름으로 쓰므로 경로 문자를 바꾸고, 점만 있는 이름('..')은 출력 폴더를 벗어나지 않게 막는다.
function toOutStem(name) {
  const stem = String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  if (/^\.*$/.test(stem)) return 'video';
  if (stem.startsWith('.') || RESERVED_STEM_LIST.includes(stem.split('.')[0].toLowerCase())) return `video-${stem}`;
  return stem.replace(OUTPUT_SUFFIX_PATTERN, (suffix) => suffix.replace('.', '_'));
}

// 출력 파일 이름이 겹치면 뒤에 -2, -3 을 붙인다(다른 폴더의 같은 파일 이름).
// 붙인 이름이 다른 영상 이름과 다시 겹치거나 대소문자만 다른 경우(macOS 기본 파일 시스템은 같은 파일)도 피한다.
function assignUniqueStem(jobList) {
  const usedSet = new Set();
  return jobList.map((job) => {
    let outStem = job.outStem;
    for (let count = 2; usedSet.has(outStem.toLowerCase()); count += 1) outStem = `${job.outStem}-${count}`;
    usedSet.add(outStem.toLowerCase());
    return outStem === job.outStem ? job : { ...job, outStem };
  });
}

// --repeat N(N > 1)이면 영상마다 회차 k = 1..N 작업을 영상 순서대로 펼치고 출력 이름 끝에 -r<k> 를 붙인다.
// 붙이기 전 이름(videoOutStem)은 위 규칙으로 서로 다르고 실행 기록·잠금·다른 출력 이름과 겹치지 않는다. -r<k> 는 숫자로 끝나
// 예약 이름·출력 끝말이 되지 않고, 끝의 -r<숫자> 를 떼면 붙이기 전 이름과 k 가 하나로 정해지므로 붙인 뒤의 이름도(대소문자 무시) 겹치지 않는다.
// N = 1 이면 작업 목록을 그대로 둔다(출력 이름·실행 기록이 이전과 같다).
function expandRepeatJobList({ jobList, repeatCount }) {
  if (repeatCount === 1) return jobList;
  return jobList.flatMap((job) => Array.from({ length: repeatCount }, (_, offset) => ({
    ...job, outStem: `${job.outStem}-r${offset + 1}`, videoOutStem: job.outStem, repeatIndex: offset + 1, repeatCount,
  })));
}

function readListEntryList(listPath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(listPath, 'utf8'));
  } catch (error) {
    throw new Error(`입력은 영상 폴더나 목록 JSON 이어야 한다 — JSON 으로 읽지 못했다(${listPath}): ${error.message}`);
  }
  const entryList = Array.isArray(parsed) ? parsed : parsed?.videoList;
  if (!Array.isArray(entryList)) throw new Error(`목록 파일에 videoList 배열이 없다: ${listPath}`);
  return entryList;
}

// 제품은 모르는 언어를 경고만 하고 설정 언어로 전사하므로, 목록의 오타가 조용히 다른 언어로 돌지 않게 미리 막는다.
function assertAsrLanguage({ language, prefix = '' }) {
  const { isAsrLanguage, ASR_LANGUAGE_LIST } = loadPipelineConfig();
  if (!isAsrLanguage(language)) throw new Error(`${prefix}language 는 ${ASR_LANGUAGE_LIST.join('·')} 중 하나다: ${language}`);
}

// 폴더의 숨김 파일(macOS 가 외장 디스크에 만드는 ._ 메타 파일 등)과 하위 폴더는 영상이 아니다.
function isVideoEntry(entry) {
  return !entry.isDirectory() && !entry.name.startsWith('.') && VIDEO_EXTENSION_LIST.includes(path.extname(entry.name).toLowerCase());
}

// 입력은 영상 폴더(바로 아래 파일만) 또는 목록 JSON — 실험 레포 3.2 문항 셋의 videoList[]({ videoId, file, language })를 그대로 받고 spec 표기 path 도 받는다.
// limit 은 영상 수다. repeatCount 가 1 보다 크면 영상마다 작업을 그 수만큼 펼친다(expandRepeatJobList).
export async function listInputVideos({ input, language = 'auto', limit = null, repeatCount = 1 }) {
  const inputPath = path.resolve(input);
  const stat = await fs.promises.stat(inputPath).catch((error) => {
    throw new Error(error.code === 'ENOENT' ? `입력 폴더·목록을 찾지 못했다: ${inputPath}` : error.message);
  });
  let jobList;
  if (stat.isDirectory()) {
    assertAsrLanguage({ language });
    const nameList = (await fs.promises.readdir(inputPath, { withFileTypes: true }))
      .filter(isVideoEntry)
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    jobList = nameList.map((name) => {
      const videoId = path.basename(name, path.extname(name));
      return { videoId, filePath: path.join(inputPath, name), outStem: toOutStem(videoId), language };
    });
  } else {
    const listDir = path.dirname(inputPath);
    jobList = readListEntryList(inputPath).map((entry, index) => {
      const rawPath = entry.file ?? entry.path;
      if (!rawPath) throw new Error(`목록 ${index + 1}번째 항목에 file(또는 path)이 없다`);
      const filePath = path.isAbsolute(rawPath) ? rawPath : path.join(listDir, rawPath);
      const videoId = String(entry.videoId ?? path.basename(rawPath, path.extname(rawPath)));
      const entryLanguage = entry.language || language;
      assertAsrLanguage({ language: entryLanguage, prefix: `목록 ${index + 1}번째 항목의 ` });
      return { videoId, filePath, outStem: toOutStem(videoId), language: entryLanguage };
    });
  }
  const limited = Number.isInteger(limit) && limit > 0 ? jobList.slice(0, limit) : jobList;
  return expandRepeatJobList({ jobList: assignUniqueStem(limited), repeatCount });
}
