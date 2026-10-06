# seeon-metricsDB — SEEON 평가 DB 공장

원천 영상을 넣으면 SEEON 이 교차 모드·균형 프로필로 만든 AD 를 원음 사이에 끼운 `<영상>_SEEON_AD.mp3` 와 기록 `<영상>_SEEON_AD.json` 을 낸다.

## 준비
- Node 22.14 이상
- ffmpeg·ffprobe **5.1 이상**(합성 필터 그래프를 `-filter_complex_script` 파일로 넘기는데, 5.1~8.0 이 모두 읽는다). PATH 에 없으면 `SEEON_FACTORY_FFMPEG`·`SEEON_FACTORY_FFPROBE` 로 경로를 준다.
- `git submodule update --init` (seeon-meet, 브랜치 production)
- 제품 의존성과 한국어 트리거 모델(**필수**):
  ```bash
  npm --prefix seeon-meet ci --omit=dev      # kiwi-nlp(형태소 분석 wasm)·ssh2(터널) 설치
  npm --prefix seeon-meet run setup:kiwi     # Kiwi 모델(실측 83.4MB, 제품 주석은 약 87MB)을 seeon-meet/vendor/kiwi-model 에 받는다
  ```
  제품은 전사마다 지시 트리거 후보를 main 에서 뽑는다(한국어는 Kiwi 형태소 분석, 영어는 규칙). 설치본은 `resources/kiwi-model` 을 쓰지만 개발 실행은 `seeon-meet/vendor/kiwi-model` 을 쓰고(`kiwi-model.js resolveKiwiModelDir`), 공장 워커는 electron `app` 이 없어 개발 경로를 쓴다. 서브모듈은 `vendor/` 를 무시하므로 모델을 받아도 seeon-meet 작업 트리 수정으로 잡히지 않는다. 서브모듈 커밋을 올릴 때 Kiwi 버전이 바뀌면 `setup:kiwi` 를 다시 돌린다(같은 버전이면 건너뛴다).
- 메모리: 워커 하나가 Kiwi 로 약 0.85GB 를 더 쓴다(실측 RSS 증가, 로드 0.8초). 워커는 영상 하나마다 끝나 쌓이지 않으므로 최대 추가량은 대략 동시 수 × 0.85GB 다(동시 3 이면 약 +2.6GB). 시작 전 점검이 남은 메모리가 (동시에 돌 워커 수) × 1GB 보다 적으면 경고 한 줄을 찍는다(실패는 아니다. macOS 의 남은 메모리는 캐시를 빼고 세어 실제 여유보다 작게 보일 수 있다).
- GPU 서비스가 답하지 않을 때 제품 터널로 열려면 `SEEON_GPU_SSH_KEY` 와 서버 접속 정보 `SEEON_GPU_SSH_HOST`·`SEEON_GPU_SSH_USER`·`SEEON_GPU_SSH_HOST_FINGERPRINT`(포트 `SEEON_GPU_SSH_PORT`, 비우면 22)도 필요하다(`ssh2` 는 위 `npm ci` 로 설치). 제품은 서버 접속 정보를 코드에 두지 않고 `.env` 로만 받는다. 없으면 터널 상태가 `서버 설정 없음` 으로 남아 시작 전 점검이 터널 대기 시간(20초) 뒤 멈춘다.
- `.env`: 저장소 루트에 두며 저장소에 넣지 않는다(`.gitignore`). 이름은 `.env.example` 에 있다. seeon-meet·실험실에서 쓰던 `.env` 가 있으면 내용을 복사해 쓴다. 원본이 심볼릭 링크일 수 있으니 `-L` 로 링크가 아닌 내용을 복사하고 권한을 좁힌다.
  ```bash
  cp -L <seeon-meet 또는 실험실의 .env> .env
  chmod 600 .env
  ```
  CLI 는 시작할 때 이 `.env` 를 읽는다(이미 있는 환경변수가 이긴다). 내용은 출력·로그·JSON 에 남기지 않는다(Bedrock 토큰은 JSON `config.modelConfig` 에서 뺀다).
- 탐지 판정 LLM(판단 LLM: 통합 라우터가 트리거 후보를 지시 대상·발화 기반 두 묶음으로 나눠 그 문장에 있는 묶음마다 한 번씩 묻고 후보마다 공백 O/X, 무발화 판정)은 제품 기본값대로 GPU 서버에서 VLM(8801)과 따로 띄운 판정 LLM(`http://127.0.0.1:8805/v1/chat/completions`)으로 보낸다(6초 상한). 실패해도 Bedrock 으로 넘기지 않는다. 판단 LLM 은 실패한 묶음의 후보를, 무발화 판정은 그 해설을 내지 않는다(라우터 모드가 unified 가 아닐 때만 쓰는 지시 판정은 실패하면 통과시킨다). `SEEON_JUDGE_BACKEND`(gpu·bedrock)·`SEEON_JUDGE_GPU_URL`·`SEEON_JUDGE_GPU_MODEL` 로 바꾼다(제품과 같은 이름). bedrock 이면 Bedrock(`SEEON_BEDROCK_JUDGE_MODEL_ID`)만 쓴다. 삽입 위치 추론(틈 추론)은 판정 백엔드와 상관없이 이 GPU 판정 LLM 이 하고(균형 모드는 사고 없이), 실패하면 규칙(첫 완결 경계)으로 고른다. 화면 이해(VLM)도 GPU 가 실패하면 Bedrock 으로 넘기지 않고 그 해설을 내지 않는다.
- 모델 이름 `SEEON_VLM_MODEL`·`SEEON_JUDGE_GPU_MODEL` 은 GPU 서버의 서빙 이름과 같아야 한다. 2026-10-20 부터 서버는 VLM(8801)·판정(8805) 모두 Gemma 4 26B-A4B 를 `gemma-4-26b-a4b-qat` 로 서빙하고, 서브모듈 제품의 기본값도 같은 이름이라 `.env` 에서 비워 둔다. 서버의 서빙 이름이 제품 기본값과 다를 때만 넣는다. 이름이 다르면 시작 전 점검이 멈춘다(아래 "시작 전 점검").
- VLM 이미지 토큰 상한(제품과 같은 이름): `SEEON_VLM_MAX_SOFT_TOKENS`(양의 정수, 기본 비움). 넣으면 그림 요청마다 그림 한 장을 나눌 이미지 토큰 수 상한(해상도)을 실어 보내고, 비우면 서버에 띄운 값을 쓴다. 서버가 `--trust-request-mm-kwargs` 로 떠 있을 때만 넣는다 — 그 옵션 없이 떠 있으면 요청별 값이 400 으로 거절돼 그림 요청이 모두 실패한다(시작 전 점검은 이것을 보지 않는다). 결과 설정 `vlmMaxSoftTokens` 로 견준다.
- 척도 해설(추상적 척도)은 제품 기본으로 켜져 있다. `SEEON_ROUTER_SCALE_ENABLED=false` 로만 끈다(결과 설정 `isScaleEnabled` 로 견준다).
- 수치·척도 해설의 화면 글자 근거(제품과 같은 이름): `SEEON_SCREEN_TEXT_GROUNDING=on|off`(기본 on). 켜면 수치 해설(변화·비교)과 척도 해설 요청 프레임을 OCR 주소(`/ocr`)로 읽어 근거로 넣는다 — 슬라이드 전사 백엔드와 상관없이 돈다. 포인팅 영역이 있는 지시 판정에서도 OCR 은 잘린 그림이 아니라 같은 순간의 전체 화면을 읽는다. OCR 이 늦거나 실패하면 근거 없이 만든다(제품 동작). 통합 라우터(`SEEON_ROUTER_MODE` 기본 unified)에서만 돌고, 켜져 있으면 시작 전 점검이 OCR 주소를 본다(아래). 결과 설정 `isScreenTextGroundingEnabled` 로 견준다.
- 슬라이드 전사 백엔드(제품과 같은 이름): `SEEON_SLIDE_TEXT_BACKEND=vlm|ocr`(기본 vlm). ocr 이면 새 슬라이드마다 GPU 서버 임베딩 서비스의 `/ocr` 로 화면 글자를 읽고, 실패·저신뢰·세로 글씨인 장만 VLM 으로 넘긴다(제품 동작). `SEEON_OCR_URL` 은 OCR 주소로 기본은 임베딩 주소의 origin + `/ocr`(`http://127.0.0.1:8804/ocr`)이며 포트를 나눴을 때만 준다. 결과 설정 `slideTextBackend` 로 견준다.
- 틈 후보 출처 `SEEON_GAP_SOURCE` 는 공장이 asr(기본, ASR 끝 시각)만 지원한다. audio(잰 무음)는 아직 옮기지 않아 주면 시작 전 점검이 멈춘다(결과에 audio 라 적힌 채 asr 로 돌지 않게).

## 실행
npm run factory -- --input <폴더|목록.json> [--out <폴더>] [--concurrency 1] [--language ko|en|auto] [--include-page-transition] [--force] [--limit N] [--timeout-min M] [--repeat N]

- 입력 폴더: 바로 아래 mp4·mov·mkv·webm(숨김 파일·하위 폴더는 뺀다). 목록 JSON: 실험 레포 `videoList[]`(`{ videoId, file, language }`, `path` 도 받음). 상대 경로는 목록 파일 기준. `npm run` 은 저장소 루트에서 돌므로 `--input`·`--out` 의 상대 경로는 저장소 루트 기준이다.
- 같은 출력 이름(다른 폴더의 같은 파일 이름, 대소문자만 다른 이름)은 뒤에 `-2`, `-3` 을 붙인다. `manifest`·`summary`·`repeat-summary` 로 시작하는 이름과 점으로 시작하는 이름(잠금 파일 `.factory.lock` 과 겹침)은 앞에 `video-` 를, `.log`·`_SEEON_AD.mp3`·`_SEEON_AD.json` 으로 끝나는 이름은 끝말의 점을 `_` 로 바꿔 실행 기록·다른 영상의 출력과 겹치지 않게 한다.
- `--repeat N`(1 이상 정수, 기본 1): 영상마다 N번 돌린다. 제품의 ASR 문구·LLM(판단·생성) 결과가 실행마다 달라 한 번 돌린 결과로는 차이가 실행 편차인지 가를 수 없다.
  - N > 1 이면 영상마다 작업 N개가 생기고 위 규칙을 거친 출력 이름 끝에 `-r<k>`(k = 1..N)를 붙인다(`<영상>-r1_SEEON_AD.mp3`·`.json`·`.log`·작업 폴더 `<영상>-r1/`). 붙이기 전 이름이 서로 다르고 끝이 숫자라 붙인 뒤에도 겹치지 않는다.
  - 작업 N개는 모두 같은 워커 풀에 들어가 `--concurrency` 는 전체 작업에 걸린다. `--limit` 은 영상 수 기준이다(`--limit 2 --repeat 3` = 작업 6개). 터미널·summary 의 작업 줄은 `<videoId> r<k>/<N>` 이다.
  - 건너뛰기는 작업(영상 × 회차)마다 정한다. 회차(`repeat.index`)는 견주고 반복 수(`repeat.count`)는 견주지 않아, 같은 `--out` 에서 N 을 3 → 5 로 올리면 r1~r3 은 건너뛰고 r4·r5 만 돈다. 건너뛴 회차도 manifest·summary·반복 요약에는 이번 실행의 N 으로 적힌다(`r1/5`, `반복 5회`). N 을 5 → 3 으로 줄이면 r1~r3 만 이번 실행이고(`반복 3회`), r4·r5 파일은 지우지 않고 남는다.
  - **N = 1 결과(접미 없음, `<영상>_SEEON_AD.json`)와 N > 1 결과(`<영상>-r1_SEEON_AD.json`)는 이름이 달라 서로 건너뛰지 않는다.** 같은 `--out` 에서 `--repeat 1` 뒤에 `--repeat 3` 을 돌리면 r1~r3 을 새로 돌고, 접미 없는 결과는 그대로 남는다(반복 요약에는 들어가지 않는다).
  - 같은 입력으로 N 을 바꿔 돌릴 때는 `--out` 을 나눈다. 같은 `--out` 이면 줄인 N 위의 회차 결과가 남아 다른 코드 버전의 결과와 섞이기 쉽고, 입력에 `x.mp4` 와 `x-r2.mp4` 가 함께 있으면 N = 1 과 N > 1 실행이 `x-r2` 자리를 번갈아 덮어쓴다(한 실행 안에서는 겹치지 않는다).
  - `--repeat 1`(또는 생략)은 출력 이름·manifest·summary·건너뛰기가 이 옵션이 생기기 전과 같다. 결과 JSON 에 `repeat: { index: 1, count: 1 }` 이 더해지고, 예약 이름에 `repeat-summary` 가 더해진 것(그 이름으로 시작하는 영상은 `video-` 가 붙는다)만 다르다.
- 같은 `--out` 으로 다시 돌리면 끝난 영상은 건너뛴다(`--force` 로 모두 다시). 끝난 영상 = mp3 와 `isComplete` JSON 이 있고, JSON 의 아래 값이 모두 지금과 같은 것:
  - 영상 파일·videoId·언어·전환 고지 설정, 반복 회차(`repeat.index`, 이 기록이 없는 이전 결과는 1회차)
  - 코드 버전: seeon-meet 커밋과 공장 커밋. 같은 커밋이라도 작업 트리 수정 여부·수정 내용 지문이 다르면 다르다. 공장은 결과에 영향을 주는 `src/`·`package.json` 만 본다
  - 결과 설정(JSON `config.resultConfig`): 모드·지연, VLM 이미지 토큰 상한(`vlmMaxSoftTokens`, 비우면 null), VLM·판정 GPU·Bedrock 판정·Bedrock 기본·틈 추론 모델(`gapModelId` — 삽입 위치 추론을 하는 GPU 판정 LLM, 지연이 없어 추론을 부르지 않는 모드는 null), 판정 백엔드, 라우터 모드·척도, 화면 글자 근거(`isScreenTextGroundingEnabled`), 슬라이드 전사 백엔드(`slideTextBackend`)·틈 후보 출처(`gapSource`). 서비스 주소(OCR 주소 포함)·토큰은 보지 않는다(터널·직접 연결은 결과를 바꾸지 않는다). ASR·TTS·임베딩 모델은 GPU 서버가 정해 공장이 알 수 없으므로, 서버 모델을 바꿨으면 `--force` 나 새 `--out` 을 쓴다
  - 끝났지만 달라서 다시 만드는 영상은 `[factory] ↻ <videoId> 이전 완료 결과와 달라 다시 만든다 — <다른 곳>` 한 줄을 찍는다. 이 기록이 없는 이전 형식 결과는 한 번 다시 만든다
- 워커를 띄우기 전에 그 영상의 이전 mp3·JSON·작업 폴더(`<영상>/`)를 지우므로 도중에 죽은 영상은 다음에 다시 돌고, 이전 실행의 AD wav·합성 조각이 섞이지 않는다. 건너뛴 영상의 작업 폴더는 그대로 둔다. 실패가 하나라도 있으면 종료 코드 1.
  - 작업 폴더는 워커가 만들 때 표식 파일 `.seeon-factory-work` 를 넣고, 다시 처리할 때는 이 표식이 있는 폴더만 통째로 지운다. 그 자리에 표식 없는 폴더·파일·심볼릭 링크가 있으면(예: `--out` 을 영상 폴더와 같게 주었는데 `lecture.mp4` 옆에 사용자의 `lecture/` 가 있음) 아무것도 지우지도 쓰지도 않고 그 영상만 실패로 둔다. 사용자 자료면 옮기거나 다른 `--out` 을 쓰고, 표식이 생기기 전 공장이 만든 작업 폴더면 손으로 지운 뒤 다시 돌린다.
- 같은 `--out` 에는 실행 하나만 붙는다. 시작할 때 `--out/.factory.lock`(pid·호스트·시작 시각)을 만들고, 이미 있으면 그 pid 가 살아 있는 동안은 이유를 찍고 종료 코드 1 로 끝난다. 정리 없이 죽은 실행의 잠금(같은 호스트, pid 없음)은 경고를 찍고 가져간다. 다른 호스트의 잠금은 가져가지 않으니 그 실행이 끝났으면 잠금 파일을 지운다. 잠금은 정상 끝·실패·Ctrl-C·강제 종료에서 모두 푼다.
  - 잠금 인수는 보수적이라 죽은 실행의 잠금도 못 가져가는 경우가 있다: 호스트 이름이 바뀜(macOS 는 네트워크에 따라 바뀔 수 있다, 컨테이너는 실행마다 다르다), 죽은 실행의 pid 를 다른 프로세스가 다시 씀("이미 실행 중"으로 거절). 이때는 그 `--out` 을 쓰는 공장 실행이 없는지(`ps` 로 그 pid 가 공장인지) 확인한 뒤 오류 문구가 알려 주는 `--out/.factory.lock` 을 손으로 지우고 다시 돌린다.
- 영상당 시간 상한: 기본은 `max(30분, 영상 길이 × 4 + 10분)`(영상 길이는 워커의 첫 진행 보고에서 알고, 그 전에는 30분). `--timeout-min M` 을 주면 영상마다 M분 고정(소수 가능). 넘으면 워커에 SIGTERM, 5초 뒤에도 살아 있으면 SIGKILL 하고 `시간 초과` 로 실패 기록.
- 워커는 SIGTERM(·SIGHUP)을 받으면 자기가 띄운 ffmpeg·ffprobe 를 모두 죽이고 128 + 신호 번호(SIGTERM 143)로 끝난다. 부모(CLI)가 죽어 연결이 끊겨도 같은 정리를 하고 끝난다(고아 프로세스가 남지 않는다).
- `manifest.json`·`summary.txt` 는 시작할 때와 영상 하나가 끝날 때마다 고쳐 쓴다(임시 파일 → 이름 바꾸기). 실행 중이면 `endedAt` 이 null, 아직 끝나지 않은 영상은 `not_run`.
- Ctrl+C(SIGINT)·SIGTERM·SIGHUP: 돌던 워커마다 SIGTERM 을 보내 멈추고(`중단됨(SIGINT)` 실패, 5초 안에 안 끝나면 SIGKILL) 남은 영상은 띄우지 않으며, manifest 에 `interruptedBy`·`endedAt` 을 쓰고 잠금을 푼 뒤 130·143·129 로 끝난다.
  - SIGHUP 은 터미널이 닫힐 때(SSH 연결 끊김) 온다. 연결이 끊겨도 계속 돌리려면 tmux 안에서 돌린다. `nohup` 은 node 가 시작할 때 신호 설정을 기본으로 되돌려 SIGHUP 을 막지 못한다(그래도 중단 기록은 남는다).
  - 터미널 Ctrl+C 는 프로세스 그룹 전체에 SIGINT 를 보내지만 워커는 그 SIGINT 로 죽지 않는다. 멈춤은 CLI 가 SIGTERM 으로 보내고 영상마다 결과를 거둔다.
  - `npm run factory` 는 받은 SIGINT 를 CLI 에 한 번 더 전달한다. 첫 신호 뒤 1.5초 안에 온 신호는 같은 Ctrl+C 로 보고 무시한다.
  - 1.5초가 지나 한 번 더 보내면 강제 종료다: 워커를 유예 없이 SIGKILL 하고 기록을 쓴다. 그래도 3초 안에 못 끝나면(터널 닫기가 멈추는 등) 기록과 잠금만 정리하고 끝낸다.
- 시작 전 점검: 하나라도 안 되면 이유를 찍고 종료 코드 1.
  - ffmpeg·ffprobe 를 돌릴 수 있는지.
  - 한국어 트리거 형태소 분석기(Kiwi): seeon-meet 에 `kiwi-nlp` 가 있고 `seeon-meet/vendor/kiwi-model` 에 모델(파일 다섯 개 + VERSION, 제품 `setup:kiwi` 와 같은 확인)이 있는지. 없으면 설치 명령을 찍는다. 워커는 세션을 시작하기 전에 Kiwi 준비를 기다리고(제품 앱은 앱이 뜰 때 읽는다), 못 띄우면 그 영상은 실패다.
  - GPU 서비스(VLM·ASR·TTS·긴 문장 TTS·EMBED, 판정 LLM JUDGE 8805)가 HTTP 로 답하는지. 판정 LLM 은 판정 백엔드와 상관없이 본다 — 공장의 균형 모드는 지연이 있어 삽입 위치 추론을 부르고, 제품은 그 추론에 판정 백엔드와 상관없이 GPU 판정 LLM 을 쓴다. 설정 주소로 몸통 없는 GET 을 보내 상태 코드와 상관없이 응답이 오면(405·404 포함) 살아 있다고 본다. 연결 거부·연결 끊김·3초 안에 응답 없음은 죽은 것으로 `<이름> <호스트>:<포트> <이유>` 를 찍는다. 포트만 열려 있는 것은 통과가 아니다 — SSH 터널은 원격 서비스가 죽어도 로컬 포트를 열어 두고 연결을 받자마자 끊는다.
  - 답하지 않는 서비스가 있으면 제품 터널 모듈로 연결한 뒤 다시 본다(`npm --prefix seeon-meet ci --omit=dev` 와 `SEEON_GPU_SSH_KEY`·서버 접속 정보 필요, 위 "준비"). 제품 터널은 판정 LLM 주소(8805)도 넘긴다. `SEEON_JUDGE_GPU_URL` 을 VLM 과 같은 호스트·포트로 두면 VLM 점검이 판정도 덮는다.
  - GPU 서버가 설정한 모델 이름을 서빙하는지: VLM 주소와 판정 주소(위와 같이 판정 백엔드와 상관없이)의 `/v1/models` 를 받아 `SEEON_VLM_MODEL`·`SEEON_JUDGE_GPU_MODEL`(비우면 제품 기본값)이 목록에 있는지 본다. 없으면 `VLM <호스트>:<포트> 에 모델 <이름> 이 없다(서버: <서빙 이름 목록>) — .env 의 SEEON_VLM_MODEL·SEEON_JUDGE_GPU_MODEL 을 확인한다` 를 찍고 멈춘다. HTTP 로 답하는지만 보면 옛 이름이 남아도 통과하고, 실제 요청이 404 로 실패해 AD 가 빠지기 때문이다. 같은 호스트·포트는 목록을 한 번만 받는다. 목록을 받지 못한 자리는 건너뛰고(닿지 않는 것은 위 GPU 서비스 점검이 잡는다), 터널을 연 뒤 다시 볼 때 함께 확인한다.
  - `SEEON_JUDGE_BACKEND=bedrock` 이면 Bedrock 토큰이 있는지. 탐지 판정이 Bedrock 이라 토큰이 없으면 판단 LLM·무발화 판정을 쓸 수 없어 지시 대상·발화 기반·무발화 해설이 빠진다. 판정 백엔드가 gpu(기본)면 공장 실행은 Bedrock 을 부르지 않아(탐지 판정·삽입 위치 추론 모두 GPU 판정 LLM, Bedrock 을 쓰는 회의 요약은 돌리지 않는다) 토큰이 없어도 된다. Bedrock 은 호출마다 돈이 들어 실제로 부르지 않는다. 배치 중 토큰이 만료되면 그 영상이 불완전(`bedrock_auth_failed`)으로 끝난다.
  - OCR 을 부르는 설정이면 — `SEEON_SLIDE_TEXT_BACKEND=ocr` 이거나 화면 글자 근거가 켜져 있으면(`SEEON_SCREEN_TEXT_GROUNDING` 기본 on, 통합 라우터일 때) — OCR 주소가 실제로 전사하는지: 흰 64×32 JPEG 한 장을 POST 해 2xx 와 제품이 읽는 응답 모양(`text`·`lineList`·`meanScore`·`verticalBoxRatio`)일 때만 통과다. 닿지 않으면(연결 거부·끊김·응답 없음) `OCR <호스트>:<포트> <이유>` 로 GPU 서비스 점검 목록에 들어가 터널을 연 뒤 다시 본다. 닿았지만 실패하면(`/ocr` 이 없는 서버 404·OCR 엔진이 없는 서버 503·모양이 다른 답) 터널로 고칠 수 없으므로 터널 없이 `OCR <호스트>:<포트> 에 닿았지만 실패했다(<상태>)` 로 바로 점검 실패다(켜 둔 설정을 끄는 값 `SEEON_SLIDE_TEXT_BACKEND=vlm`·`SEEON_SCREEN_TEXT_GROUNDING=off` 를 함께 찍는다). 통과하지 않은 채 돌리면 ocr 백엔드는 제품이 장마다 VLM 으로 넘겨 결과는 ocr 이라 적힌 채 VLM 으로 전사되고, 화면 글자 근거는 근거 없이 해설을 만들어 결과가 조용히 달라지기 때문이다.
  - 틈 후보 출처(`SEEON_GAP_SOURCE`)가 asr 인지. audio 면 `SEEON_GAP_SOURCE=audio 는 공장이 아직 지원하지 않는다` 를 찍고 멈춘다. 워커를 따로 띄워도 제품 세션 시작 결과의 `gapSource` 가 asr 가 아니면 그 영상은 캡처 전에 실패한다.

### 슬라이드 전사 백엔드 A/B
같은 영상을 백엔드만 바꿔 견줄 때는 `--out` 을 나눠 두 번 돌린다.
```bash
npm run factory -- --input list.json --out out/ab-vlm
SEEON_SLIDE_TEXT_BACKEND=ocr npm run factory -- --input list.json --out out/ab-ocr
```
- 결과 설정에 `slideTextBackend` 가 있어, 같은 `--out` 에서 백엔드만 바꿔 돌리면 끝난 영상을 건너뛰지 않고 `↻ … 결과 설정 slideTextBackend vlm → ocr` 로 다시 만든다 — 이전 결과를 덮어쓰므로 A/B 는 `--out` 을 나눈다.
- 견줄 곳: summary 의 영상 아래 호출 줄(`호출 asr 18 · vlm 15 · ocr 5 · … / 슬라이드 전사 ocr 3 · vlm 2(VLM 으로 넘김 low_score 2)`), JSON `stats.serviceMap` 의 `vlm`·`ocr` 수·지연과 `stats.slideText`, 경고 `vlm_timeout`·`ocr_*`. 한 번 돌린 AD 차이는 실행 편차가 지배하므로 AD 를 견주려면 양쪽을 `--repeat N` 으로 돌린다.

### 동시 처리 수
- 기본 1 이다(2026-10-07 재측정 뒤 3 → 1). `--concurrency N` 으로 올리면 빨라지지만 공용 GPU 가 포화돼 **AD 결과가 동시 1 과 달라진다.**
- 처리 시간(63.7초 영상 3개, 2026-10-07): 동시 1 은 2분 44초(영상마다 52~58초), 동시 3 은 69초(약 2.4배 빠름).
- 동시 3 실측(같은 영상 ×3):
  - 2026-10-06(seeon-meet 83059fc — VLM 과 GPU 탐지 판정이 같은 qwen 8801): 영상마다 VLM 호출 14~15건 중 4건이 20초 시간 초과로 Bedrock 폴백, GPU 판정이 6초 상한에 걸려 Bedrock 으로 넘어감, ASR p95 0.8~1.4초 → 3.8~6.1초. 지시 해설이 16초 넘게 늦거나 다른 해설이 나왔다.
  - 2026-10-07(seeon-meet 81361de — 판정은 8805 로 갈라짐): 판정은 세 영상 모두 GPU 로 끝나 판정 폴백은 없어졌다. 그러나 VLM 은 영상마다 11건 중 3건이 20초 시간 초과로 Bedrock 폴백, 이어지는 60초 우회까지 폴백 11건(동시 1 은 0~3건), ASR p95 1.1~4.2초 → 2.8~5.2초(동시 1 측정 중 같은 맥에서 다른 시험이 돌았다). 결과: 동시 1 세 번은 모두 발화 기반 2개(약 10초 "2는 오른쪽 카드를 의미", 약 33초 "250은 반기 연봉 조정 금액을 의미")로 같았고, 동시 3 세 번은 모두 첫 해설이 사라지고(ASR 이 늦어 다음 문장 "이 부분이 오늘의 핵심입니다"까지 한 발화로 묶여 묘사가 "특정 불가"로 끝남) 42초에 Bedrock 폴백 묘사로 무발화 해설 "이미지 제시, 여행 장소별 사진 모음"이 새로 생겼다. 실행마다 같은 방식으로 달라지므로 우연이 아니라 부하가 결과를 바꾼다.
- 동시 수를 올렸다면 터미널·summary 의 ⚠ 경고(아래)와 JSON `stats.serviceMap` 의 `errorCount`·p95, `stats.judgeSourceCountMap` 의 `error` 수(탐지 판정 호출이 실패·시간 초과한 수, 아래 `judge_error`)를 먼저 본다. 결과 JSON `config.runConcurrency` 에 그 실행의 동시 수가 남는다. 실험실 비교·회귀 확인은 동시 1 로만 한다.

### 완료·실패·경고
- **불완전 = 실패.** 아래 기반 문제가 있으면 mp3·JSON 은 남기되 JSON 은 `isComplete: false` 와 `incompleteReasonList` 를 갖고, 그 영상은 **실패**로 기록된다(종료 코드 1). 같은 `--out` 으로 다시 돌리면 그 영상을 다시 처리한다. 원인이 결정적이면(망가진 영상 파일 등) 다시 돌려도 같은 실패가 반복된다.
  - `frame_source_error`·`frame_capture_failed`: 화면 입력 실패(프레임 읽기 오류·60초 안에 안 끝난 ffmpeg, JPEG 캡처 실패)
  - `asr_failure`: ASR 호출 실패가 10% 를 넘음. ASR 은 지시·무발화·틈 후보 등 모든 감지의 입력이라 실패한 조각만큼 발화가 통째로 사라진다. 10% 이하는 일시적 실패로 보고 경고만 남긴다(동시 3 실측에서도 ASR 실패는 없었고 p95 6초로 20초 상한과 멀다). 서비스가 죽으면 100% 가 된다
  - `tts_unavailable`: 렌더러가 해설 소리를 합성(`pipeline-tts`)하려 했는데 확정된 합성이 하나도 성공하지 못함(TTS 장애). 세션을 멈출 때 응답이 없던 합성은 성공도 실패도 아니라 판정에서 뺀다(`stats.tts.pendingAtStopCount`). 제품은 캡션에 소리를 싣지 않고 재생 차례가 가까운 해설만 합성하며, 합성이 실패한 해설은 재생기가 `tts_failed` 로 버리므로 AD 없는 mp3 가 된다. 합성 차례가 오기 전에 버려진 해설(체류 미달·누적 지연 등)만 있는 영상은 합성 요청이 없어 해당하지 않는다. 호출 실패 비율이 아니라 이 결과로 가르는 이유는 짧은 영상의 해설이 1~2개뿐이라(실측 63.7초 2개, 31.7초 1개) 비율 문턱으로는 TTS 가 죽은 결과를 놓치기 때문이다. 일부 해설만 소리를 잃은 영상(부하로 15초 상한 초과, 영상 도중 TTS 가 죽음)은 완료로 두고 `tts_timeout`·`tts_error` 경고와 버린 사유 `tts_failed` 만 남긴다 — 이 경고가 보이면 그 영상의 `_SEEON_AD.json` 을 지우고 같은 `--out` 으로 다시 돌린다
  - `ocr_unavailable`: 슬라이드 전사 백엔드가 ocr 인데 OCR 로 읽은 장이 하나도 없고, OCR 서비스 실패(`ocr_error`·`ocr_bypass`)로 VLM 으로 넘긴 장이 있음. 사전 점검은 통과했지만 도중에 OCR 이 죽으면 제품이 모든 장을 VLM 으로 전사해 결과가 ocr 이라 적힌 채 VLM 결과가 되므로, 재실행이 건너뛰지 않게 실패로 둔다. 일부 장만 넘긴 것은 경고 `ocr_fallback` 이고, OCR 이 답했지만 저신뢰·세로 글씨라 넘긴 것은 해당하지 않는다
  - `bedrock_auth_failed`: Bedrock HTTP 401·403 이 하나라도 있음(단기 토큰 만료·권한). 그 뒤 Bedrock 호출(판정 백엔드가 bedrock 이면 탐지 판정)이 모두 실패한다
  - `session_end_failed`: 제품 세션 종료(`session.endResult.isOk === false`). 제품 기록 jsonl 의 끝이 확정되지 않는다
- 제품 세션 시작(`pipeline-session-start`)이 실패하면 영상은 실패다(제품 앱은 기록 없이 계속하지만 공장은 기록 없이 결과를 만들 수 없다).
- **경고 = 완료.** 부하로 생기는 품질 저하는 결과를 실패로 만들지 않는다. 동시 3 에서는 정상적으로도 생기므로(실측: 영상마다 VLM 시간 초과 4건) 실패로 치면 재실행이 같은 영상을 끝없이 다시 돈다. 대신 JSON `warningList`(`{ code, message, count }`)에 남기고, 터미널 ✔ 줄과 summary 영상 줄 끝에 `⚠ vlm_timeout 4 · judge_error 1` 처럼, summary 머리줄에 `완료 N(경고 M)` 으로 드러낸다.
  - `<서비스>_timeout`·`<서비스>_error`: 서비스(`asr`·`vlm`·`ocr`·`judge`·`tts`·`embed`·`bedrock`·`other`)별 시간 초과·실패 수. OCR 이 실패한 장은 제품이 VLM 으로 넘겨 전사한다. `message` 에 첫 실패의 원인(HTTP 상태, 연결 실패면 `fetch failed (ECONNREFUSED: …)`)을 적는다. 오류 문구(경고·불완전 사유·호출 기록·manifest·터미널·`<영상>.log`)에 실린 주소의 사용자 정보(`user:pass@`)는 지운다
  - `judge_error`: 탐지 판정 호출이 실패한 수(`stats.judgeSourceCountMap` 의 `error`). 판정 백엔드 하나만 쓴다 — gpu 면 GPU 판정 LLM, bedrock 이면 Bedrock 이 실패·시간 초과한 것이고 다른 쪽으로 넘기지 않는다. 판단 LLM(`router`)은 그 묶음의 후보를, 무발화 판정은 그 해설을 내지 않고, 지시 판정(라우터 모드가 unified 가 아닐 때만 씀)은 통과시킨다. 위 서비스 경고의 `judge_error`(GPU 판정 LLM 으로 간 HTTP 호출 실패, 문구 `GPU 판정 LLM 호출 실패 …` — 삽입 위치 추론 실패도 든다)와 코드가 같으므로 문구(`탐지 판정 호출 실패 …`)로 가른다. `ocr_fallback`: 슬라이드 전사 백엔드 ocr 에서 OCR 서비스 실패(`ocr_error`·`ocr_bypass`)로 VLM 으로 넘긴 장 수(OCR 로 읽은 장이 하나도 없으면 불완전 `ocr_unavailable`)
  - `drain_timeout`: 배수 상한에 닿아 멈춤(`session` 참고), `swallowed_error`: 연결 코드가 제품처럼 삼킨 오류(`stats.swallowedErrorCountMap`)

## 결과물 (`out/<YYYYMMDD-HHmmss>/`)
- `<영상>_SEEON_AD.mp3` — 원음 + AD + 배속 따라잡기(원본 샘플레이트·채널, 192kbps; 48kHz·2채널 초과는 맞춰 줄임). 영상 끝 뒤의 원음 꼬리는 1.0배속이고, 배속 회수는 해설 때문에 밀린 만큼만 일어난다. 배수 상한(아래 `session`)에서 멈춰도 남은 원음을 1.0배속으로 끝에 붙여 원음 전체가 들어간다.
- `<영상>_SEEON_AD.json` — AD 목록(사건·삽입·재생 소스 시각, 출력 시각, 길이, 분류, 문장, 쓰인 모델, TTS 합성), 버린 해설과 사유, 서비스별 호출 수·지연, 처리 시간, 재생 타임라인
  - `--repeat N`(N > 1)이면 영상마다 `<영상>-r<k>_SEEON_AD.mp3`·`.json`·`<영상>-r<k>.log`·`<영상>-r<k>/` 가 k = 1..N 만큼 생긴다(위 "실행")
  - `repeat`: `{ index, count }` — 같은 영상의 몇 번째 회차인지와 그 실행의 반복 수. `--repeat 1` 이면 `{ index: 1, count: 1 }`. 건너뛰기는 `index` 만 견준다
  - `adList[].eventMediaMs`(사건 시각)·`latencyMs`(재생 위치 − 사건 시각): 제품 fb093c1 부터 지시·해석 해설의 사건 시각은 해설이 다루는 후보 구 가운데 가장 늦게 말한 시각이라(보류 중 합친 뒤 조각의 후보가 해설이 되면 늦어진다) 그 전 결과와 직접 견주지 않는다. `playedMediaMs` 는 그대로 견줄 수 있다
  - `adList[].tts`: `{ isPrefetched, synthMs, waitMs }` — 재생 차례 전에 미리 합성했는지(제품은 차례가 가까운 2개를 미리 만든다), 합성에 걸린 시간, 차례가 온 뒤 소리를 기다린 시간(그동안 지연 재생이 멈춰 mp3 에 그만큼 무음이 들어간다). `serviceCallList` 에 그 TTS 호출도 든다
  - `isComplete`·`incompleteReasonList`: 불완전 사유 목록 `{ code, ... }` — `frame_source_error`(`message`, `videoTimeMs`)·`frame_capture_failed`(`count`)·`asr_failure`(`count`, `total`, `message`)·`tts_unavailable`(`narrationCount` 해설 수, `count`·`total` 확정된 합성 요청 중 실패 수·요청 수 — 이 사유가 붙으면 모두 실패라 둘이 같다, 세션을 멈출 때 끝나지 않은 합성은 넣지 않는다, `message` 는 TTS 서비스 호출 기록의 첫 실패, 없으면 제품 핸들러의 실패 문구)·`ocr_unavailable`(`count` OCR 서비스 실패로 VLM 으로 넘긴 장 수, `total` 전사가 끝난 장 수, `message` OCR 호출 기록의 첫 실패)·`bedrock_auth_failed`(`count`, `message`)·`session_end_failed`(`message`). 완료면 빈 배열
  - `warningList`: 경고 목록 `{ code, message, count }`(위 "완료·실패·경고"). 없으면 빈 배열
  - `seeonMeet`·`factory`: 결과를 만든 제품·공장 버전 `{ commit, isDirty, dirtyHash }`(워커가 영상을 시작할 때 읽는다. `dirtyHash` 는 수정 내용 지문, 수정이 없으면 null)
  - `config.modelConfig`: 제품 설정(토큰 뺌) — `vlmModel`·`routerMode`·`judgeBackend`(gpu·bedrock)·`judgeGpuUrl`·`judgeGpuModel`·`judgeModelId`(판정 백엔드 bedrock 의 판정 모델)·`slideTextBackend`(vlm·ocr)·`isScreenTextGroundingEnabled`·`ocrUrl`·`gapSource`(asr) 등
  - `config.resultConfig`: 재실행 건너뛰기에 견주는 결과 설정(위 "실행"), `config.runConcurrency`: 그 실행의 동시 수
  - `droppedList[].reason`: 늘 제품 사유다. main 이 내보내지 않은 것(`feature_off`·`rate-limited`·중복 등 `skipReason`)과 렌더러가 재생하지 못하고 main 에 알린 것(`pipeline-narration-dropped`) — `expired`·`stale`·`slide_changed`·`feature_off`(대기 줄. `stale` 은 재생 차례가 왔을 때 듣고 있는 지연 재생 위치가 트리거에서 10초 넘게 지난 자동 해설), `tts_failed`(합성 실패), `delay_exceeded`(누적 지연 6초 초과), `dwell_cancelled`(체류 미달 전환 고지), `leader_cancelled`(취소된 고지에 딸린 묘사), `emit_failed`(발행 오류), `stopped`(세션을 멈출 때 남았거나 멈춘 뒤 도착). 사유 없이 끝내 재생되지 않은 캡션은 `not_played`(정상이면 없다)
  - `droppedList[].factoryReason`: `stopped` 를 공장이 영상 끝 기준으로 나눈 것 — `after_end`(삽입 자리가 영상 끝 뒤이거나 배수를 다 마친 뒤 도착), `drain_timeout`(배수 상한에 닿아 멈출 때 영상 안 자리였던 해설 — 더 기다렸으면 들렸을 것). 그 밖의 사유는 null
  - 이전 공장 사유와의 대응: `excess_delay` → `delay_exceeded`, `no_audio` → `tts_failed`, `after_end`·`drain_timeout` → `stopped` + `factoryReason`
  - `stats.serviceMap`: 서비스별 `{ count, errorCount, p50Ms, p95Ms, maxMs }`. 서비스는 `vlm`·`ocr`·`judge`·`asr`·`tts`·`embed`·`bedrock`·`other`. `ocr` 은 슬라이드 전사 OCR 과 수치·척도 해설의 화면 글자 근거가 `/ocr` 로 보낸 호출이다 — 기본 OCR 주소는 임베딩과 같은 서버(origin)라 설정 `ocrUrl` 과 origin+경로가 같은 호출을 `ocr` 로 센다(그 밖은 `embed`·`other`). `judge` 는 GPU 판정 LLM 으로 간 호출(탐지 판정, 삽입 위치 추론)이다 — 기본 판정 주소(8805)가 VLM 과 달라 주소로 가르고, 같은 주소로 설정했으면 요청 몸통(메시지 content 가 문자열)으로 갈라 `vlm` 에 섞지 않는다. 판정 백엔드가 bedrock 이면 판정은 `bedrock`·`stats.bedrockModelMap` 에 든다
  - `stats.tts`: `{ requestCount, okCount, failCount, pendingAtStopCount, onDemandCount, unplayedOkCount }` — 해설 소리 합성(`pipeline-tts`) 수. 재생 차례가 가까운 해설만 합성하므로 해설 수보다 적을 수 있다. `requestCount` = `okCount` + `failCount` + `pendingAtStopCount`. `pendingAtStopCount` 는 세션을 멈출 때 응답이 없었거나 정지 정리 중 시작된 합성이다(제품도 정지 때 미리 만들기 자리를 넘겨 합성을 시작한다). 기록은 정지 순간에 확정하므로 그 뒤 늦게 온 응답은 반영하지 않는다. `onDemandCount` 는 차례가 온 뒤에야 합성한 수(무음이 생긴다), `unplayedOkCount` 는 합성했지만 재생 전에 버린 수
  - 서비스 호출(`stats.serviceMap`·경고)·판정·트리거 집계는 세션이 끝난 순간 값이다. 배수 상한에서 멈출 때 진행 중이던 호출이 mp3 렌더 중에 끝나도 넣지 않는다
  - `stats.triggerAnalyzerCountMap`: main 트리거가 전사마다 쓴 분석기 수(`kiwi`·`english`). 한국어를 Kiwi 없이 대체 규칙으로 뽑으면 `rule` 이 생긴다(세션 전에 Kiwi 준비를 기다리므로 정상이면 없다)
  - `stats.judgeSourceCountMap`: 탐지 판정기(`router`·`silence`·`deixis`)마다 판정 호출을 답한 곳별로 센 수 `{ gpu, bedrock, error }` — 판정 백엔드 하나만 쓰므로 gpu 백엔드면 `gpu`·`error`, bedrock 백엔드면 `bedrock`·`error` 에만 수가 생긴다(`error` = 판정 호출 실패). `router` 는 판단 LLM 이 묶음(지시 대상·발화 기반)마다 부른 호출을 합친 수라 판단 한 번에 1~2건이다. 제품 d65ce24 부터 `router` 의 단위가 판단 수에서 판정 LLM 호출 수로 바뀌어 그 전 결과(서브모듈 161ebfe 까지)와 직접 견주지 않는다. 삽입 위치 추론도 GPU 판정 LLM 을 부르지만 여기 넣지 않는다 — 그 호출은 `stats.serviceMap.judge` 에, 결과는 AD 의 `gap.source`(gpu·fallback)에 남는다
  - `stats.slideText`: 슬라이드 전사(새 슬라이드마다 한 번) 요약 `{ count, statusCountMap, sourceCountMap: { ocr, vlm }, fallbackReasonCountMap: { low_score, vertical_text, ocr_error, ocr_bypass } }` — 제품 기록(value_check '슬라이드 텍스트 전사 …')에서 센다. `sourceCountMap` 은 실제로 전사한 엔진이라 OCR 에서 VLM 으로 넘긴 장은 `vlm` 이고, 넘긴 이유는 `fallbackReasonCountMap`(저신뢰·세로 글씨·OCR 오류·60초 OCR 우회)에 든다. 값 검사 재전사(늘 VLM)는 세지 않는다. 세션이 끝난 순간까지 끝난 전사만 세므로, 배수 상한에 닿아 멈춘 영상(`drain_timeout`)은 끝 무렵 진행 중이던 장의 전사가 빠질 수 있다(그 장의 OCR 호출은 `serviceMap.ocr` 에 들어 있을 수 있다). 실패한 전사(failed)는 제품이 출처를 넘기지 않아 `statusCountMap` 에만 든다
  - `stats.swallowedErrorCountMap`: 연결 코드가 제품처럼 삼킨 오류 수 `{ task: { <작업 이름>: 수 }, ipc: { <채널>: 수 } }`. 비어 있어야 정상이고, 수가 있으면 공장 연결 코드 버그를 의심한다(경고 `swallowed_error`)
  - `stats.frame`: `sourceError`(프레임 읽기 오류, 없으면 null), `captureCount`(판정용 JPEG 캡처 수), `captureFailCount`(실패 수 — 1 이상이면 불완전), `captureFallbackCount`(영상 stream 이 오디오보다 먼저 끝나 마지막 프레임 시각으로 다시 뜬 수)
  - `session`: 영상 끝 뒤 배수 정보
    - `drainLimitMs`: 배수 상한(영상 끝 뒤 ms) = 모드 지연 10초 + 대기 줄 TTL 8초 + 15초 = 33000. 해설이 재생 중이면 그 해설 끝 + 1초까지 늘린다(실험실 규칙). 남은 일이 없으면 그 전에 멈춘다
    - `drainEndAfterVideoMs`: 실제로 멈춘 시각(영상 끝 뒤 ms)
    - `isDrainTimedOut`: 상한에 닿아 멈췄는지
    - `appendedTailMs`: 상한에서 지연 재생이 영상 끝에 닿지 못해 1.0배속으로 붙인 원음 길이(이 구간에는 AD 판단이 없다). 보통 0
    - `remainingTaskCount`·`inFlightCallCount`: 멈춘 순간 남은 렌더러 작업 수·진행 중 외부 호출 수. 상한에서 멈추면 생성 중이던 해설은 기록 없이 사라지므로 그 양을 센다(정상 배수면 0)
    - `recordFile`: 제품 기록 jsonl 경로, `endResult`: 제품 세션 종료 결과(`isOk`, `sessionId`, `asrCount`, `slideMarkCount`)
- `<영상>.log` — 파이프라인 콘솔 로그, `<영상>/` — pipeline-*.jsonl·context·AD wav·슬라이드 프레임과 공장 표식 `.seeon-factory-work`(다시 처리할 때 표식이 있으면 비운다)
- `manifest.json`·`summary.txt` — 이번 실행이 견준 seeon-meet·공장 버전과 결과 설정(`resultConfig`), 실행 설정(`runOptions`, 동시 수 포함), 영상별 성공/실패·경고(`warningList`), 중단 신호(`interruptedBy`)
  - 완료 영상은 manifest 에 서비스별 호출 수(`serviceCountMap`)·슬라이드 전사 요약(`slideText`)이 있고, summary 의 영상 줄 아래에 `      호출 asr 18 · vlm 15 · ocr 5 · … / 슬라이드 전사 ocr 3 · vlm 2(VLM 으로 넘김 low_score 2)` 한 줄을 더한다(0 인 서비스는 뺀다. 이 기록이 없는 이전 결과는 줄이 없다)
  - `--repeat N`(N > 1)이면 `runOptions.repeatCount` 가 생기고, `videoList` 와 summary 의 줄은 작업(영상 × 회차)마다 하나다. 같은 영상의 작업은 `videoId`·`videoOutStem`(`-r<k>` 를 붙이기 전 이름)이 같고 `repeatIndex`·`repeatCount` 로 회차를 가른다. 수(`counts`)도 작업 단위이고, summary 머리줄은 `작업 6(영상 2 × 반복 3) · 완료 …` 이다
- `repeat-summary.json` — `--repeat N`(N > 1) 실행이 끝날 때(중단돼도 끝난 회차까지) 쓰는 영상별 반복 요약. 지난 실행이 남긴 것은 이번 실행의 첫 기록 때 N 과 상관없이 지운다(실행 중이거나 `--repeat 1` 실행 뒤에는 없다). 요약을 만들지 못하면(결과 JSON 모양이 이상함 등) `[factory] 반복 요약을 만들지 못했다: …` 경고만 찍고 manifest·summary 는 그대로 쓴다. summary.txt 끝에도 영상마다 한 줄 `반복 3회(완료 3): AD 평균 2.3(2~3) · 늘 나온 AD 2 · 가끔 나온 AD 1` 을 더한다("늘" = 완료 회차 모두에 나온 묶음, "가끔" = 그보다 적게)
  - 머리: `repeatCount`, `matchToleranceMs`(2000), `startedAt`·`endedAt`·`interruptedBy`
  - 영상마다(`videoList[]`): `videoId`·`outStem`(붙이기 전 이름)·`filePath`, `runCount`(이번 실행의 N), `completedRunList`(완료 회차 k), `failedRunList`(`{ repeatIndex, reason }` — 실패·불완전·결과 JSON 을 읽지 못함·중단으로 띄우지 않음). 아래 수치는 완료 회차만으로 낸다
  - `adCount`: `{ countList(완료 회차 순), mean(소수 둘째 자리), min, max }`, `adCountByClass`: 분류마다 회차별 수 목록, `droppedReasonCountList`: 회차별 `{ 버린 사유: 수 }`
  - `clusterList`: 여러 회차의 AD 를 같은 AD 끼리 묶은 묶음(아래 규칙). 묶음마다 `type`, `hitRunCount` / `completedRunCount`(그 AD 가 나온 회차 수 / 완료 회차 수), `hitRunList`(나온 회차 k), `playedMediaMs`(`{ median, min, max }`), `textList`(서로 다른 문장 최대 3개 — 같은 AD 라도 회차마다 문장이 다를 수 있다). 재생 위치 중앙값 순이고 재생 위치가 없는 AD 의 묶음은 맨 뒤다
  - 묶음 규칙: 같은 AD 기준은 실험실 비교의 짝 기준과 같다(분류가 같고 재생 위치 `playedMediaMs` 가 ±2초 안, 경계 포함). 모든 회차의 AD 를 재생 위치 순(같으면 회차 → 분류 → 문장 → 회차 안 순서)으로 훑으며, 분류가 같고 묶음 첫 AD(가장 이른 AD)와 ±2초 안이고 그 회차의 AD 가 아직 없는 묶음 중 첫 AD 가 가장 가까운 것(같으면 먼저 생긴 것)에 넣고, 없으면 새 묶음을 연다. 그래서 같은 입력이면 늘 같은 결과이고, 한 회차의 AD 는 한 묶음에 최대 하나(한 회차 안의 가까운 같은 분류 AD 둘은 다른 묶음), 묶음 안 AD 끼리는 모두 ±2초 안이다(사슬처럼 늘어나지 않는다). 재생 위치가 없는 AD 는 홀로 묶음이 된다
- `.factory.lock` — 실행 중에만 있는 잠금 파일(위 "실행")

## 출력 검사·실험실 비교
- `node tools/verify-output.mjs out/<폴더>/<영상>_SEEON_AD.json` — mp3 길이가 공식(영상 길이 `video.durationMs` + AD + 무음 − 회수)과 1초 안에서 맞는지, 원음 조각이 영상 처음부터 끝까지(0~영상 길이) 빈틈·겹침 없이(1ms 허용) 이어지는지(`sourceCoverage`), AD 마다 mp3 의 그 자리(앞뒤 100ms 탐색)에 AD wav 가 실제로 들어 있는지(상관값·어긋남 ms) 본다. 결과를 JSON 으로 찍고 통과 0, 검사 어긋남 1, 실행 오류(사용법·JSON 읽기 실패·mp3 없음·ffmpeg/ffprobe 실패, 결과 JSON 은 찍지 않음) 2 로 끝난다. `video.durationMs` 가 없는 옛 기록은 실행 오류다.
- `node tools/compare-lab.mjs <공장 _SEEON_AD.json> <실험실 out/lab/<run>/ad-timeline.json>` — 실험실(experiment 브랜치)에서 같은 영상을 돌린 결과와 AD 를 짝짓는다(유형이 같고 재생 위치 `playedMediaMs` 가 ±2초 안이면 같은 AD). 짝·한쪽에만 있는 AD·버린 사유 수를 마크다운으로 stdout 에 낸다. 실험실 `outputMs` 는 앞 10초 무음을 포함하므로 쓰지 않는다. 비교는 `--concurrency 1` 결과로 하고.
- `node tools/compare-lab.mjs --factory <공장 _SEEON_AD.json>... --lab <실험실 ad-timeline.json>...` — 분포 비교. 한 번씩 돌린 결과의 짝짓기는 실행 편차가 지배하므로 공장은 `--repeat N` 으로, 실험실은 같은 영상을 여러 번 돌린 결과 폴더들로 견준다. 예: `node tools/compare-lab.mjs --factory out/rep/sample-5slides-r*_SEEON_AD.json --lab <실험실 out/lab>/*-sample-5slides/ad-timeline.json`
  - 쪽마다 실행들의 AD 를 반복 요약과 같은 묶음 규칙(위 `repeat-summary.json`)으로 묶고, 두 쪽 묶음을 분류가 같고 재생 위치 중앙값이 ±2초 안이면 짝짓는다(가까운 것부터, 묶음 하나는 한 번만 — 옛 형식의 AD 짝짓기와 같은 방법).
  - stdout 마크다운: 쪽별 실행 수·실행별 AD 수(평균), 묶음·짝·한쪽에만 있는 묶음 수, 묶음 표(유형, 공장 등장 k/N, 실험실 등장 k/N — 없는 쪽은 0/N, 쪽별 재생 위치 중앙값(최소~최대), 중앙값 차, 쪽별 문장 예시), 버린 사유별 실행별 수. 표는 재생 위치 순이다.
  - 서로 다른 영상의 파일을 섞으면 이유를 찍고 2 로 끝난다. 공장끼리는 `video.videoId`·`video.durationMs`, 실험실끼리는 ad-timeline.json 옆 `run.json` 의 `videoName`·`videoDurationMs`, 공장 ↔ 실험실은 실험실 영상 파일 이름(확장자 뺌)이 공장 videoId 나 공장 영상 파일 이름과 같은지와 길이를 본다. 길이는 ±1초까지 같은 영상으로 본다(공장은 ffprobe, 실험실은 재생기 길이라 조금 다를 수 있다).
  - 불완전한 결과(공장 `isComplete` 가 `true` 가 아님, 실험실 `run.json` 의 `isComplete: false`)는 빼고 stderr 에 경고한다. `run.json` 이 없는 실험실 결과는 영상 확인 없이 쓰고 경고한다 — 실험실은 `run.json` 을 맨 마지막에 쓰므로 파일만 옮긴 경우일 수도, 정리 중 멈춘 실행일 수도 있어 완료 여부도 모른다. 한쪽에 남는 결과가 없거나 파일을 읽지 못하면 2, 인자가 틀리면 사용법과 함께 2.
  - 분포에 넣는 공장 결과끼리 코드 버전(`seeonMeet`·`factory` 의 커밋·수정 지문 `dirtyHash`)이나 `config.resultConfig` 가 다르면 다른 곳과 파일을 적은 경고 한 줄을 stderr 에 찍는다(빼지는 않는다). **N 을 줄였거나 코드가 바뀐 `--out` 은 glob 대신 새 `--out` 을 쓴다** — 같은 `--out` 에 이전 버전의 `-r<k>` 가 남아 glob 이 함께 집는다.

## 테스트
`npm test` — 외부 서비스·네트워크 없이 돈다. 판정·TTS 등 GPU 서비스는 mock 이 대신하고(판정 LLM 도 따로 연 mock 주소, 슬라이드 전사 OCR 은 mock 임베딩 서버의 `/ocr`), 실서비스 포트(8801~8805)는 쓰지 않는다.
- 준비물: ffmpeg·ffprobe 5.1 이상, `npm --prefix seeon-meet ci --omit=dev`, `npm --prefix seeon-meet run setup:kiwi`(위 "준비", 한 번만). 제품 파이프라인을 세우는 시험이 Kiwi 를 띄우기 때문이다.
- `pretest` 가 먼저 제품 의존성(kiwi-nlp)과 Kiwi 모델을 한 번 점검해, 없으면 무엇이 없는지와 위 두 명령을 찍고 바로 멈춘다. Kiwi 가 없다고 시험을 건너뛰지 않는다 — 건너뛰면 제품의 한국어 트리거 경로를 시험하지 않은 채 통과한다. (`node --test` 로 직접 돌리면 pretest 가 없고, 그 시험들이 같은 설치 안내 문구로 실패한다.)
- 메모리: 시험 파일은 병렬로 돌아 Kiwi 를 동시에 최대 5개 띄울 수 있다(약 +4.3GB — 파이프라인 부팅·세션·제품 로더·영상 작업·e2e 워커 시험이 저마다 하나). 메모리가 작은 기계면 `npm run pretest && node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-concurrency=1 test/*.test.mjs` 로 돌린다.
